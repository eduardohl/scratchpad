// Validation for request bodies coming from the browser. Bounds keep a runaway client
// (or a curious visitor) from sending enormous prompts.
import "server-only";

import { z } from "zod";
import { GameBriefSchema } from "./schemas";
import { PHASES } from "./types";

const Utterance = z.object({
  id: z.string().max(64),
  text: z.string().max(1000),
  at: z.number(),
  typed: z.boolean().optional(),
  addressed: z.boolean().optional(),
  speaker: z.string().max(40).optional(),
});

const Rulebook = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("file"), fileId: z.string().max(200), name: z.string().max(200) }),
  z.object({ kind: z.literal("text"), text: z.string().max(400_000), name: z.string().max(200) }),
]);

// Playbooks saved before watchWords existed are still valid.
const BriefSchema = GameBriefSchema.extend({ watchWords: z.array(z.string().max(60)).max(40).optional() });

export const GameConfigSchema = z.object({
  gameName: z.string().trim().min(1).max(120),
  players: z.array(z.string().trim().min(1).max(40)).min(1).max(12),
  experience: z.enum(["new", "mixed", "experienced"]),
  rulebook: Rulebook,
  language: z.enum(["pt-BR", "en"]).optional(),
});

const TableStateSchema = z.object({
  phase: z.enum(PHASES),
  round: z.number().nullable(),
  activePlayer: z.string().max(40).nullable(),
  completedSetup: z.array(z.string().max(32)).max(200),
  scores: z.record(z.string(), z.record(z.string(), z.number())),
  log: z.array(z.string().max(300)).max(200),
});

export const ListenRequestSchema = z.object({
  config: GameConfigSchema,
  brief: BriefSchema,
  state: TableStateSchema,
  presence: z.enum(["quiet", "balanced", "guide"]),
  earlier: z.array(Utterance).max(60),
  recent: z.array(Utterance).min(1).max(80),
  recentTopics: z.array(z.string().max(80)).max(50),
  reason: z.string().max(200),
});

export const AskRequestSchema = z.object({
  config: GameConfigSchema,
  brief: BriefSchema,
  state: TableStateSchema,
  mode: z.enum(["question", "recap"]),
  question: z.string().max(1000),
  recent: z.array(Utterance).max(80),
});
