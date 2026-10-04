import { describe, expect, it } from "vitest";
import type { FeedItem } from "../src/lib/session";
import type { Script } from "./script";
import { timeline } from "./script";
import { costUsd, scoreScript, summarize, trustingGrader } from "./score";
import type { Grader } from "./score";
import type { SimEvent, SimResult } from "./simulate";

const EPOCH = 1_700_000_000_000;
const at = (sec: number) => EPOCH + sec * 1000;
const usage = { input: 100, cacheRead: 1000, cacheWrite: 0, output: 50 };

const script: Script = {
  id: "t",
  game: "Catan",
  players: ["A", "B"],
  experience: "new",
  presence: "balanced",
  phase: "play",
  notes: "",
  lines: [
    { who: "A", say: "one two three" },
    { who: "B", say: "I'll give the bank two wheat", expect: { type: "speak", category: "rule-error", fact: "4:1" } },
    { who: "A", say: "ok we're done", pause: 20, expect: { type: "ok", category: "phase", fact: "next" } },
  ],
};

const item = (message: string, extra: Partial<FeedItem> = {}): FeedItem => ({
  id: message,
  kind: "correction",
  urgency: "normal",
  confidence: 0.9,
  message,
  topicKey: message,
  at: 0,
  delivery: "card",
  ...extra,
});

function sim(events: SimEvent[]): SimResult {
  return { scriptId: "t", events, duration: timeline(script).duration, finalState: {} as SimResult["finalState"] };
}

describe("timeline", () => {
  it("lays lines out with pauses and anchors expectations at line end", () => {
    const { lines, expectations } = timeline(script);
    expect(lines[1].start).toBeCloseTo(lines[0].end + 1.5);
    expect(lines[2].start).toBeCloseTo(lines[1].end + 20);
    expect(expectations.map((e) => e.line)).toEqual([1, 2]);
    expect(expectations[0].until - expectations[0].from).toBe(45);
  });
});

describe("scoreScript", () => {
  const { expectations } = timeline(script);
  const speakAt = expectations[0].from + 3;

  it("counts an on-time intervention as wanted and the expectation as caught", async () => {
    const s = await scoreScript(
      script,
      sim([
        { type: "check", at: at(speakAt - 2), reason: "cue", usage },
        { type: "surfaced", at: at(speakAt), item: item("bank trades are 4:1") },
      ]),
      trustingGrader,
    );
    expect(s.surfaced[0].verdict).toBe("wanted");
    expect(s.required).toEqual([expect.objectContaining({ caught: true, reachable: true })]);
  });

  it("flags interruptions outside any window as unwanted", async () => {
    const s = await scoreScript(script, sim([{ type: "surfaced", at: at(0.5), item: item("random") }]), trustingGrader);
    expect(s.surfaced[0].verdict).toBe("unwanted");
    expect(s.required[0].caught).toBe(false);
    expect(s.required[0].reachable).toBe(false);
  });

  it("treats an on-time but off-topic message as unwanted and not caught", async () => {
    const offTopic: Grader = async () => ({ conveysFact: false, ruleError: false, explanation: "" });
    const s = await scoreScript(script, sim([{ type: "surfaced", at: at(speakAt), item: item("nice move") }]), offTopic);
    expect(s.surfaced[0].verdict).toBe("off-topic");
    expect(s.required[0].caught).toBe(false);
  });

  it("ignores direct answers and notes quiet tips as near misses", async () => {
    const s = await scoreScript(
      script,
      sim([
        { type: "surfaced", at: at(speakAt), item: item("answer", { direct: true }) },
        { type: "badge", at: at(speakAt), item: item("bank 4:1"), why: "cooldown" },
      ]),
      trustingGrader,
    );
    expect(s.surfaced).toHaveLength(0);
    expect(s.required[0].nearMiss).toBe(true);
  });

  it("summarizes precision excluding acceptable interventions", async () => {
    const okAt = expectations[1].from + 2;
    const s = await scoreScript(
      script,
      sim([
        { type: "surfaced", at: at(speakAt), item: item("bank trades are 4:1") },
        { type: "surfaced", at: at(okAt), item: item("next phase", { kind: "phase" }) },
        { type: "surfaced", at: at(okAt + 60), item: item("late noise") },
      ]),
      trustingGrader,
    );
    const sum = summarize([s], [script]);
    expect(sum.wanted).toBe(1);
    expect(sum.unwanted).toBe(1);
    expect(sum.precision).toBe(0.5);
    expect(sum.recall).toBe(1);
  });
});

describe("costUsd", () => {
  it("prices cache reads far below fresh input", () => {
    const fresh = costUsd({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, "claude-opus-5-5")!;
    const cached = costUsd({ input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }, "claude-opus-5-5")!;
    expect(fresh).toBeCloseTo(4);
    expect(cached).toBeCloseTo(0.2);
    expect(costUsd(usage, "unknown-model")).toBeNull();
  });
});
