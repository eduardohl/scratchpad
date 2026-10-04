import { describe, expect, it } from "vitest";
import { admit, confidenceThreshold, detectCues, detectWake, shouldCheck, windowTranscript } from "./gate";
import type { AdmitContext, CheckContext } from "./gate";
import type { Intervention, Utterance } from "./types";

const WAKE = ["tablemate", "table mate"];

describe("detectWake", () => {
  it("matches a leading wake word and strips it", () => {
    expect(detectWake("Hey Tablemate, can I trade twice?", WAKE)).toEqual({
      addressed: true,
      rest: "can i trade twice",
    });
  });
  it("matches a two-word wake phrase", () => {
    expect(detectWake("table mate how many cards do I draw", WAKE).addressed).toBe(true);
  });
  it("matches a short trailing address", () => {
    expect(detectWake("is that legal tablemate", WAKE)).toEqual({ addressed: true, rest: "is that legal" });
  });
  it("ignores passing mentions mid-sentence", () => {
    expect(detectWake("I was reading about tablemate and other apps last week", WAKE).addressed).toBe(false);
  });
  it("ignores unrelated speech", () => {
    expect(detectWake("pass me the dice", WAKE).addressed).toBe(false);
  });
});

describe("detectCues", () => {
  it("spots rule uncertainty without punctuation", () => {
    expect(detectCues("wait can you build on a port")).toContain("rule-question");
    expect(detectCues("I don't remember if robbers block that")).toContain("rule-question");
  });
  it("spots phase changes", () => {
    expect(detectCues("ok that's the last round")).toContain("phase-change");
    expect(detectCues("alright let's start")).toContain("phase-change");
  });
  it("stays silent on table banter", () => {
    expect(detectCues("who wants more pizza")).toEqual([]);
    expect(detectCues("nice move")).toEqual([]);
  });
  it("does not match cue fragments inside other words", () => {
    expect(detectCues("the canine ate my meeple")).toEqual([]);
  });
});

const u = (text: string, at: number, typed = false): Utterance => ({ id: `${at}`, text, at, typed });

function checkCtx(over: Partial<CheckContext>): CheckContext {
  return {
    pending: [],
    lastCheckAt: 0,
    lastSpeechAt: 0,
    speaking: false,
    now: 100_000,
    phase: "play",
    presence: "balanced",
    ...over,
  };
}

describe("shouldCheck", () => {
  it("waits while the table is still talking", () => {
    const d = shouldCheck(checkCtx({ pending: [u("can I do that", 99_500)], lastSpeechAt: 99_500 }));
    expect(d.check).toBe(false);
  });
  it("checks after a pause when someone sounds unsure", () => {
    const d = shouldCheck(checkCtx({ pending: [u("can I do that", 90_000)], lastSpeechAt: 90_000, lastCheckAt: 80_000 }));
    expect(d.check).toBe(true);
  });
  it("does not spam calls", () => {
    const d = shouldCheck(checkCtx({ pending: [u("can I do that", 98_000)], lastSpeechAt: 98_000, lastCheckAt: 97_000 }));
    expect(d.check).toBe(false);
  });
  it("ignores banter until the sweep interval", () => {
    const pending = [u("pizza", 95_000), u("ha", 96_000)];
    expect(shouldCheck(checkCtx({ pending, lastSpeechAt: 96_000, lastCheckAt: 70_000 })).check).toBe(false);
    expect(shouldCheck(checkCtx({ pending, lastSpeechAt: 96_000, lastCheckAt: 30_000 })).check).toBe(true);
  });
});

function iv(over: Partial<Intervention>): Intervention {
  return {
    id: "x",
    kind: "correction",
    urgency: "normal",
    confidence: 0.9,
    message: "Only one trade per turn.",
    topicKey: "trade-limit",
    at: 0,
    ...over,
  };
}

function admitCtx(over: Partial<AdmitContext>): AdmitContext {
  return {
    presence: "balanced",
    voice: true,
    phase: "play",
    now: 1_000_000,
    lastUnsolicitedAt: 0,
    recentTopics: {},
    dismissStreak: 0,
    ...over,
  };
}

describe("admit", () => {
  it("always answers direct questions", () => {
    expect(admit(iv({ direct: true, confidence: 0.1 }), admitCtx({})).delivery).toBe("voice");
    expect(admit(iv({ direct: true }), admitCtx({ voice: false })).delivery).toBe("card");
  });
  it("shows a confident correction as a card, not a voice, unless high urgency", () => {
    expect(admit(iv({}), admitCtx({})).delivery).toBe("card");
    expect(admit(iv({ urgency: "high" }), admitCtx({})).delivery).toBe("voice");
  });
  it("never repeats a topic", () => {
    const d = admit(iv({}), admitCtx({ recentTopics: { "trade-limit": 1_000_000 - 60_000 } }));
    expect(d.delivery).toBe("drop");
  });
  it("demotes to a badge during the cooldown", () => {
    expect(admit(iv({}), admitCtx({ lastUnsolicitedAt: 1_000_000 - 10_000 })).delivery).toBe("badge");
  });
  it("lets high urgency through the cooldown", () => {
    expect(admit(iv({ urgency: "high" }), admitCtx({ lastUnsolicitedAt: 1_000_000 - 10_000 })).delivery).toBe("voice");
  });
  it("keeps tips out of the way unless in guide mode", () => {
    expect(admit(iv({ kind: "tip" }), admitCtx({})).delivery).toBe("badge");
    expect(admit(iv({ kind: "tip" }), admitCtx({ presence: "guide" })).delivery).toBe("card");
  });
  it("quiet mode only interrupts for high-stakes corrections", () => {
    expect(admit(iv({}), admitCtx({ presence: "quiet" })).delivery).toBe("badge");
    expect(admit(iv({ urgency: "high", confidence: 0.95 }), admitCtx({ presence: "quiet" })).delivery).toBe("voice");
  });
  it("gets more reserved after dismissals", () => {
    expect(confidenceThreshold("balanced", 0)).toBeCloseTo(0.7);
    expect(confidenceThreshold("balanced", 3)).toBeCloseTo(0.85);
    expect(admit(iv({ confidence: 0.75 }), admitCtx({ dismissStreak: 2 })).delivery).toBe("badge");
  });
  it("drops guesses outright", () => {
    expect(admit(iv({ confidence: 0.3 }), admitCtx({})).delivery).toBe("drop");
  });
});

describe("windowTranscript", () => {
  it("splits seen from new", () => {
    const all = [u("a", 1), u("b", 2), u("c", 3)];
    const { earlier, recent } = windowTranscript(all, 2);
    expect(earlier.map((x) => x.text)).toEqual(["a", "b"]);
    expect(recent.map((x) => x.text)).toEqual(["c"]);
  });
});
