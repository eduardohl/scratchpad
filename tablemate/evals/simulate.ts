// Replays a table script through the real decision engine on a simulated clock.
// Only the listener call is pluggable (real Claude, or a stub for dry runs).

import {
  applyListenResult,
  buildListenRequest,
  deliveryStep,
  isTalking,
  nextCheck,
  queueIntervention,
  recordSurfaced,
  recordTip,
} from "../src/lib/engine";
import type { Clock } from "../src/lib/engine";
import { detectWake } from "../src/lib/gate";
import { newSession } from "../src/lib/session";
import type { FeedItem, Session } from "../src/lib/session";
import type { GameBrief, ListenRequest, ListenResult, RulebookRef } from "../src/lib/types";
import type { CallUsage } from "../src/lib/claude";
import { timeline } from "./script";
import type { Script } from "./script";

export type Listener = (req: ListenRequest) => Promise<{ result: ListenResult; usage: CallUsage }>;

export interface SimOptions {
  /** Pass speaker names to the listener (as cloud STT with diarization would). */
  speakers: boolean;
  /** Simulated listener latency. */
  latencyMs: number;
  /** Silence simulated after the last line so pending interventions can land. */
  tailMs: number;
  tickMs: number;
}

export const DEFAULT_SIM: SimOptions = { speakers: true, latencyMs: 2500, tailMs: 60_000, tickMs: 500 };

export type SimEvent =
  | { type: "check"; at: number; reason: string; usage: CallUsage }
  | { type: "surfaced"; at: number; item: FeedItem }
  | { type: "badge"; at: number; item: FeedItem; why: string }
  | { type: "dropped"; at: number; item: FeedItem; why: string }
  | { type: "stale"; at: number; item: FeedItem };

export interface SimResult {
  scriptId: string;
  events: SimEvent[];
  /** Seconds of conversation in the script (excludes the silent tail). */
  duration: number;
  finalState: Session["state"];
}

const EPOCH = 1_700_000_000_000;
const WAKE_WORDS = ["tablemate", "table mate", "hey table"];

export async function simulate(script: Script, brief: GameBrief, listener: Listener, opts: SimOptions = DEFAULT_SIM): Promise<SimResult> {
  const { lines, duration } = timeline(script);
  const rulebook: RulebookRef = script.rulebook
    ? { kind: "text", text: script.rulebook, name: `${script.game} rules (excerpt)` }
    : { kind: "none" };

  let s: Session = newSession(
    { gameName: script.game, players: script.players, experience: script.experience, rulebook, language: script.language },
    brief,
    { presence: script.presence, voice: true, wakeWords: WAKE_WORDS },
    { startedAt: EPOCH },
  );
  s = { ...s, state: { ...s.state, phase: script.phase } };

  const events: SimEvent[] = [];
  const ms = (sec: number) => EPOCH + Math.round(sec * 1000);
  let heard = 0;
  let lastCheckAt = 0;
  let pending: FeedItem | null = null;
  let inFlight: { doneAt: number; result: ListenResult } | null = null;
  let ids = 0;

  const end = ms(duration) + opts.tailMs;
  for (let now = EPOCH; now <= end; now += opts.tickMs) {
    // Lines that have finished by now become final transcript.
    while (heard < lines.length && ms(lines[heard].end) <= now) {
      const l = lines[heard++];
      const wake = detectWake(l.text, WAKE_WORDS);
      s = {
        ...s,
        utterances: [
          ...s.utterances,
          {
            id: `u${l.index}`,
            text: l.text,
            at: ms(l.end),
            speaker: opts.speakers ? l.who : undefined,
            addressed: wake.addressed || undefined,
          },
        ],
      };
    }
    const speaking = lines.some((l) => ms(l.start) <= now && now < ms(l.end));
    const lastSpeechAt = heard > 0 ? ms(lines[heard - 1].end) : 0;
    const clock: Clock = { now, lastCheckAt, lastSpeechAt: speaking ? now : lastSpeechAt, speaking };

    if (inFlight && now >= inFlight.doneAt) {
      const p = applyListenResult(s, inFlight.result, now, `i${ids++}`);
      s = p.session;
      if (p.decision && p.item) pending = queueIntervention(pending, p.item);
      else if (p.decision) {
        const item = { ...inFlight.result.intervention, id: `i${ids}`, at: now, delivery: p.decision.delivery } as FeedItem;
        events.push({ type: p.decision.delivery === "badge" ? "badge" : "dropped", at: now, item, why: p.decision.why });
      }
      inFlight = null;
    }

    const step = deliveryStep(pending, clock);
    if (step === "deliver" && pending) {
      s = recordSurfaced(s, pending, now);
      events.push({ type: "surfaced", at: now, item: pending });
      pending = null;
    } else if (step === "stale" && pending) {
      s = recordTip(s, pending, now);
      events.push({ type: "stale", at: now, item: pending });
      pending = null;
    }

    if (inFlight || isTalking(clock)) continue;
    const decision = nextCheck(s, clock);
    if (!decision.check) continue;
    const built = buildListenRequest(s, decision.reason, now);
    if (!built) continue;
    s = { ...s, seenUpTo: Math.max(s.seenUpTo, built.seenUpTo) };
    lastCheckAt = now;
    const { result, usage } = await listener(built.request);
    events.push({ type: "check", at: now, reason: decision.reason, usage });
    inFlight = { doneAt: now + opts.latencyMs, result };
  }

  return { scriptId: script.id, events, duration, finalState: s.state };
}

/** Seconds from script start, for reports. */
export function secondsOf(at: number): number {
  return Math.round((at - EPOCH) / 100) / 10;
}
