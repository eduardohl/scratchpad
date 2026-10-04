// Table scripts: short, labeled conversations used to measure whether Tablemate speaks
// when it should and stays quiet when it shouldn't.
//
// A script is a list of lines. A line can carry an expectation:
//   "speak": Tablemate should surface this (a card or voice). Counts toward recall.
//   "ok":    surfacing this is fine but not required (e.g. a phase pointer).
// Anything surfaced that doesn't match an expectation counts as an unwanted interruption.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PHASES } from "../src/lib/types";

export const CATEGORIES = ["rule-error", "skipped-step", "stuck-question", "phase"] as const;
export type Category = (typeof CATEGORIES)[number];

const Expectation = z.object({
  type: z.enum(["speak", "ok"]),
  category: z.enum(CATEGORIES),
  /** The rules fact a good intervention must convey. Used by the grader. */
  fact: z.string().min(1),
  /** Seconds after this line ends during which a surfaced intervention counts. */
  window: z.number().positive().optional(),
});

const Line = z.object({
  who: z.string(),
  say: z.string().min(1),
  /** Silence before this line starts, in seconds (default 1.5). */
  pause: z.number().nonnegative().optional(),
  expect: Expectation.optional(),
});

export const ScriptSchema = z.object({
  id: z.string(),
  game: z.string(),
  players: z.array(z.string()).min(1),
  experience: z.enum(["new", "mixed", "experienced"]),
  presence: z.enum(["quiet", "balanced", "guide"]),
  phase: z.enum(PHASES),
  /** What this script tests, for humans reading results. */
  notes: z.string(),
  /** Optional rules text supplied as the "rulebook" for this script. */
  rulebook: z.string().optional(),
  lines: z.array(Line).min(1),
});
export type Script = z.infer<typeof ScriptSchema>;

export interface TimedLine {
  index: number;
  who: string;
  text: string;
  /** Seconds from script start when the speaker starts and finishes this line. */
  start: number;
  end: number;
}

export interface TimedExpectation extends z.infer<typeof Expectation> {
  id: string;
  line: number;
  /** Absolute seconds: when the trigger line ends, and when the window closes. */
  from: number;
  until: number;
}

export const DEFAULT_PAUSE = 1.5;
export const DEFAULT_WINDOW = 45;
const SECONDS_PER_WORD = 0.33;

/** Lay the script out on a timeline: each line takes time to say, separated by pauses. */
export function timeline(script: Script): { lines: TimedLine[]; expectations: TimedExpectation[]; duration: number } {
  let t = 0;
  const lines: TimedLine[] = [];
  const expectations: TimedExpectation[] = [];
  script.lines.forEach((l, index) => {
    const start = t + (index === 0 ? 0.5 : (l.pause ?? DEFAULT_PAUSE));
    const words = l.say.trim().split(/\s+/).length;
    const end = start + Math.max(0.8, words * SECONDS_PER_WORD);
    lines.push({ index, who: l.who, text: l.say, start, end });
    if (l.expect) {
      expectations.push({
        ...l.expect,
        id: `${script.id}#${index}`,
        line: index,
        from: end,
        until: end + (l.expect.window ?? DEFAULT_WINDOW),
      });
    }
    t = end;
  });
  return { lines, expectations, duration: t };
}

export function loadScripts(dir: string, only?: string[]): Script[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const scripts = files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const parsed = ScriptSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (`${parsed.data.id}.json` !== f) throw new Error(`${f}: id "${parsed.data.id}" must match the file name`);
    return parsed.data;
  });
  return only?.length ? scripts.filter((s) => only.some((o) => s.id.includes(o))) : scripts;
}
