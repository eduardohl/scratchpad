"use client";

// The orchestrator: holds the game session, feeds what it hears to the listener at
// sensible moments, and decides when (and how loudly) Tablemate surfaces anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { admit, detectWake, PAUSE_MS, shouldCheck, windowTranscript } from "@/lib/gate";
import type { Delivery } from "@/lib/gate";
import type {
  AskMode,
  GameBrief,
  GameConfig,
  Intervention,
  ListenResult,
  Phase,
  Settings,
  TableState,
  Utterance,
} from "@/lib/types";
import { chime, speak, useSpeech } from "./useSpeech";

export interface FeedItem extends Intervention {
  delivery: Delivery;
  question?: string;
  streaming?: boolean;
  feedback?: "up" | "down";
}

export interface Session {
  config: GameConfig;
  brief: GameBrief;
  settings: Settings;
  state: TableState;
  utterances: Utterance[];
  /** Timestamp of the newest utterance the listener has already judged. */
  seenUpTo: number;
  feed: FeedItem[];
  /** Quiet tips held back from interrupting; one tap away. */
  tips: FeedItem[];
  recentTopics: Record<string, number>;
  lastUnsolicitedAt: number;
  dismissStreak: number;
  startedAt: number;
  recap?: string;
}

const STORAGE_KEY = "tablemate:session:v1";
const MAX_UTTERANCES = 400;
/** If the moment passes before the table pauses, demote the intervention to a quiet tip. */
const STALE_MS = 30_000;

export function newSession(config: GameConfig, brief: GameBrief, settings: Settings): Session {
  return {
    config,
    brief,
    settings,
    state: { phase: "setup", round: null, activePlayer: null, completedSetup: [], scores: {}, log: [] },
    utterances: [],
    seenUpTo: 0,
    feed: [],
    tips: [],
    recentTopics: {},
    lastUnsolicitedAt: 0,
    dismissStreak: 0,
    startedAt: Date.now(),
  };
}

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
      const now = Date.now();
      update((s) => ({
        ...s,
        feed: [...s.feed, item].slice(-50),
        lastUnsolicitedAt: item.direct ? s.lastUnsolicitedAt : now,
        recentTopics: item.topicKey ? { ...s.recentTopics, [item.topicKey]: now } : s.recentTopics,
      }));
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
      const s = sRef.current;
      const st = result.state;
      if (st.phase && st.phase !== s.state.phase) setPhaseNotice({ from: s.state.phase, to: st.phase });
      update((x) => ({
        ...x,
        state: {
          ...x.state,
          phase: st.phase ?? x.state.phase,
          round: st.round ?? x.state.round,
          activePlayer: st.activePlayer ?? x.state.activePlayer,
          completedSetup: Array.from(new Set([...x.state.completedSetup, ...st.completedSetupStepIds])),
          log: [...x.state.log, ...st.logEntries].slice(-100),
        },
      }));

      const iv = result.intervention;
      if (!iv.speak) {
        setActivity({ kind: "decided", text: "Stayed quiet", at: Date.now() });
        return;
      }
      const item: FeedItem = { ...iv, id: uid(), at: Date.now(), delivery: "drop" };
      const decision = admit(item, {
        presence: s.settings.presence,
        voice: s.settings.voice,
        phase: st.phase ?? s.state.phase,
        now: Date.now(),
        lastUnsolicitedAt: s.lastUnsolicitedAt,
        recentTopics: s.recentTopics,
        dismissStreak: s.dismissStreak,
      });
      item.delivery = decision.delivery;
      setActivity({ kind: "decided", text: `Had a thought (${decision.delivery}): ${decision.why}`, at: Date.now() });

      if (decision.delivery === "badge") {
        update((x) => ({
          ...x,
          tips: [...x.tips, item].slice(-20),
          recentTopics: item.topicKey ? { ...x.recentTopics, [item.topicKey]: Date.now() } : x.recentTopics,
        }));
      } else if (decision.delivery !== "drop") {
        const queued = pendingRef.current;
        const rank = { low: 0, normal: 1, high: 2 } as const;
        if (!queued || rank[item.urgency] >= rank[queued.urgency]) pendingRef.current = item;
      }
    },
    [update],
  );

  const check = useCallback(
    async (reason: string) => {
      const s = sRef.current;
      const { earlier, recent } = windowTranscript(s.utterances, s.seenUpTo);
      if (recent.length === 0) return;
      inFlightRef.current = true;
      lastCheckAtRef.current = Date.now();
      const seenUpTo = recent[recent.length - 1].at;
      update((x) => ({ ...x, seenUpTo: Math.max(x.seenUpTo, seenUpTo) }));
      setActivity({ kind: "checking", reason });
      const now = Date.now();
      try {
        const res = await fetch("/api/listen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: s.config,
            brief: s.brief,
            state: s.state,
            presence: s.settings.presence,
            earlier,
            recent: recent.slice(-80),
            recentTopics: Object.entries(s.recentTopics)
              .filter(([, at]) => now - at < 10 * 60_000)
              .map(([k]) => k),
            reason,
          }),
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
      const lastSpeechAt = Math.max(speech.lastSpeechAtRef.current, s.utterances.at(-1)?.at ?? 0);
      const talking = interimRef.current !== "" || now - lastSpeechAt < PAUSE_MS || mutedRef.current;

      // Deliver a queued intervention only into a lull in the conversation.
      const pending = pendingRef.current;
      if (pending) {
        if (now - pending.at > STALE_MS) {
          pendingRef.current = null;
          update((x) => ({ ...x, tips: [...x.tips, { ...pending, delivery: "badge" as const }].slice(-20) }));
        } else if (!talking) {
          pendingRef.current = null;
          surface(pending);
        }
      }

      if (inFlightRef.current) return;
      const { recent } = windowTranscript(s.utterances, s.seenUpTo);
      const decision = shouldCheck({
        pending: recent.filter((u) => !u.addressed),
        lastCheckAt: lastCheckAtRef.current,
        lastSpeechAt,
        speaking: interimRef.current !== "",
        now,
        phase: s.state.phase,
        presence: s.settings.presence,
      });
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
