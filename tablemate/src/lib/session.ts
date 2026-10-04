// The game session as the client holds it. Plain data, so it can be persisted to
// localStorage and replayed by the eval harness.

import type { Delivery } from "./gate";
import type { GameBrief, GameConfig, Intervention, Settings, TableState, Utterance } from "./types";

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

export function newSession(
  config: GameConfig,
  brief: GameBrief,
  settings: Settings,
  overrides: Partial<Session> = {},
): Session {
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
    ...overrides,
  };
}
