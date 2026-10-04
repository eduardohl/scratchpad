// Zod schemas for structured model output. Kept free of numeric/length constraints
// so they translate cleanly to the API's JSON-schema subset; bounds are enforced in code.

import { z } from "zod";
import { INTERVENTION_KINDS, PHASES } from "./types";

export const GameBriefSchema = z.object({
  title: z.string().describe("The game's proper name."),
  oneLiner: z.string().describe("One sentence: what the game is about and how you win."),
  rulesConfidence: z
    .enum(["high", "medium", "low"])
    .describe("How well you know these exact rules. Use low if you have no rulebook and the game is obscure."),
  caveat: z
    .string()
    .describe("Empty unless something is uncertain (edition differences, unknown expansion). One sentence."),
  setupSteps: z
    .array(z.object({ id: z.string(), text: z.string(), detail: z.string() }))
    .describe("Setup for this exact player count, in the order a table does it. ids like s1, s2."),
  teach: z
    .array(z.object({ id: z.string(), title: z.string(), points: z.array(z.string()) }))
    .describe("A teach script: goal first, then turn flow, then key exceptions. ids like t1, t2."),
  turnStructure: z.array(z.string()).describe("A player's turn, step by step."),
  roundEnd: z.array(z.string()).describe("Upkeep steps that happen between rounds or turns. Often forgotten."),
  endTrigger: z.string().describe("Exactly what ends the game."),
  scoring: z
    .array(z.object({ id: z.string(), name: z.string(), howTo: z.string() }))
    .describe("Final scoring categories as they'd appear on a score pad, with tie-breaker last. ids like c1."),
  commonMistakes: z.array(z.string()).describe("Rules new players most often get wrong."),
  watchWords: z
    .array(z.string())
    .describe(
      "8-20 short lower-case words or phrases players say aloud right when this game's rules are most often misapplied (e.g. for Catan: robber, seven, bank, harbor, settlement). Used to decide when to listen closely.",
    ),
});

export const ListenResultSchema = z.object({
  state: z.object({
    phase: z.enum(PHASES).nullable().describe("Set only if the table has clearly moved to a new phase."),
    round: z.number().nullable().describe("Current round if it was mentioned or is clear, else null."),
    activePlayer: z.string().nullable().describe("Whose turn it is if clear, else null."),
    completedSetupStepIds: z.array(z.string()).describe("Setup step ids the table has now done."),
    logEntries: z
      .array(z.string())
      .describe("0-2 terse notes worth remembering (big plays, house rules agreed, rulings made)."),
  }),
  intervention: z.object({
    speak: z.boolean().describe("False in the large majority of cases."),
    kind: z.enum(INTERVENTION_KINDS),
    urgency: z.enum(["low", "normal", "high"]),
    confidence: z.number().describe("0 to 1: how sure you are that you are right AND that speaking helps."),
    message: z.string().describe("What to say. Empty when speak is false. At most two short sentences."),
    topicKey: z.string().describe("Short kebab-case key for the topic, e.g. robber-placement."),
  }),
});
