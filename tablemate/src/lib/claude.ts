// Server-only Claude calls. Never import this from a client component.
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ASK_SYSTEM, LISTEN_SYSTEM, PREPARE_SYSTEM, RECAP_SYSTEM, playbookText, stateText, transcriptText } from "./prompts";
import { GameBriefSchema, ListenResultSchema } from "./schemas";
import type { AskRequest, GameBrief, GameConfig, ListenRequest, ListenResult, RulebookRef } from "./types";

type Block = Anthropic.Beta.BetaContentBlockParam;

const client = new Anthropic();

const LISTENER_MODEL = process.env.TABLEMATE_LISTENER_MODEL || "claude-opus-5-5";
const ANSWER_MODEL = process.env.TABLEMATE_ANSWER_MODEL || "claude-opus-5-5";

// Route safety-classifier declines to Anthropic's recommended fallback model instead of failing.
const RESILIENCE = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} as const satisfies Pick<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "betas" | "fallbacks">;

function rulebookBlock(rulebook: RulebookRef): Block | null {
  switch (rulebook.kind) {
    case "file":
      return { type: "document", source: { type: "file", file_id: rulebook.fileId }, title: rulebook.name };
    case "text":
      return {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: rulebook.text },
        title: rulebook.name,
      };
    case "none":
      return null;
  }
}

/**
 * The stable part of every in-game request: rulebook + playbook. It doesn't change all game,
 * so it sits before the cache breakpoint and later calls read it from cache.
 */
function tableContext(config: GameConfig, brief: GameBrief): Block[] {
  const blocks: Block[] = [];
  const rb = rulebookBlock(config.rulebook);
  if (rb) blocks.push(rb);
  blocks.push({ type: "text", text: playbookText(config, brief), cache_control: { type: "ephemeral" } });
  return blocks;
}

export class DeclinedError extends Error {}

export async function prepareGame(config: GameConfig): Promise<GameBrief> {
  const content: Block[] = [];
  const rb = rulebookBlock(config.rulebook);
  if (rb) content.push(rb);
  content.push({
    type: "text",
    text: `Prepare the playbook for tonight's game.
Game: ${config.gameName}
Players (${config.players.length}): ${config.players.join(", ")}
Table experience: ${config.experience}
${rb ? "The rulebook is attached above; follow it." : "No rulebook provided; rely on what you know and be honest about gaps."}`,
  });

  const res = await client.beta.messages.parse({
    ...RESILIENCE,
    model: ANSWER_MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(GameBriefSchema) },
    system: PREPARE_SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    throw new DeclinedError("Couldn't prepare a playbook for that game.");
  }
  return res.parsed_output;
}

const SILENT: ListenResult["intervention"] = {
  speak: false,
  kind: "tip",
  urgency: "low",
  confidence: 0,
  message: "",
  topicKey: "",
};

export async function listen(req: ListenRequest): Promise<ListenResult> {
  const start = req.earlier[0]?.at ?? req.recent[0]?.at ?? Date.now();
  const volatile = `${stateText(req.state)}

PRESENCE SETTING: ${req.presence} (quiet = only high-stakes; balanced = default; guide = new players, more help welcome)
ALREADY RAISED RECENTLY (don't repeat): ${req.recentTopics.join(", ") || "none"}
WHY YOU'RE BEING CHECKED: ${req.reason}

EARLIER CONVERSATION (already reviewed, for context):
${transcriptText(req.earlier, start)}

NEW SINCE YOUR LAST LOOK (judge this):
${transcriptText(req.recent, start)}`;

  const res = await client.beta.messages.parse({
    ...RESILIENCE,
    model: LISTENER_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(ListenResultSchema) },
    system: LISTEN_SYSTEM,
    messages: [{ role: "user", content: [...tableContext(req.config, req.brief), { type: "text", text: volatile }] }],
  });

  const out = res.stop_reason === "refusal" ? null : res.parsed_output;
  if (!out) {
    return {
      state: { phase: null, round: null, activePlayer: null, completedSetupStepIds: [], logEntries: [] },
      intervention: SILENT,
    };
  }
  out.intervention.confidence = Math.min(1, Math.max(0, out.intervention.confidence));
  if (!out.intervention.speak) out.intervention = { ...SILENT };
  return out;
}

/**
 * Streams a spoken-style answer (or the end-of-game recap) as plain text.
 * Waits for the first event before returning, so auth/validation errors become a proper
 * HTTP error instead of a stream that dies halfway.
 */
export async function ask(req: AskRequest): Promise<ReadableStream<Uint8Array>> {
  const start = req.recent[0]?.at ?? Date.now();
  const recap = req.mode === "recap";
  const scores = Object.entries(req.state.scores)
    .map(([player, cats]) => `${player}: ${Object.values(cats).reduce((a, b) => a + b, 0)} (${JSON.stringify(cats)})`)
    .join("\n");
  const volatile = `${stateText(req.state)}
${scores ? `\nSCORES\n${scores}\n` : ""}
RECENT CONVERSATION:
${transcriptText(req.recent, start)}

${recap ? "Write the recap now." : `QUESTION: ${req.question}\n\nLatency-sensitive; begin your visible answer immediately.`}`;

  const stream = client.beta.messages.stream({
    ...RESILIENCE,
    model: ANSWER_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    system: recap ? RECAP_SYSTEM : ASK_SYSTEM,
    messages: [{ role: "user", content: [...tableContext(req.config, req.brief), { type: "text", text: volatile }] }],
  });
  const events = stream[Symbol.asyncIterator]();
  const first = await events.next(); // throws on auth / bad request

  const encoder = new TextEncoder();
  const emit = (event: Anthropic.Beta.BetaRawMessageStreamEvent, controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      controller.enqueue(encoder.encode(event.delta.text));
    }
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) emit(first.value, controller);
        for (let next = await events.next(); !next.done; next = await events.next()) emit(next.value, controller);
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          controller.enqueue(encoder.encode("\n\nSorry, I can't help with that one."));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      stream.abort();
    },
  });
}

/** Upload a rulebook PDF once; later requests reference it by id instead of re-sending bytes. */
export async function uploadRulebook(file: File): Promise<string> {
  const meta = await client.files.upload({ file, expires_in_seconds: 7 * 24 * 3600 });
  return meta.id;
}

export function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof DeclinedError) return { status: 422, message: err.message };
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 500, message: "Server is missing a valid ANTHROPIC_API_KEY." };
  }
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: "Busy right now, try again in a moment." };
  if (err instanceof Anthropic.BadRequestError) return { status: 400, message: err.message };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `Claude API error (${err.status ?? "network"}).` };
  // The SDK throws a plain Error when it can't find any credentials at all.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { status: 500, message: "Claude isn't configured on the server. Set ANTHROPIC_API_KEY." };
  }
  return { status: 500, message: "Unexpected error." };
}
