// Stream a synthetic game night to each speech-to-text provider in real time and score
// them on the same audio: word error rate, who-said-what accuracy, English-term recall
// (code-switching), and how fast final words arrive.
//
//   npm run bakeoff                                  # every provider with a key set
//   npm run bakeoff -- --only soniox --file evals/.cache/audio/br-gamenight-tm-noise1.5.wav
//
// Keys: ASSEMBLYAI_API_KEY, SONIOX_API_KEY. Audio is streamed at real speed, so a
// 5-minute game night takes 5 minutes per provider (providers run in parallel).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { decodeWav, percentile, speakerAccuracy, termRecall, tokensToWords, wer, words } from "./lib";
import type { HypWord, TruthLine } from "./lib";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EVALS = path.dirname(HERE);
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Truth {
  script: string;
  language?: string;
  players: string[];
  terms: string[];
  lines: TruthLine[];
}

interface ProviderRun {
  words: HypWord[];
  error?: string;
}

/** Biasing vocabulary: the script's game terms plus the wake word. */
function vocabulary(truth: Truth): string[] {
  return [...new Set([...truth.terms, "Tablemate"])].slice(0, 100);
}

const CONTEXT =
  "A board game night among Brazilian friends, speaking Brazilian Portuguese mixed with English game terms, with jokes and crosstalk.";

/** Send PCM in 100 ms chunks at real-time speed. */
async function pace(pcm: Buffer, sampleRate: number, send: (chunk: Buffer) => void): Promise<void> {
  const bytesPerChunk = Math.floor(sampleRate * 0.1) * 2;
  const started = Date.now();
  for (let i = 0, n = 0; i < pcm.length; i += bytesPerChunk, n++) {
    send(pcm.subarray(i, i + bytesPerChunk));
    const due = started + (n + 1) * 100;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  }
}

// ---- AssemblyAI (Universal-3.6 Pro Streaming, native code-switching) ----------------

