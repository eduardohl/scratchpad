// The etiquette layer. Pure functions, no I/O, so they're easy to test and tune.
//
// Two questions decide whether Tablemate ever makes a sound:
//   1. shouldCheck — is it worth asking the model about the last stretch of talk?
//   2. admit       — the model wants to say something; is now the right time, and how loud?
// Both lean hard toward silence. A missed tip costs little; an unwanted interruption
// costs the table's trust.

import type { Intervention, Phase, Presence, Utterance } from "./types";

// ---------------------------------------------------------------------------
// Cue detection
// ---------------------------------------------------------------------------

/** Phrases that suggest the table is unsure about a rule. Speech recognition gives no punctuation. */
const RULE_QUESTION_CUES = [
  "how does",
  "how do",
  "how many",
  "how much",
  "what happens",
  "what if",
  "can i",
  "can you",
  "can we",
  "am i allowed",
  "are we allowed",
  "are you allowed",
  "is that legal",
  "is that allowed",
  "is it legal",
  "do we",
  "do i",
  "does it",
  "does that",
  "is it",
  "what's the rule",
  "what is the rule",
  "rule says",
  "rulebook",
  "rule book",
  "i don't remember",
  "i forget",
  "i forgot",
  "not sure",
  "no idea",
  "wait wait",
  "hold on",
  "where does",
  "where do",
  "which one",
  "who goes",
  "whose turn",
  "who's first",
  "who starts",
  "let me check",
  "look it up",
  "i thought you",
  "i thought we",
  "you can't",
  "you're not allowed",
  "that's not how",
];

