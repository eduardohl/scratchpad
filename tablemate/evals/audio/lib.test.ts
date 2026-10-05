import { describe, expect, it } from "vitest";
import {
  decodeWav,
  diceRoll,
  encodeWav,
  mixInto,
  normalizePeak,
  rng,
  roomTone,
  speakerAccuracy,
  termRecall,
  tokensToWords,
  wer,
  words,
} from "./lib";
import type { HypWord, TruthLine } from "./lib";

describe("wav", () => {
  it("round-trips 16-bit mono audio", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const { pcm, sampleRate } = decodeWav(encodeWav(samples, 16000));
    expect(sampleRate).toBe(16000);
    expect(pcm.length).toBe(8);
    expect(pcm.readInt16LE(2)).toBe(Math.round(0.5 * 32767));
  });
});

describe("mixing", () => {
  it("is deterministic for a seed and stays in range after normalizing", () => {
    const a = roomTone(1000, 0.05, rng(1));
    const b = roomTone(1000, 0.05, rng(1));
    expect(Array.from(a)).toEqual(Array.from(b));
    const mix = new Float32Array(16000);
    mixInto(mix, diceRoll(rng(2)), 100, 3);
    normalizePeak(mix, 0.9);
    expect(Math.max(...Array.from(mix).map(Math.abs))).toBeCloseTo(0.9);
  });
});

describe("words / wer", () => {
  it("folds accents, punctuation and laughter", () => {
    expect(words("Não, PODE isso?! kkkkk hahaha")).toEqual(["nao", "pode", "isso", "<laugh>", "<laugh>"]);
  });
  it("computes word error rate", () => {
    expect(wer(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toBe(0);
    expect(wer(["a", "b", "c", "d"], ["a", "x", "c"])).toBe(0.5); // one substitution, one deletion
  });
});

const truth: TruthLine[] = [
  { who: "Edu", text: "vou trocar com o banco", start: 0, end: 2 },
  { who: "Bia", text: "não pode isso", start: 2.5, end: 4 },
];
const w = (text: string, start: number, speaker: string | null): HypWord => ({ text, start, end: start + 0.3, speaker });

describe("speakerAccuracy", () => {
  it("finds the best label mapping regardless of label names", () => {
    const hyp = [w("vou", 0.1, "B"), w("trocar", 0.5, "B"), w("banco", 1.5, "B"), w("não", 2.6, "A"), w("pode", 3, "A")];
    const r = speakerAccuracy(truth, hyp);
    expect(r.accuracy).toBe(1);
    expect(r.mapping).toEqual({ B: "Edu", A: "Bia" });
  });
  it("penalizes words given to the wrong person", () => {
    const hyp = [w("vou", 0.1, "A"), w("trocar", 0.5, "A"), w("não", 2.6, "A"), w("pode", 3, "B")];
    expect(speakerAccuracy(truth, hyp).accuracy).toBe(0.75);
  });
});

describe("termRecall", () => {
  it("counts occurrences of watched terms", () => {
    const t: TruthLine[] = [{ who: "A", text: "o first player faz o draft e depois outro draft", start: 0, end: 3 }];
    expect(termRecall(t, "o first player faz o drafty e depois outro draft", ["first player", "draft"])).toEqual({
      found: 2,
      expected: 3,
      missed: ["draft"],
    });
  });
});

describe("tokensToWords", () => {
  it("joins sub-word tokens into words and keeps the speaker", () => {
    const out = tokensToWords([
      { text: "ter", start_ms: 0, end_ms: 100, speaker: 1 },
      { text: "ra", start_ms: 100, end_ms: 200, speaker: 1 },
      { text: " mars", start_ms: 250, end_ms: 400, speaker: 2 },
      { text: "<end>", start_ms: 400, end_ms: 400 },
    ]);
    expect(out).toEqual([
      { text: "terra", start: 0, end: 0.2, speaker: "1", receivedAt: undefined },
      { text: "mars", start: 0.25, end: 0.4, speaker: "2", receivedAt: undefined },
    ]);
  });
});
