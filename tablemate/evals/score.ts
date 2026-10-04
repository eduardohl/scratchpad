// Turns simulation events into the numbers we steer by. Pure, so it's unit tested.

import type { FeedItem } from "../src/lib/session";
import type { CallUsage } from "../src/lib/claude";
import { CATEGORIES, timeline } from "./script";
import type { Category, Script, TimedExpectation } from "./script";
import { secondsOf } from "./simulate";
import type { SimResult } from "./simulate";

export interface Grade {
  /** Did the message convey the expectation's fact? null when there's no expectation to compare to. */
  conveysFact: boolean | null;
  /** Does the message state a rule incorrectly? */
  ruleError: boolean;
  explanation: string;
}

export type Grader = (args: { script: Script; expectation: TimedExpectation | null; item: FeedItem }) => Promise<Grade>;

/** Without a grader, assume time-matched interventions are on topic and correct. */
export const trustingGrader: Grader = async ({ expectation }) => ({
  conveysFact: expectation ? true : null,
  ruleError: false,
  explanation: "ungraded",
});

export interface Outcome {
  at: number; // seconds from script start
  message: string;
  kind: string;
  expectation: string | null;
  verdict: "wanted" | "acceptable" | "off-topic" | "unwanted";
  grade: Grade;
}

export interface ScriptScore {
  scriptId: string;
  durationSec: number;
  checks: number;
  usage: CallUsage;
  surfaced: Outcome[];
  /** Expectations of type "speak" and whether they were caught (surfaced and on topic). */
  required: {
    id: string;
    category: Category;
    fact: string;
    caught: boolean;
    nearMiss: boolean;
    /** Did the listener get a look at this moment in time to speak? If not, no model could catch it. */
    reachable: boolean;
  }[];
}

const ZERO: CallUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

export async function scoreScript(script: Script, sim: SimResult, grade: Grader): Promise<ScriptScore> {
  const { expectations } = timeline(script);
  const matched = new Set<string>();
  const caught = new Set<string>();
  const surfaced: Outcome[] = [];

  const checks = sim.events.filter((e) => e.type === "check");
  const usage = checks.reduce((u, e) => addUsage(u, e.usage), ZERO);

  for (const e of sim.events) {
    if (e.type !== "surfaced" || e.item.direct) continue;
    const t = secondsOf(e.at);
    // Match to the earliest open expectation whose window covers this moment; prefer "speak".
    const open = expectations
      .filter((x) => !matched.has(x.id) && x.from - 1 <= t && t <= x.until)
      .sort((a, b) => (a.type === b.type ? a.from - b.from : a.type === "speak" ? -1 : 1));
    const exp = open[0] ?? null;
    const g = await grade({ script, expectation: exp, item: e.item });

    let verdict: Outcome["verdict"];
    if (!exp) verdict = "unwanted";
    else if (g.conveysFact === false) verdict = "off-topic";
    else verdict = exp.type === "speak" ? "wanted" : "acceptable";

    if (exp && verdict !== "off-topic") {
      matched.add(exp.id);
      if (exp.type === "speak") caught.add(exp.id);
    }
    surfaced.push({ at: t, message: e.item.message, kind: e.item.kind, expectation: exp?.id ?? null, verdict, grade: g });
  }

  const quietlyNoticed = (x: TimedExpectation) =>
    sim.events.some(
      (e) => (e.type === "badge" || e.type === "stale") && x.from - 1 <= secondsOf(e.at) && secondsOf(e.at) <= x.until,
    );

  return {
    scriptId: script.id,
    durationSec: sim.duration,
    checks: checks.length,
    usage,
    surfaced,
    required: expectations
      .filter((x) => x.type === "speak")
      .map((x) => ({
        id: x.id,
        category: x.category,
        fact: x.fact,
        caught: caught.has(x.id),
        nearMiss: !caught.has(x.id) && quietlyNoticed(x),
        reachable: checks.some((c) => x.from - 0.5 <= secondsOf(c.at) && secondsOf(c.at) <= x.until - 5),
      })),
  };
}

export interface Summary {
  scripts: number;
  surfaced: number;
  wanted: number;
  unwanted: number;
  /** wanted / (surfaced − acceptable). Null when nothing was surfaced. */
  precision: number | null;
  recall: number | null;
  recallByCategory: Partial<Record<Category, { caught: number; total: number }>>;
  nearMisses: number;
  /** Required moments the gate sent to the listener in time: the ceiling on recall. */
  reachable: number;
  required: number;
  wrongRulings: number;
  /** Wrong rulings in scripts that supplied a rulebook (target: zero). */
  wrongRulingsWithRulebook: number;
  checksPerHour: number;
  usage: CallUsage;
}

export function summarize(scores: ScriptScore[], scripts: Script[]): Summary {
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const all = scores.flatMap((s) => s.surfaced.map((o) => ({ o, hasRulebook: Boolean(byId.get(s.scriptId)?.rulebook) })));
  const wanted = all.filter(({ o }) => o.verdict === "wanted").length;
  const acceptable = all.filter(({ o }) => o.verdict === "acceptable").length;
  const unwanted = all.filter(({ o }) => o.verdict === "unwanted" || o.verdict === "off-topic").length;
  const required = scores.flatMap((s) => s.required);

  const recallByCategory: Summary["recallByCategory"] = {};
  for (const c of CATEGORIES) {
    const rs = required.filter((r) => r.category === c);
    if (rs.length) recallByCategory[c] = { caught: rs.filter((r) => r.caught).length, total: rs.length };
  }

  const judged = all.length - acceptable;
  const seconds = scores.reduce((a, s) => a + s.durationSec, 0);
  return {
    scripts: scores.length,
    surfaced: all.length,
    wanted,
    unwanted,
    precision: judged > 0 ? wanted / judged : null,
    recall: required.length ? required.filter((r) => r.caught).length / required.length : null,
    recallByCategory,
    nearMisses: required.filter((r) => r.nearMiss).length,
    reachable: required.filter((r) => r.reachable).length,
    required: required.length,
    wrongRulings: all.filter(({ o }) => o.grade.ruleError).length,
    wrongRulingsWithRulebook: all.filter(({ o, hasRulebook }) => hasRulebook && o.grade.ruleError).length,
    checksPerHour: seconds > 0 ? (scores.reduce((a, s) => a + s.checks, 0) / seconds) * 3600 : 0,
    usage: scores.reduce((u, s) => addUsage(u, s.usage), ZERO),
  };
}

/** USD per million tokens. Cache writes use the 5-minute rate (1.25× input). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function costUsd(usage: CallUsage, model: string): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (usage.input * p.input + usage.cacheWrite * p.input * 1.25 + usage.cacheRead * p.cacheRead + usage.output * p.output) /
    1_000_000
  );
}
