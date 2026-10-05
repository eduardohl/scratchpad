// Pure helpers for the synthetic game night and the speech-to-text bake-off:
// WAV I/O, mixing, table noise, word error rate and speaker-attribution scoring.

import { normalize } from "../../src/lib/gate";

export const SAMPLE_RATE = 16_000;

// ---- WAV --------------------------------------------------------------------

/** 16-bit mono PCM (little-endian) → floats in [-1, 1]. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

export function floatToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = floatToPcm16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Returns the raw PCM16 payload and sample rate of a mono 16-bit WAV. */
export function decodeWav(file: Buffer): { pcm: Buffer; sampleRate: number } {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const channels = file.readUInt16LE(offset + 10);
      const bits = file.readUInt16LE(offset + 22);
      sampleRate = file.readUInt32LE(offset + 12);
      if (channels !== 1 || bits !== 16) throw new Error("Expected mono 16-bit WAV");
    }
    if (id === "data") return { pcm: file.subarray(offset + 8, offset + 8 + size), sampleRate };
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

// ---- Mixing and table noise --------------------------------------------------

/** Deterministic PRNG so the same script always renders the same game night. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mixInto(dest: Float32Array, clip: Float32Array, atSample: number, gain: number) {
  const n = Math.min(clip.length, dest.length - atSample);
  for (let i = 0; i < n; i++) dest[atSample + i] += clip[i] * gain;
}

/** Room tone: pink-ish noise (Paul Kellet's filter) at the given level. */
export function roomTone(length: number, level: number, rand: () => number): Float32Array {
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = (b0 + b1 + b2 + white * 0.1848) * 0.1 * level;
  }
  return out;
}

/** Dice rattling on a table: a burst of short clicks. */
export function diceRoll(rand: () => number, sampleRate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * 0.7));
  const clicks = 6 + Math.floor(rand() * 6);
  for (let c = 0; c < clicks; c++) {
    const at = Math.floor(rand() * (out.length - 400));
    const amp = 0.25 + rand() * 0.35;
    for (let i = 0; i < 300; i++) out[at + i] += (rand() * 2 - 1) * amp * Math.exp(-i / 40);
  }
  return out;
}

/** A glass or bottle clink: a couple of decaying high partials. */
export function clink(rand: () => number, sampleRate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * 0.5));
  const f = 2500 + rand() * 1500;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 2.7 * t)) * 0.15 * Math.exp(-t * 9);
  }
  return out;
}

/** Scale so the loudest sample sits at `peak`. */
export function normalizePeak(samples: Float32Array, peak = 0.9): void {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max === 0) return;
  const g = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] *= g;
}

// ---- Scoring -------------------------------------------------------------------

export interface TruthLine {
  who: string;
  text: string;
  start: number; // seconds
  end: number;
}

export interface HypWord {
  text: string;
  start: number; // seconds of audio
  end: number;
  speaker: string | null;
  /** Seconds after the audio stream started that this final word arrived. */
  receivedAt?: number;
}

/** Words for WER: accents folded, punctuation dropped, laughter collapsed. */
export function words(text: string): string[] {
  return normalize(text)
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^(ha)+h?$|^(k)+$|^(he)+$/.test(w) ? "<laugh>" : w));
}

/** Word error rate: (substitutions + deletions + insertions) / reference length. */
export function wer(reference: string[], hypothesis: string[]): number {
  if (reference.length === 0) return hypothesis.length ? 1 : 0;
  let prev = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      const sub = prev[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      cur.push(Math.min(sub, prev[j] + 1, cur[j - 1] + 1));
    }
    prev = cur;
  }
  return prev[hypothesis.length] / reference.length;
}

/**
 * How often words are attributed to the right person. Diarization labels are arbitrary
 * ("A", "1"), so first find the best one-to-one mapping from labels to players, then
 * count words whose label maps to whoever was actually speaking at that moment.
 */
export function speakerAccuracy(truth: TruthLine[], hyp: HypWord[]): {
  accuracy: number | null;
  mapping: Record<string, string>;
  labelsSeen: number;
  attributedWords: number;
} {
  const counts = new Map<string, Map<string, number>>();
  let total = 0;
  for (const w of hyp) {
    if (!w.speaker) continue;
    const mid = (w.start + w.end) / 2;
    const candidates = truth.filter((l) => l.start - 0.25 <= mid && mid <= l.end + 0.25);
    if (candidates.length === 0) continue;
    const norm = words(w.text)[0];
    // During crosstalk prefer the line that actually contains this word.
    const line = candidates.find((l) => norm && words(l.text).includes(norm)) ?? candidates[0];
    const row = counts.get(w.speaker) ?? new Map<string, number>();
    row.set(line.who, (row.get(line.who) ?? 0) + 1);
    counts.set(w.speaker, row);
    total++;
  }
  // Greedy assignment by largest overlap; exact enough for ≤ 10 labels.
  const pairs = [...counts].flatMap(([label, row]) => [...row].map(([who, n]) => ({ label, who, n })));
  pairs.sort((a, b) => b.n - a.n);
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  let correct = 0;
  for (const p of pairs) {
    if (p.label in mapping || used.has(p.who)) continue;
    mapping[p.label] = p.who;
    used.add(p.who);
    correct += p.n;
  }
  return { accuracy: total ? correct / total : null, mapping, labelsSeen: counts.size, attributedWords: total };
}

/** How many occurrences of each watched term (e.g. English game terms) made it into the transcript. */
export function termRecall(truth: TruthLine[], hypText: string, terms: string[]): { found: number; expected: number; missed: string[] } {
  const ref = normalize(truth.map((l) => l.text).join(" "));
  const hyp = normalize(hypText);
  let found = 0;
  let expected = 0;
  const missed: string[] = [];
  for (const term of terms) {
    const t = normalize(term).trim();
    const count = (s: string) => s.split(` ${t} `).length - 1;
    const want = count(ref);
    const got = Math.min(want, count(hyp));
    expected += want;
    found += got;
    if (got < want) missed.push(term);
  }
  return { found, expected, missed };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * Soniox streams sub-word tokens (" ter", "ra", "forming"). Rebuild words: a token that
 * starts with a space begins a new word.
 */
export function tokensToWords(
  tokens: { text: string; start_ms: number; end_ms: number; speaker?: string | number; receivedAt?: number }[],
): HypWord[] {
  const out: HypWord[] = [];
  for (const t of tokens) {
    if (!t.text || t.text.startsWith("<")) continue; // control tokens like <end>
    const startsWord = out.length === 0 || /^\s/.test(t.text);
    const speaker = t.speaker === undefined || t.speaker === null ? null : String(t.speaker);
    if (startsWord) {
      out.push({ text: t.text.trim(), start: t.start_ms / 1000, end: t.end_ms / 1000, speaker, receivedAt: t.receivedAt });
    } else {
      const w = out[out.length - 1];
      w.text += t.text;
      w.end = t.end_ms / 1000;
      w.receivedAt = t.receivedAt ?? w.receivedAt;
    }
  }
  return out.filter((w) => w.text.length > 0);
}