async function assemblyai(pcm: Buffer, sampleRate: number, truth: Truth): Promise<ProviderRun> {
  const key = process.env.ASSEMBLYAI_API_KEY!;
  const params = new URLSearchParams({
    sample_rate: String(sampleRate),
    encoding: "pcm_s16le",
    speech_model: "universal-3-6-pro",
    speaker_labels: "true",
    max_speakers: String(Math.min(10, truth.players.length)),
    language_codes: JSON.stringify(["pt", "en"]),
    keyterms_prompt: JSON.stringify(vocabulary(truth)),
    prompt: CONTEXT,
  });
  const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`, { headers: { Authorization: key } });
  const turns = new Map<number, HypWord[]>();
  let t0 = 0;

  return new Promise<ProviderRun>((resolve) => {
    const done = (error?: string) => {
      const all = [...turns.entries()].sort(([a], [b]) => a - b).flatMap(([, w]) => w);
      resolve({ words: all, error });
    };
    ws.on("open", async () => {
      t0 = Date.now();
      await pace(pcm, sampleRate, (chunk) => ws.readyState === WebSocket.OPEN && ws.send(chunk));
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "Turn" && msg.end_of_turn) {
        const receivedAt = (Date.now() - t0) / 1000;
        turns.set(
          msg.turn_order,
          (msg.words ?? []).map((w: { text: string; start: number; end: number; speaker?: string }) => ({
            text: w.text,
            start: w.start / 1000,
            end: w.end / 1000,
            speaker: w.speaker ?? msg.speaker_label ?? null,
            receivedAt,
          })),
        );
      } else if (msg.type === "SpeakerRevision") {
        // Late corrections of who said what; apply them like the app would.
        for (const r of msg.revisions ?? []) {
          const existing = turns.get(r.turn_order);
          if (!existing) continue;
          turns.set(
            r.turn_order,
            existing.map((w) => {
              const revised = (r.words ?? []).find((x: { start: number }) => Math.abs(x.start / 1000 - w.start) < 0.02);
              return { ...w, speaker: revised?.speaker ?? r.speaker_label ?? w.speaker };
            }),
          );
        }
      } else if (msg.type === "Termination") {
        ws.close();
      } else if (msg.error) {
        done(String(msg.error));
      }
    });
    ws.on("close", (code, reason) => done(code >= 4000 ? `closed ${code}: ${reason}` : undefined));
    ws.on("error", (err) => done(err.message));
  });
}

// ---- Soniox (stt-rt-v5, real-time diarization in every language) ---------------------

async function soniox(pcm: Buffer, sampleRate: number, truth: Truth): Promise<ProviderRun> {
  const ws = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");
  const finals: { text: string; start_ms: number; end_ms: number; speaker?: string | number; receivedAt: number }[] = [];
  let t0 = 0;

  return new Promise<ProviderRun>((resolve) => {
    let settled = false;
    const done = (error?: string) => {
      if (settled) return;
      settled = true;
      resolve({ words: tokensToWords(finals), error });
    };
    ws.on("open", async () => {
      ws.send(
        JSON.stringify({
          api_key: process.env.SONIOX_API_KEY,
          model: "stt-rt-v5",
          audio_format: "pcm_s16le",
          sample_rate: sampleRate,
          num_channels: 1,
          language_hints: ["pt", "en"],
          enable_language_identification: true,
          enable_speaker_diarization: true,
          context: {
            general: [
              { key: "domain", value: "board games" },
              { key: "topic", value: CONTEXT },
            ],
            terms: vocabulary(truth),
          },
        }),
      );
      t0 = Date.now();
      await pace(pcm, sampleRate, (chunk) => ws.readyState === WebSocket.OPEN && ws.send(chunk));
      if (ws.readyState === WebSocket.OPEN) ws.send(""); // end of audio
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.error_code) return done(`${msg.error_code}: ${msg.error_message}`);
      const receivedAt = (Date.now() - t0) / 1000;
      for (const t of msg.tokens ?? []) if (t.is_final) finals.push({ ...t, receivedAt });
      if (msg.finished) {
        ws.close();
        done();
      }
    });
    ws.on("close", () => done());
    ws.on("error", (err) => done(err.message));
  });
}

const PROVIDERS = {
  assemblyai: { run: assemblyai, key: "ASSEMBLYAI_API_KEY", usdPerHour: 0.45 + 0.12 },
  soniox: { run: soniox, key: "SONIOX_API_KEY", usdPerHour: 0.12 },
} as const;

// ---- main --------------------------------------------------------------------------------

function score(truth: Truth, run: ProviderRun) {
  const hypText = run.words.map((w) => w.text).join(" ");
  const ref = truth.lines
    .slice()
    .sort((a, b) => a.start - b.start)
    .flatMap((l) => words(l.text));
  const spk = speakerAccuracy(truth.lines, run.words);
  const lag = run.words.filter((w) => w.receivedAt !== undefined).map((w) => w.receivedAt! - w.end);
  return {
    wer: wer(ref, words(hypText)),
    speakerAccuracy: spk.accuracy,
    speakersFound: spk.labelsSeen,
    mapping: spk.mapping,
    terms: termRecall(truth.lines, hypText, truth.terms),
    lagP50: percentile(lag, 50),
    lagP90: percentile(lag, 90),
    words: run.words.length,
    transcript: hypText,
    error: run.error,
  };
}

async function main() {
  const file = option("file") ?? path.join(EVALS, ".cache", "audio", "br-gamenight-tm.wav");
  const truth = JSON.parse(readFileSync(file.replace(/\.wav$/, ".truth.json"), "utf8")) as Truth;
  const { pcm, sampleRate } = decodeWav(readFileSync(file));
  const minutes = pcm.length / 2 / sampleRate / 60;

  const only = option("only")?.split(",");
  const chosen = Object.entries(PROVIDERS).filter(([name, p]) => (!only || only.includes(name)) && process.env[p.key]);
  if (chosen.length === 0) {
    throw new Error(`No provider keys set. Set any of: ${Object.values(PROVIDERS).map((p) => p.key).join(", ")}`);
  }
  console.log(`Streaming ${minutes.toFixed(1)} min of audio (${truth.players.length} players) to ${chosen.map(([n]) => n).join(", ")} in real time…`);

  const results = await Promise.all(
    chosen.map(async ([name, p]) => [name, score(truth, await p.run(pcm, sampleRate, truth)), p.usdPerHour] as const),
  );

  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const sec = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)} s`);
  console.log("");
  console.log("provider     WER      speaker acc  speakers  game terms  lag p50  lag p90  ~$/hour");
  for (const [name, r, usd] of results) {
    console.log(
      [
        name.padEnd(12),
        pct(r.wer).padEnd(8),
        pct(r.speakerAccuracy).padEnd(12),
        `${r.speakersFound}/${truth.players.length}`.padEnd(9),
        `${r.terms.found}/${r.terms.expected}`.padEnd(11),
        sec(r.lagP50).padEnd(8),
        sec(r.lagP90).padEnd(8),
        `$${usd.toFixed(2)}`,
      ].join(" "),
    );
    if (r.error) console.log(`  error: ${r.error}`);
    if (r.terms.missed.length) console.log(`  missed terms: ${r.terms.missed.join(", ")}`);
  }
  console.log("\nLower WER and lag are better; higher speaker accuracy and game terms are better.");
  console.log("Prices are list estimates; check your provider dashboard.");

  const outDir = path.join(EVALS, "results");
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `bakeoff-${truth.script}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ file, results: Object.fromEntries(results.map(([n, r]) => [n, r])) }, null, 2));
  console.log(`Full transcripts: ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
