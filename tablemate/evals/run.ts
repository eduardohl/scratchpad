// Eval runner. Usage (from tablemate/):
//   npm run eval                      free dry run: validates scripts, counts listener checks, estimates cost
//   npm run eval -- --yes             live run against Claude (spends money; needs ANTHROPIC_API_KEY)
// Options:
//   --only catan,azul                 run scripts whose id contains any of these
//   --repeat 3                        run each script N times (model output varies)
//   --no-speakers                     hide speaker names, as with browser speech recognition
//   --no-grade                        skip the Claude grader (time-matching only)
//   --refresh-briefs                  regenerate cached game playbooks

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LISTENER_MODEL, listenDetailed, listenPrompt, prepareGame } from "../src/lib/claude";
import type { GameBrief, GameConfig, ListenResult } from "../src/lib/types";
import { claudeGrader, GRADER_MODEL } from "./grade";
import { loadScripts } from "./script";
import type { Script } from "./script";
import { costUsd, scoreScript, summarize, trustingGrader } from "./score";
import type { ScriptScore, Summary } from "./score";
import { DEFAULT_SIM, simulate } from "./simulate";
import type { Listener } from "./simulate";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const live = flag("yes");
const repeat = Math.max(1, Number(option("repeat") ?? 1));
const only = option("only")?.split(",").filter(Boolean);
const speakers = !flag("no-speakers");
const grade = live && !flag("no-grade");

const TARGETS = { precision: 0.9, recall: 0.7, wrongRulingsWithRulebook: 0 };

// ---- playbooks ---------------------------------------------------------------

const BRIEF_DIR = path.join(ROOT, ".cache", "briefs");

function configFor(script: Script): GameConfig {
  return {
    gameName: script.game,
    players: script.players,
    experience: script.experience,
    rulebook: script.rulebook ? { kind: "text", text: script.rulebook, name: `${script.game} rules (excerpt)` } : { kind: "none" },
  };
}

function briefPath(config: GameConfig): string {
  const key = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
  return path.join(BRIEF_DIR, `${config.gameName.toLowerCase().replace(/\W+/g, "-")}-${key}.json`);
}

function cachedBrief(config: GameConfig): GameBrief | null {
  const p = briefPath(config);
  return existsSync(p) && !flag("refresh-briefs") ? (JSON.parse(readFileSync(p, "utf8")) as GameBrief) : null;
}

async function briefFor(config: GameConfig): Promise<GameBrief> {
  const cached = cachedBrief(config);
  if (cached) return cached;
  const brief = await prepareGame(config);
  mkdirSync(BRIEF_DIR, { recursive: true });
  writeFileSync(briefPath(config), JSON.stringify(brief, null, 2));
  return brief;
}

/** Stand-in playbook for dry runs when nothing is cached yet. */
function placeholderBrief(script: Script): GameBrief {
  return {
    title: script.game,
    oneLiner: "",
    rulesConfidence: "high",
    caveat: "",
    setupSteps: [],
    teach: [],
    turnStructure: [],
    roundEnd: [],
    endTrigger: "",
    scoring: [],
    commonMistakes: [],
  };
}

// ---- listeners -----------------------------------------------------------------

const SILENT: ListenResult = {
  state: { phase: null, round: null, activePlayer: null, completedSetupStepIds: [], logEntries: [] },
  intervention: { speak: false, kind: "tip", urgency: "low", confidence: 0, message: "", topicKey: "" },
};

/** Rough token count; good enough for a budget estimate. */
const approxTokens = (text: string) => Math.ceil(text.length / 3.5);
const PLACEHOLDER_PLAYBOOK_TOKENS = 2500;
const EST_OUTPUT_TOKENS = 700; // structured JSON plus low-effort thinking

/** Never speaks; estimates the tokens a real call would use. */
function dryListener(placeholder: boolean): Listener {
  let first = true;
  return async (req) => {
    const prompt = listenPrompt(req);
    const blocks = prompt.content.map((b) =>
      b.type === "text" ? b.text : b.type === "document" && b.source.type === "text" ? b.source.data : "",
    );
    const prefix = approxTokens(prompt.system) + blocks.slice(0, -1).reduce((a, t) => a + approxTokens(t), 0) +
      (placeholder ? PLACEHOLDER_PLAYBOOK_TOKENS : 0);
    const volatile = approxTokens(blocks.at(-1) ?? "");
    const usage = first
      ? { input: volatile, cacheWrite: prefix, cacheRead: 0, output: EST_OUTPUT_TOKENS }
      : { input: volatile, cacheWrite: 0, cacheRead: prefix, output: EST_OUTPUT_TOKENS };
    first = false;
    return { result: SILENT, usage };
  };
}

// ---- report ----------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const usd = (x: number | null) => (x === null ? "?" : `$${x.toFixed(2)}`);

