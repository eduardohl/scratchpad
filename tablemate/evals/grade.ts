// Claude-as-grader: is a surfaced intervention on topic, and is it correct?
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { timeline } from "./script";
import type { Grader } from "./score";

const GradeSchema = z.object({
  conveysFact: z
    .boolean()
    .nullable()
    .describe("Does the message convey the expected fact (same substance, any wording)? null if no expected fact was given."),
  ruleError: z.boolean().describe("Does the message state any rule of the game incorrectly?"),
  explanation: z.string().describe("One sentence."),
});

export const GRADER_MODEL = process.env.TABLEMATE_GRADER_MODEL || "claude-opus-5-5";

export function claudeGrader(client = new Anthropic()): Grader {
  return async ({ script, expectation, item }) => {
    const { lines } = timeline(script);
    const upTo = expectation ? expectation.line + 3 : lines.length;
    const context = lines
      .slice(Math.max(0, upTo - 14), upTo)
      .map((l) => `${l.who}: ${l.text}`)
      .join("\n");

    const res = await client.beta.messages.parse({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      model: GRADER_MODEL,
      max_tokens: 2000,
      output_config: { effort: "medium", format: betaZodOutputFormat(GradeSchema) },
      system:
        "You grade a board game assistant. It listens to a table and occasionally interjects. Judge its interjection strictly on substance. You know the rules of popular board games well; if a rules excerpt is provided, it is authoritative.",
      messages: [
        {
          role: "user",
          content: `GAME: ${script.game} (${script.players.length} players)
${script.rulebook ? `RULES EXCERPT:\n${script.rulebook}\n` : ""}
CONVERSATION:
${context}

EXPECTED FACT: ${expectation ? expectation.fact : "(none: this interjection was not expected)"}

ASSISTANT SAID: ${item.message}`,
        },
      ],
    });
    const g = res.parsed_output;
    if (res.stop_reason === "refusal" || !g) {
      return { conveysFact: null, ruleError: false, explanation: "grader declined" };
    }
    return { ...g, conveysFact: expectation ? g.conveysFact : null };
  };
}