const PHASE_CUES: Record<Phase, string[]> = {
  setup: ["set up", "setup", "set it up", "shuffle", "deal", "each player gets", "starting hand"],
  teach: ["explain", "teach", "how do you play", "how to play", "the goal is", "how do you win"],
  play: [
    "let's start",
    "let's play",
    "let's go",
    "ready to play",
    "first player",
    "your turn",
    "my turn",
    "next round",
    "end of round",
    "new round",
  ],
  wrapup: [
    "game over",
    "game's over",
    "last round",
    "final round",
    "final turn",
    "last turn",
    "count up",
    "count the points",
    "count points",
    "final score",
    "who won",
    "scoring",
  ],
};

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()} `;
}

function containsPhrase(normalized: string, phrase: string): boolean {
  return normalized.includes(` ${phrase} `);
}

export interface WakeMatch {
  addressed: boolean;
  /** The utterance with the wake word stripped off. */
  rest: string;
}

/** Did someone address Tablemate by name? ("hey tablemate, can I trade twice?") */
export function detectWake(text: string, wakeWords: string[]): WakeMatch {
  const n = normalize(text);
  for (const w of wakeWords) {
    const word = w.toLowerCase().trim();
    if (!word) continue;
    const idx = n.indexOf(` ${word} `);
    if (idx === -1) continue;
    const before = n.slice(0, idx).trim();
    const after = n.slice(idx + word.length + 2).trim();
    // "hey tablemate X" / "tablemate X" / "X, tablemate?" all count. Mentions in the
    // middle of a long sentence ("I read about tablemate apps") do not.
    const leading = before === "" || /^(hey|ok|okay|hi|yo|so|um|uh)$/.test(before);
    const trailing = after === "" && before.split(" ").length <= 14;
    if (leading || trailing) {
      return { addressed: true, rest: (leading ? after : before).trim() };
    }
  }
  return { addressed: false, rest: text };
}

export type Cue = "rule-question" | "phase-change";

export function detectCues(text: string): Cue[] {
  const n = normalize(text);
  const cues: Cue[] = [];
  if (RULE_QUESTION_CUES.some((c) => containsPhrase(n, c))) cues.push("rule-question");
  if (Object.values(PHASE_CUES).some((list) => list.some((c) => containsPhrase(n, c)))) {
    cues.push("phase-change");
  }
  return cues;
}

// ---------------------------------------------------------------------------
// shouldCheck: when to spend a model call
// ---------------------------------------------------------------------------

/** How long the table must be quiet before Tablemate considers speaking or checking. */
export const PAUSE_MS = 1300;

/** Background sweep cadence: how often to glance at ordinary chatter with no cues in it. */
const SWEEP_MS: Record<Presence, Record<Phase, number>> = {
  quiet: { setup: 90_000, teach: 120_000, play: 150_000, wrapup: 90_000 },
  balanced: { setup: 30_000, teach: 60_000, play: 60_000, wrapup: 40_000 },
  guide: { setup: 20_000, teach: 30_000, play: 30_000, wrapup: 25_000 },
};

/** Never call the listener more often than this, whatever the cues say. */
export const MIN_CHECK_GAP_MS = 6_000;

export interface CheckContext {
  pending: Utterance[];
  lastCheckAt: number;
  lastSpeechAt: number;
  speaking: boolean; // someone is mid-sentence (interim results arriving)
  now: number;
  phase: Phase;
  presence: Presence;
}

export interface CheckDecision {
  check: boolean;
  reason: string;
}

export function shouldCheck(ctx: CheckContext): CheckDecision {
  const { pending, now } = ctx;
  if (pending.length === 0) return { check: false, reason: "nothing new" };
  if (ctx.speaking || now - ctx.lastSpeechAt < PAUSE_MS) return { check: false, reason: "table is talking" };
  if (now - ctx.lastCheckAt < MIN_CHECK_GAP_MS) return { check: false, reason: "checked moments ago" };

  const cues = new Set(pending.flatMap((u) => detectCues(u.text)));
  if (cues.has("rule-question")) return { check: true, reason: "someone sounds unsure about a rule" };
  if (cues.has("phase-change")) return { check: true, reason: "the table may be changing phase" };
  if (pending.some((u) => u.typed)) return { check: true, reason: "a note was typed in" };

  const sweep = SWEEP_MS[ctx.presence][ctx.phase];
  if (now - ctx.lastCheckAt >= sweep && pending.length >= 2) {
    return { check: true, reason: "routine glance at recent play" };
  }
  if (pending.length >= 14) return { check: true, reason: "a lot has been said" };
  return { check: false, reason: "no cue yet" };
}

// ---------------------------------------------------------------------------
// admit: should a proposed intervention reach the table, and how?
// ---------------------------------------------------------------------------

export type Delivery = "voice" | "card" | "badge" | "drop";

export interface AdmitContext {
  presence: Presence;
  voice: boolean;
  phase: Phase;
  now: number;
  /** Last time an unsolicited intervention was shown as a card or spoken. */
  lastUnsolicitedAt: number;
  /** topicKey -> last time it was surfaced. */
  recentTopics: Record<string, number>;
  /** Consecutive interventions the table dismissed as unhelpful. */
  dismissStreak: number;
}

export interface AdmitDecision {
  delivery: Delivery;
  why: string;
}

const BASE_THRESHOLD: Record<Presence, number> = { quiet: 0.85, balanced: 0.7, guide: 0.55 };
const COOLDOWN_MS: Record<Presence, number> = { quiet: 180_000, balanced: 60_000, guide: 20_000 };
const TOPIC_MEMORY_MS = 10 * 60_000;

/** Which unsolicited kinds each presence level permits at all. */
const ALLOWED: Record<Presence, Set<Intervention["kind"]>> = {
  quiet: new Set(["answer", "correction"]),
  balanced: new Set(["answer", "correction", "reminder", "phase", "teach"]),
  guide: new Set(["answer", "correction", "reminder", "phase", "teach", "tip"]),
};

export function confidenceThreshold(presence: Presence, dismissStreak: number): number {
  return Math.min(0.95, BASE_THRESHOLD[presence] + 0.05 * Math.min(dismissStreak, 4));
}

export function admit(iv: Intervention, ctx: AdmitContext): AdmitDecision {
  // Asked directly: always answer, out loud if voice is on.
  if (iv.direct) return { delivery: ctx.voice ? "voice" : "card", why: "asked directly" };

  if (!iv.message.trim()) return { delivery: "drop", why: "empty message" };

  const seen = ctx.recentTopics[iv.topicKey];
  if (seen !== undefined && ctx.now - seen < TOPIC_MEMORY_MS) {
    return { delivery: "drop", why: "already raised this" };
  }

  if (!ALLOWED[ctx.presence].has(iv.kind)) {
    // Not loud enough for this table, but keep it one tap away.
    return { delivery: "badge", why: `${iv.kind} is off at this presence level` };
  }
  if (ctx.presence === "quiet" && iv.kind === "correction" && iv.urgency !== "high") {
    return { delivery: "badge", why: "quiet mode only interrupts for high-stakes corrections" };
  }

  if (iv.confidence < confidenceThreshold(ctx.presence, ctx.dismissStreak)) {
    return iv.confidence >= 0.5
      ? { delivery: "badge", why: "not confident enough to interrupt" }
      : { delivery: "drop", why: "too unsure" };
  }

  if (iv.urgency === "low" && ctx.presence !== "guide") {
    return { delivery: "badge", why: "low urgency" };
  }

  const cooling = ctx.now - ctx.lastUnsolicitedAt < COOLDOWN_MS[ctx.presence];
  if (cooling && iv.urgency !== "high") return { delivery: "badge", why: "spoke recently" };

  // Unsolicited speech is reserved for things that change the game's outcome.
  const loud = ctx.voice && iv.urgency === "high";
  return { delivery: loud ? "voice" : "card", why: "worth a gentle interruption" };
}

/** Split the transcript into what the listener has already seen and what's new. */
export function windowTranscript(
  all: Utterance[],
  seenUpTo: number,
  maxEarlier = 30,
): { earlier: Utterance[]; recent: Utterance[] } {
  const recent = all.filter((u) => u.at > seenUpTo);
  const earlier = all.filter((u) => u.at <= seenUpTo).slice(-maxEarlier);
  return { earlier, recent };
}