function printSummary(sum: Summary) {
  const pass = (ok: boolean) => (ok ? "✓" : "✗");
  console.log(`\nScripts run: ${sum.scripts}   surfaced: ${sum.surfaced}   wanted: ${sum.wanted}   unwanted: ${sum.unwanted}`);
  console.log(`Interruption precision: ${pct(sum.precision)}  (target ≥ ${pct(TARGETS.precision)}) ${sum.precision === null ? "" : pass(sum.precision >= TARGETS.precision)}`);
  console.log(`Recall:                 ${pct(sum.recall)}  (target ≥ ${pct(TARGETS.recall)}) ${sum.recall === null ? "" : pass(sum.recall >= TARGETS.recall)}`);
  for (const [cat, r] of Object.entries(sum.recallByCategory)) console.log(`  ${cat.padEnd(15)} ${r.caught}/${r.total}`);
  console.log(`Near misses (noticed, but only as a quiet tip): ${sum.nearMisses}`);
  console.log(`Gate ceiling (moments the listener got to see in time): ${sum.reachable}/${sum.required}`);
  console.log(`Wrong rulings: ${sum.wrongRulings} (with rulebook: ${sum.wrongRulingsWithRulebook}, target 0) ${pass(sum.wrongRulingsWithRulebook === 0)}`);
  console.log(`Listener checks per hour of talk: ${Math.round(sum.checksPerHour)}`);
}

function printScript(s: ScriptScore) {
  const misses = s.required.filter((r) => !r.caught);
  const bad = s.surfaced.filter((o) => o.verdict === "unwanted" || o.verdict === "off-topic" || o.grade.ruleError);
  const mark = misses.length === 0 && bad.length === 0 ? "✓" : "✗";
  console.log(`${mark} ${s.scriptId.padEnd(30)} checks ${String(s.checks).padStart(2)}  surfaced ${s.surfaced.length}`);
  for (const m of misses) console.log(`    missed${m.nearMiss ? " (tip only)" : ""}: ${m.fact}`);
  for (const o of bad) {
    console.log(`    ${o.verdict}${o.grade.ruleError ? " + WRONG RULING" : ""} @${o.at}s: "${o.message}"  — ${o.grade.explanation}`);
  }
}

// ---- main ------------------------------------------------------------------------

async function main() {
  const scripts = loadScripts(path.join(ROOT, "scripts"), only);
  if (scripts.length === 0) throw new Error("No scripts matched.");
  console.log(`${live ? "LIVE" : "DRY"} run: ${scripts.length} scripts × ${repeat}, speakers ${speakers ? "on" : "off"}, listener ${LISTENER_MODEL}`);

  // A dry pass always runs first: it's free, validates the scripts, and prices the live run.
  const dryScores: ScriptScore[] = [];
  let missingBriefs = 0;
  for (const script of scripts) {
    const cached = cachedBrief(configFor(script));
    if (!cached) missingBriefs++;
    const sim = await simulate(script, cached ?? placeholderBrief(script), dryListener(!cached), { ...DEFAULT_SIM, speakers });
    dryScores.push(await scoreScript(script, sim, trustingGrader));
  }
  const dry = summarize(dryScores, scripts);
  const listenCost = (costUsd(dry.usage, LISTENER_MODEL) ?? 0) * repeat;
  const required = dryScores.reduce((a, s) => a + s.required.length, 0);
  const gradeCost = !flag("no-grade") ? required * repeat * 1.3 * 0.03 : 0; // ~1 graded message per expectation, plus some extras
  const briefCost = missingBriefs * 0.15;
  const total = listenCost + gradeCost + briefCost;

  console.log(`\nListener checks: ${dryScores.reduce((a, s) => a + s.checks, 0)} per pass (${Math.round(dry.checksPerHour)}/hour of talk)`);
  console.log(`Gate ceiling: ${dry.reachable}/${dry.required} planted moments reach the listener in time`);
  for (const s of dryScores) {
    for (const r of s.required.filter((x) => !x.reachable)) console.log(`  unreachable: ${r.id}  (${r.fact.slice(0, 70)}…)`);
  }
  console.log(`Estimated live cost: ${usd(total)}  (listener ${usd(listenCost)}, grader ${usd(gradeCost)}, ${missingBriefs} playbooks to prepare ${usd(briefCost)})`);
  console.log("Estimates use rough token counts; the live report shows actual usage.");

  if (!live) {
    console.log("\nDry run only. Re-run with --yes to call Claude.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("Set ANTHROPIC_API_KEY to run live.");
  }

  const listener: Listener = (req) => listenDetailed(req);
  const grader = grade ? claudeGrader() : trustingGrader;
  const scores: ScriptScore[] = [];
  const runScripts: Script[] = [];
  console.log("");
  for (const script of scripts) {
    const brief = await briefFor(configFor(script));
    for (let r = 0; r < repeat; r++) {
      const sim = await simulate(script, brief, listener, { ...DEFAULT_SIM, speakers });
      const score = await scoreScript(script, sim, grader);
      printScript(score);
      scores.push(score);
      runScripts.push(script);
    }
  }

  const sum = summarize(scores, runScripts);
  printSummary(sum);
  console.log(`Actual listener cost: ${usd(costUsd(sum.usage, LISTENER_MODEL))}  (grader: ${GRADER_MODEL})`);

  const outDir = path.join(ROOT, "results");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    JSON.stringify({ options: { repeat, speakers, grade, listener: LISTENER_MODEL }, summary: sum, scores }, null, 2),
  );
  console.log(`\nFull results: ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
