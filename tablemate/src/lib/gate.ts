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
  // Brazilian Portuguese. Written without accents: matching folds accents away.
  "como funciona",
  "como que funciona",
  "como e que",
  "como faz",
  "quantas",
  "quantos",
  "o que acontece",
  "e se eu",
  "posso",
  "da pra",
  "da para",
  "pode isso",
  "isso pode",
  "isso vale",
  "vale isso",
  "pode fazer",
  "pode usar",
  "pode pegar",
  "e permitido",
  "nao pode",
  "nao vale",
  "qual a regra",
  "qual e a regra",
  "a regra",
  "regra diz",
  "manual",
  "livro de regras",
  "nao lembro",
  "nao me lembro",
  "esqueci",
  "nao sei se",
  "nao tenho certeza",
  "tem certeza",
  "pera ai",
  "perai",
  "espera ai",
  "calma ai",
  "onde vai",
  "onde fica",
  "vez de quem",
  "de quem e a vez",
  "quem comeca",
  "quem joga",
  "achei que",
  "acho que nao",
  "ta errado",
  "nao e assim",
  "olha no manual",
  "joga no google",
];

const PHASE_CUES: Record<Phase, string[]> = {
  setup: [
    "set up",
    "setup",
    "set it up",
    "shuffle",
    "deal",
    "each player gets",
    "starting hand",
    "montar",
    "monta o jogo",
    "embaralha",
    "distribui",
    "cada um pega",
    "mao inicial",
  ],
  teach: [
    "explain",
    "teach",
    "how do you play",
    "how to play",
    "the goal is",
    "how do you win",
    "explica",
    "explicar",
    "como joga",
    "como se joga",
    "o objetivo",
    "como ganha",
  ],
  play: [
    "bora jogar",
    "vamos jogar",
    "bora comecar",
    "vamos comecar",
    "primeiro jogador",
    "sua vez",
    "minha vez",
    "proxima rodada",
    "nova rodada",
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
    "acabou o jogo",
    "fim de jogo",
    "fim do jogo",
    "ultima rodada",
    "ultimo turno",
    "contar os pontos",
    "conta os pontos",
    "contagem",
    "pontuacao final",
    "quem ganhou",
    "placar",
  ],
};

/** Lower-case, accents folded (não → nao), punctuation dropped, padded with spaces for phrase matching. */
export function normalize(text: string): string {
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return ` ${folded.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()} `;
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
    const word = normalize(w).trim();
    if (!word) continue;
    const idx = n.indexOf(` ${word} `);
    if (idx === -1) continue;
    const before = n.slice(0, idx).trim();
    const after = n.slice(idx + word.length + 2).trim();
    // "hey tablemate X" / "tablemate X" / "X, tablemate?" all count. Mentions in the
    // middle of a long sentence ("I read about tablemate apps") do not.
    const leading = before === "" || /^(hey|ok|okay|hi|yo|so|um|uh|ei|oi|o|ow|ai|e ai|fala|tipo|ne)$/.test(before);
    const trailing = after === "" && before.split(" ").length <= 14;
    if (leading || trailing) {
      return { addressed: true, rest: (leading ? after : before).trim() };
    }
  }
  return { addressed: false, rest: text };
}

/** Round/turn transitions, in any game: "round two", "that's the round", "everyone passed". */
// Matched against normalize() output, which pads words with spaces: anchor to whole words.
const ROUND_TRANSITION = new RegExp(
  `(?<= )(?:${[
    "round (one|two|three|four|five|six|seven|eight|nine|ten|\\d+)",
    "round('s| is)? (done|over)",
    "end of (the )?round",
    "everyone('s| is)? (out|passed|done)",
    // pt-BR (accents already folded)
    "rodada (um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|\\d+)",
    "(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|ultima|proxima|nova) rodada",
    "(acabou|fim d[ae]|final d[ae]) (a |o )?(rodada|round|geracao|era)",
    "(todo mundo|geral|todos) (passou|passaram)",
  ].join("|")})(?= )`,
);

export type Cue = "rule-question" | "phase-change" | "game-moment";

/**
 * @param watchWords game-specific words from the playbook that are spoken right when this
 *   game's rules are most often misapplied (e.g. Catan: "robber", "bank", "seven").
 */
export function detectCues(text: string, watchWords: string[] = []): Cue[] {
  const n = normalize(text);
  const cues: Cue[] = [];
  if (RULE_QUESTION_CUES.some((c) => containsPhrase(n, c))) cues.push("rule-question");
  if (Object.values(PHASE_CUES).some((list) => list.some((c) => containsPhrase(n, c))) || ROUND_TRANSITION.test(n)) {
    cues.push("phase-change");
  }
  if (watchWords.some((w) => w.trim() && containsPhrase(n, normalize(w).trim()))) cues.push("game-moment");
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

/**
 * When the table is busy (several new lines) but nobody said a cue phrase, glance this often.
 * Quiet mistakes ("I'll give the bank two wheat") rarely come with a cue.
 */
const BUSY_SWEEP_MS: Record<Presence, number> = { quiet: 45_000, balanced: 20_000, guide: 15_000 };
const BUSY_LINES = 5;

/** Never call the listener more often than this, whatever the cues say. */
export const MIN_CHECK_GAP_MS = 6_000;
/** Game watch words are common, so they earn a check less eagerly than an explicit question. */
export const GAME_MOMENT_GAP_MS = 15_000;

export interface CheckContext {
  pending: Utterance[];
  lastCheckAt: number;
  lastSpeechAt: number;
  speaking: boolean; // someone is mid-sentence (interim results arriving)
  now: number;
  phase: Phase;
  presence: Presence;
  watchWords?: string[];
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

  const sinceCheck = now - ctx.lastCheckAt;
  const cues = new Set(pending.flatMap((u) => detectCues(u.text, ctx.watchWords)));
  if (cues.has("rule-question")) return { check: true, reason: "someone sounds unsure about a rule" };
  if (cues.has("phase-change")) return { check: true, reason: "the table may be changing phase" };
  if (pending.some((u) => u.typed)) return { check: true, reason: "a note was typed in" };
  if (cues.has("game-moment") && sinceCheck >= GAME_MOMENT_GAP_MS) {
    return { check: true, reason: "a moment where this game's rules often slip" };
  }

  if (sinceCheck >= SWEEP_MS[ctx.presence][ctx.phase] && pending.length >= 2) {
    return { check: true, reason: "routine glance at recent play" };
  }
  if (sinceCheck >= BUSY_SWEEP_MS[ctx.presence] && pending.length >= BUSY_LINES) {
    return { check: true, reason: "a lot of play since the last look" };
  }
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
