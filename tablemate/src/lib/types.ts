// Shared types for client and server.

export const PHASES = ["setup", "teach", "play", "wrapup"] as const;
export type Phase = (typeof PHASES)[number];

/** How willing Tablemate is to speak without being asked. */
export type Presence = "quiet" | "balanced" | "guide";

export type Experience = "new" | "mixed" | "experienced";

export interface Settings {
  presence: Presence;
  /** Speak interventions aloud (speech synthesis) instead of only showing them. */
  voice: boolean;
  /** Words that address Tablemate directly. Lower-case. */
  wakeWords: string[];
}

export interface Utterance {
  id: string;
  text: string;
  at: number; // epoch ms
  /** Typed into the app rather than heard. */
  typed?: boolean;
  /** Who said it, when the transcriber can tell voices apart (player name or "someone"). */
  speaker?: string;
  /** Addressed to Tablemate by name; it was answered directly, so the listener shouldn't re-answer. */
  addressed?: boolean;
}

/** Where the rules come from. A PDF lives in the Files API; pasted text is sent inline. */
export type RulebookRef =
  | { kind: "none" }
  | { kind: "file"; fileId: string; name: string }
  | { kind: "text"; text: string; name: string };

export interface SetupStep {
  id: string;
  text: string;
  detail: string;
}

export interface TeachSection {
  id: string;
  title: string;
  points: string[];
}

export interface ScoringCategory {
  id: string;
  name: string;
  howTo: string;
}

/** The game-specific playbook, produced once by /api/prepare and reused all game. */
export interface GameBrief {
  title: string;
  oneLiner: string;
  /** How sure the model is about the rules without a rulebook: high | medium | low. */
  rulesConfidence: "high" | "medium" | "low";
  caveat: string;
  setupSteps: SetupStep[];
  teach: TeachSection[];
  turnStructure: string[];
  roundEnd: string[];
  endTrigger: string;
  scoring: ScoringCategory[];
  commonMistakes: string[];
  /** Words spoken right when this game's rules tend to slip ("robber", "bank"). Older playbooks lack it. */
  watchWords?: string[];
}

/** The language the table talks in. pt-BR tables mix in English game terms freely. */
export type TableLanguage = "pt-BR" | "en";

export interface GameConfig {
  gameName: string;
  players: string[];
  experience: Experience;
  rulebook: RulebookRef;
  /** Defaults to English when absent (sessions saved before this setting existed). */
  language?: TableLanguage;
}

/** Live, lightweight table state. The listener keeps it up to date from what it hears. */
export interface TableState {
  phase: Phase;
  round: number | null;
  activePlayer: string | null;
  completedSetup: string[];
  /** Per-player, per-category scores entered during wrap-up. */
  scores: Record<string, Record<string, number>>;
  /** Short running log of notable events, used as long-term memory. */
  log: string[];
}

export const INTERVENTION_KINDS = [
  "answer", // the table asked something and is stuck
  "correction", // a rule is being applied wrong
  "reminder", // a step is being skipped / forgotten
  "phase", // a phase is starting or ending and a pointer helps
  "teach", // next chunk of the rules teach
  "tip", // strategy / quality-of-life, lowest priority
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export type Urgency = "low" | "normal" | "high";

export interface Intervention {
  id: string;
  kind: InterventionKind;
  urgency: Urgency;
  confidence: number; // 0..1
  message: string;
  /** Stable short key for de-duplication, e.g. "trade-limit-per-turn". */
  topicKey: string;
  at: number;
  /** True when someone addressed Tablemate directly. */
  direct?: boolean;
}

/** What the listener sends back after reading a slice of conversation. */
export interface ListenResult {
  state: {
    phase: Phase | null;
    round: number | null;
    activePlayer: string | null;
    completedSetupStepIds: string[];
    logEntries: string[];
  };
  intervention: {
    speak: boolean;
    kind: InterventionKind;
    urgency: Urgency;
    confidence: number;
    message: string;
    topicKey: string;
  };
}

export interface ListenRequest {
  config: GameConfig;
  brief: GameBrief;
  state: TableState;
  presence: Presence;
  /** Older utterances the listener has already seen (context). */
  earlier: Utterance[];
  /** Utterances since the last listen call — what to judge. */
  recent: Utterance[];
  /** Topic keys Tablemate already raised recently; don't repeat them. */
  recentTopics: string[];
  /** Why the client decided to check now. */
  reason: string;
}

export type AskMode = "question" | "recap";

export interface AskRequest {
  config: GameConfig;
  brief: GameBrief;
  state: TableState;
  mode: AskMode;
  question: string;
  recent: Utterance[];
}
