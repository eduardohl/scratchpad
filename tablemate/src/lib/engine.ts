// The companion's decision loop as pure functions over a Session.
// The React hook (useTable) and the eval harness (evals/run.ts) both drive these, so
// what the evals measure is exactly what runs at the table.

import { admit, PAUSE_MS, shouldCheck, windowTranscript } from "./gate";
import type { AdmitDecision, CheckDecision } from "./gate";
import type { FeedItem, Session } from "./session";
import type { ListenRequest, ListenResult, Phase, TableState } from "./types";

/** If the moment passes before the table pauses, demote the intervention to a quiet tip. */
export const STALE_MS = 30_000;
/** How long a raised topic is remembered for de-duplication. */
export const TOPIC_WINDOW_MS = 10 * 60_000;

export interface Clock {
  now: number;
  lastCheckAt: number;
  /** Most recent moment anyone was heard speaking (final or interim). */
  lastSpeechAt: number;
  /** Interim (unfinished) speech is arriving right now. */
  speaking: boolean;
}

export function isTalking(clock: Clock): boolean {
  return clock.speaking || clock.now - clock.lastSpeechAt < PAUSE_MS;
}

/** Should the listener look at what's been said since its last look? */
export function nextCheck(s: Session, clock: Clock): CheckDecision {
  const { recent } = windowTranscript(s.utterances, s.seenUpTo);
  return shouldCheck({
    // Direct questions are answered by /api/ask; don't make the listener re-answer them.
    pending: recent.filter((u) => !u.addressed),
    lastCheckAt: clock.lastCheckAt,
    lastSpeechAt: clock.lastSpeechAt,
    speaking: clock.speaking,
    now: clock.now,
    phase: s.state.phase,
    presence: s.settings.presence,
    watchWords: s.brief.watchWords,
  });
}

/** Build the listener request and the new `seenUpTo` mark (null if there's nothing new). */
export function buildListenRequest(
  s: Session,
  reason: string,
  now: number,
): { request: ListenRequest; seenUpTo: number } | null {
  const { earlier, recent } = windowTranscript(s.utterances, s.seenUpTo);
  if (recent.length === 0) return null;
  return {
    seenUpTo: recent[recent.length - 1].at,
    request: {
      config: s.config,
      brief: s.brief,
      state: s.state,
      presence: s.settings.presence,
      earlier,
      recent: recent.slice(-80),
      recentTopics: Object.entries(s.recentTopics)
        .filter(([, at]) => now - at < TOPIC_WINDOW_MS)
        .map(([k]) => k),
      reason,
    },
  };
}

export function mergeListenState(state: TableState, st: ListenResult["state"]): TableState {
  return {
    ...state,
    phase: st.phase ?? state.phase,
    round: st.round ?? state.round,
    activePlayer: st.activePlayer ?? state.activePlayer,
    completedSetup: Array.from(new Set([...state.completedSetup, ...st.completedSetupStepIds])),
    log: [...state.log, ...st.logEntries].slice(-100),
  };
}

export interface Proposal {
  item: FeedItem | null;
  decision: AdmitDecision | null;
  phaseChange: { from: Phase; to: Phase } | null;
  session: Session;
}

/**
 * Fold a listener result into the session: update table state, and if the listener wants
 * to speak, decide how loudly. Badged items are filed immediately; card/voice items are
 * returned for the caller to queue until the table pauses.
 */
export function applyListenResult(s: Session, result: ListenResult, now: number, id: string): Proposal {
  const st = result.state;
  const phaseChange = st.phase && st.phase !== s.state.phase ? { from: s.state.phase, to: st.phase } : null;
  let session: Session = { ...s, state: mergeListenState(s.state, st) };

  const iv = result.intervention;
  if (!iv.speak) return { item: null, decision: null, phaseChange, session };

  const item: FeedItem = { ...iv, id, at: now, delivery: "drop" };
  const decision = admit(item, {
    presence: s.settings.presence,
    voice: s.settings.voice,
    phase: session.state.phase,
    now,
    lastUnsolicitedAt: s.lastUnsolicitedAt,
    recentTopics: s.recentTopics,
    dismissStreak: s.dismissStreak,
  });
  item.delivery = decision.delivery;

  if (decision.delivery === "badge") session = recordTip(session, item, now);
  return { item: decision.delivery === "drop" || decision.delivery === "badge" ? null : item, decision, phaseChange, session };
}

const RANK = { low: 0, normal: 1, high: 2 } as const;

/** Only one intervention waits for a pause at a time; a more urgent one replaces it. */
export function queueIntervention(queued: FeedItem | null, item: FeedItem): FeedItem {
  return !queued || RANK[item.urgency] >= RANK[queued.urgency] ? item : queued;
}

export function deliveryStep(pending: FeedItem | null, clock: Clock): "none" | "wait" | "deliver" | "stale" {
  if (!pending) return "none";
  if (clock.now - pending.at > STALE_MS) return "stale";
  return isTalking(clock) ? "wait" : "deliver";
}

export function recordSurfaced(s: Session, item: FeedItem, now: number): Session {
  return {
    ...s,
    feed: [...s.feed, item].slice(-50),
    lastUnsolicitedAt: item.direct ? s.lastUnsolicitedAt : now,
    recentTopics: item.topicKey ? { ...s.recentTopics, [item.topicKey]: now } : s.recentTopics,
  };
}

export function recordTip(s: Session, item: FeedItem, now: number): Session {
  return {
    ...s,
    tips: [...s.tips, { ...item, delivery: "badge" as const }].slice(-20),
    recentTopics: item.topicKey ? { ...s.recentTopics, [item.topicKey]: now } : s.recentTopics,
  };
}
