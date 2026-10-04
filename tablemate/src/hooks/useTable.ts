"use client";

// The orchestrator: holds the game session, feeds what it hears to the listener at
// sensible moments, and decides when (and how loudly) Tablemate surfaces anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { detectWake } from "@/lib/gate";
import {
  applyListenResult,
  buildListenRequest,
  deliveryStep,
  isTalking,
  nextCheck,
  queueIntervention,
  recordSurfaced,
  recordTip,
} from "@/lib/engine";
import type { Clock } from "@/lib/engine";
import type { FeedItem, Session } from "@/lib/session";
import type { AskMode, ListenResult, Phase, Settings, Utterance } from "@/lib/types";
import { chime, speak, useSpeech } from "./useSpeech";

export type { FeedItem, Session } from "@/lib/session";
export { newSession } from "@/lib/session";

const STORAGE_KEY = "tablemate:session:v1";
const MAX_UTTERANCES = 400;

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);

export type Activity =
  | { kind: "idle" }
  | { kind: "checking"; reason: string }
  | { kind: "answering" }
  | { kind: "decided"; text: string; at: number };

export function useTable(initial: Session) {
  const [session, setSession] = useState<Session>(initial);
  const [activity, setActivity] = useState<Activity>({ kind: "idle" });
  const [phaseNotice, setPhaseNotice] = useState<{ from: Phase; to: Phase } | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const sRef = useRef(session);
  sRef.current = session;
  const mutedRef = useRef(false);
  const inFlightRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const pendingRef = useRef<FeedItem | null>(null);

  // Persist so a refresh or a locked phone doesn't lose the game.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } catch {
        // storage full or blocked; the game still works
      }
    }, 400);
    return () => clearTimeout(t);
  }, [session]);

  const update = useCallback((fn: (s: Session) => Session) => setSession((s) => fn(s)), []);

  // ---- speaking ------------------------------------------------------------

  const say = useCallback(async (text: string) => {
    mutedRef.current = true;
    await speak(text);
    // Let the room tail off before we start transcribing again.
    setTimeout(() => (mutedRef.current = false), 400);
  }, []);

  const surface = useCallback(
    (item: FeedItem) => {
      update((s) => recordSurfaced(s, item, Date.now()));
      if (item.delivery === "voice") void say(item.message);
      else chime();
    },
    [say, update],
  );

  // ---- direct questions ----------------------------------------------------

  const ask = useCallback(
    async (question: string, mode: AskMode = "question") => {
      const s = sRef.current;
      const id = uid();
      const placeholder: FeedItem = {
        id,
        kind: "answer",
        urgency: "normal",
        confidence: 1,
        message: "",
        topicKey: "",
        at: Date.now(),
        direct: true,
        delivery: s.settings.voice ? "voice" : "card",
        question: mode === "recap" ? undefined : question || "(you called me)",
        streaming: true,
      };
      if (mode === "question") update((x) => ({ ...x, feed: [...x.feed, placeholder].slice(-50) }));
      setActivity({ kind: "answering" });

      const patch = (fn: (item: FeedItem) => FeedItem) =>
        update((x) => ({ ...x, feed: x.feed.map((f) => (f.id === id ? fn(f) : f)) }));

      let text = "";
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: s.config,
            brief: s.brief,
            state: s.state,
            mode,
            question: question || "Someone called your name. Briefly ask what they need, or answer if the recent conversation makes it obvious.",
            recent: s.utterances.slice(-25),
          }),
        });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Request failed");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (mode === "recap") update((x) => ({ ...x, recap: text }));
          else patch((f) => ({ ...f, message: text }));
        }
        setApiError(null);
      } catch (err) {
        text = text || "Sorry, I couldn't reach my rulebook just now.";
        setApiError(err instanceof Error ? err.message : String(err));
      }
      if (mode === "question") {
        patch((f) => ({ ...f, message: text, streaming: false }));
        if (sRef.current.settings.voice) void say(text);
      } else {
        update((x) => ({ ...x, recap: text }));
      }
      setActivity({ kind: "idle" });
    },
    [say, update],
  );

  // ---- hearing -------------------------------------------------------------

  const hear = useCallback(
    (text: string, typed = false) => {
      // Anything typed into the ask bar is addressed to Tablemate by definition.
      const wake = typed ? { addressed: true, rest: text } : detectWake(text, sRef.current.settings.wakeWords);
      const utterance: Utterance = { id: uid(), text, at: Date.now(), typed, addressed: wake.addressed || undefined };
      update((s) => ({ ...s, utterances: [...s.utterances, utterance].slice(-MAX_UTTERANCES) }));
      if (wake.addressed) void ask(wake.rest);
    },
    [ask, update],
  );

  const speech = useSpeech({ onFinal: (t) => hear(t), mutedRef });
  const interimRef = useRef("");
  interimRef.current = speech.interim;

  // ---- the listener loop -----------------------------------------------------

  const applyListen = useCallback(
    (result: ListenResult) => {
      const now = Date.now();
      const p = applyListenResult(sRef.current, result, now, uid());
      sRef.current = p.session;
      setSession(p.session);
      if (p.phaseChange) setPhaseNotice(p.phaseChange);
      if (p.item) pendingRef.current = queueIntervention(pendingRef.current, p.item);
      setActivity({
        kind: "decided",
        text: p.decision ? `Had a thought (${p.decision.delivery}): ${p.decision.why}` : "Stayed quiet",
        at: now,
      });
    },
    [],
  );

  const check = useCallback(
    async (reason: string) => {
      const now = Date.now();
      const built = buildListenRequest(sRef.current, reason, now);
      if (!built) return;
      inFlightRef.current = true;
      lastCheckAtRef.current = now;
      update((x) => ({ ...x, seenUpTo: Math.max(x.seenUpTo, built.seenUpTo) }));
      setActivity({ kind: "checking", reason });
      try {
        const res = await fetch("/api/listen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(built.request),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Listen failed");
        applyListen(body as ListenResult);
        setApiError(null);
      } catch (err) {
        setApiError(err instanceof Error ? err.message : String(err));
        setActivity({ kind: "idle" });
      } finally {
        inFlightRef.current = false;
      }
    },
    [applyListen, update],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const s = sRef.current;
      const now = Date.now();
      const clock: Clock = {
        now,
        lastCheckAt: lastCheckAtRef.current,
        lastSpeechAt: Math.max(speech.lastSpeechAtRef.current, s.utterances.at(-1)?.at ?? 0),
        speaking: interimRef.current !== "" || mutedRef.current,
      };

      // Deliver a queued intervention only into a lull in the conversation.
      const pending = pendingRef.current;
      switch (deliveryStep(pending, clock)) {
        case "stale":
          pendingRef.current = null;
          update((x) => recordTip(x, pending!, now));
          break;
        case "deliver":
          pendingRef.current = null;
          surface(pending!);
          break;
      }

      if (inFlightRef.current || isTalking(clock)) return;
      const decision = nextCheck(s, clock);
      if (decision.check) void check(decision.reason);
    }, 500);
    return () => clearInterval(timer);
  }, [check, surface, speech.lastSpeechAtRef, update]);

  // ---- manual controls -------------------------------------------------------

  const actions = {
    hear,
    ask,
    recap: () => ask("", "recap"),
    setPhase: (phase: Phase) => {
      setPhaseNotice(null);
      update((s) => ({ ...s, state: { ...s.state, phase } }));
    },
    undoPhase: () => {
      if (!phaseNotice) return;
      update((s) => ({ ...s, state: { ...s.state, phase: phaseNotice.from } }));
      setPhaseNotice(null);
    },
    dismissPhaseNotice: () => setPhaseNotice(null),
    toggleSetup: (id: string) =>
      update((s) => {
        const done = new Set(s.state.completedSetup);
        if (done.has(id)) done.delete(id);
        else done.add(id);
        return { ...s, state: { ...s.state, completedSetup: [...done] } };
      }),
    setRound: (round: number | null) => update((s) => ({ ...s, state: { ...s.state, round } })),
    setActivePlayer: (activePlayer: string | null) => update((s) => ({ ...s, state: { ...s.state, activePlayer } })),
    setScore: (player: string, category: string, value: number | null) =>
      update((s) => {
        const row = { ...(s.state.scores[player] ?? {}) };
        if (value === null || Number.isNaN(value)) delete row[category];
        else row[category] = value;
        return { ...s, state: { ...s.state, scores: { ...s.state.scores, [player]: row } } };
      }),
    feedback: (id: string, helpful: boolean) =>
      update((s) => ({
        ...s,
        dismissStreak: helpful ? 0 : s.dismissStreak + 1,
        feed: s.feed.map((f) => (f.id === id ? { ...f, feedback: helpful ? "up" : "down" } : f)),
      })),
    dismiss: (id: string) => update((s) => ({ ...s, feed: s.feed.filter((f) => f.id !== id) })),
    promoteTip: (id: string) =>
      update((s) => {
        const tip = s.tips.find((t) => t.id === id);
        if (!tip) return s;
        return { ...s, tips: s.tips.filter((t) => t.id !== id), feed: [...s.feed, { ...tip, delivery: "card" as const }] };
      }),
    clearTips: () => update((s) => ({ ...s, tips: [] })),
    setSettings: (patch: Partial<Settings>) => update((s) => ({ ...s, settings: { ...s.settings, ...patch } })),
    readAloud: (text: string) => void say(text),
  };

  return { session, activity, phaseNotice, apiError, speech, actions };
}
