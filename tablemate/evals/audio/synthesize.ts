// Render a table script as a noisy, multi-voice "game night" WAV, plus a ground-truth
// file of who said what when. Used to compare speech-to-text providers without a
// real recording.
//
//   ELEVENLABS_API_KEY=... npm run gamenight                       # default script
//   npm run gamenight -- --script br-catan-ladrao --noise 1.5       # louder room
// Options:
//   --script <id>     script from evals/scripts (default br-gamenight-tm)
//   --noise <x>       room-noise multiplier (default 1)
//   --model <id>      ElevenLabs model (default eleven_multilingual_v2)
//   --voices a,b,c    voice ids to use, in player order (else picked automatically)
//   --offline         placeholder "babble" voices, no API calls (to check timing and noise)
//
// Each spoken line is cached in evals/.cache/tts, so re-rendering with different noise is free.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadScripts } from "../script";
import type { Script } from "../script";
import {
  clink,
  diceRoll,
  encodeWav,
  mixInto,
  normalizePeak,
  pcm16ToFloat,
  rng,
  roomTone,
  SAMPLE_RATE,
} from "./lib";
import type { TruthLine } from "./lib";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EVALS = path.dirname(HERE);
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const API = "https://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = option("model") ?? "eleven_multilingual_v2";
const NOISE = Number(option("noise") ?? 1);
const SCRIPT_ID = option("script") ?? "br-gamenight-tm";
const OFFLINE = args.includes("--offline");

interface Voice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  verified_languages?: { language: string; accent?: string }[];
}

async function eleven(pathname: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { "xi-api-key": KEY!, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${pathname}: ${res.status} ${await res.text()}`);
  return res;
}

/** Pick one distinct voice per player: Portuguese-capable first, alternating genders. */
async function pickVoices(count: number): Promise<Voice[]> {
  const res = await eleven(`/v2/voices?page_size=100`);
  const all = ((await res.json()) as { voices: Voice[] }).voices;
  const pt = (v: Voice) => v.verified_languages?.some((l) => l.language.startsWith("pt")) ?? false;
  const ranked = [...all].sort((a, b) => Number(pt(b)) - Number(pt(a)));
  const byGender = (g: string) => ranked.filter((v) => v.labels?.gender === g);
  const male = byGender("male");
  const female = byGender("female");
  const other = ranked.filter((v) => !male.includes(v) && !female.includes(v));
  const picked: Voice[] = [];
  for (let i = 0; picked.length < count && i < ranked.length; i++) {
    for (const pool of [male, female, other]) if (pool[i] && picked.length < count && !picked.includes(pool[i])) picked.push(pool[i]);
  }
  if (picked.length < count) throw new Error(`Need ${count} voices, found ${picked.length}. Pass --voices.`);
  return picked;
}

/** Offline stand-in for a voice: pitched, syllable-rhythm babble roughly as long as the line. */
function babble(text: string, voiceId: string): Float32Array {
  const rand = rng(createHash("sha256").update(voiceId + text).digest().readUInt32LE(0));
  const pitch = 90 + (createHash("sha256").update(voiceId).digest()[0] / 255) * 160;
  const seconds = Math.max(0.6, text.split(/\s+/).length * 0.32);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const syllable = 0.18 + rand() * 0.06;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.max(0, Math.sin((Math.PI * t) / syllable)) ** 2;
    out[i] = envelope * (0.5 * Math.sin(2 * Math.PI * pitch * t) + 0.25 * Math.sin(2 * Math.PI * pitch * 2.1 * t) + 0.1 * (rand() * 2 - 1));
  }
  return out;
}

async function tts(text: string, voiceId: string): Promise<Float32Array> {
  if (OFFLINE) return babble(text, voiceId);
  const cacheDir = path.join(EVALS, ".cache", "tts");
  const key = createHash("sha256").update(`${MODEL}|${voiceId}|${text}`).digest("hex").slice(0, 16);
  const file = path.join(cacheDir, `${key}.pcm`);
  if (!existsSync(file)) {
    const res = await eleven(`/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL }),
    });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return pcm16ToFloat(readFileSync(file));
}

/** Trim leading/trailing near-silence so line timings reflect actual speech. */
function trim(clip: Float32Array): Float32Array {
  const threshold = 0.01;
  let a = 0;
  let b = clip.length - 1;
  while (a < b && Math.abs(clip[a]) < threshold) a++;
  while (b > a && Math.abs(clip[b]) < threshold) b--;
  return clip.subarray(Math.max(0, a - 160), Math.min(clip.length, b + 160));
}

async function render(script: Script, voices: Voice[]) {
  const rand = rng(42);
  const voiceOf = new Map(script.players.map((p, i) => [p, voices[i]]));
  // Players sit at different distances from the phone.
  const gainOf = new Map(script.players.map((p) => [p, 0.55 + rand() * 0.45]));

  const clips: { who: string; text: string; clip: Float32Array }[] = [];
  for (const [i, line] of script.lines.entries()) {
    const voice = voiceOf.get(line.who);
    if (!voice) throw new Error(`Line ${i}: "${line.who}" isn't in players`);
    process.stdout.write(`\r  voicing line ${i + 1}/${script.lines.length}…`);
    clips.push({ who: line.who, text: line.say, clip: trim(await tts(line.say, voice.voice_id)) });
  }
  process.stdout.write("\n");

  // Lay out on a timeline using the real clip lengths.
  const truth: TruthLine[] = [];
  let t = 0.8;
  script.lines.forEach((line, i) => {
    const dur = clips[i].clip.length / SAMPLE_RATE;
    const jitter = 0.2 + rand() * 0.6;
    const start = i === 0 ? t : line.overlap ? Math.max(0, t - line.overlap) : t + (line.pause ?? jitter);
    truth.push({ who: line.who, text: line.say, start, end: start + dur });
    t = Math.max(t, start + dur);
  });

  const total = Math.ceil((t + 2) * SAMPLE_RATE);
  const mix = roomTone(total, 0.035 * NOISE, rand);
  truth.forEach((line, i) => mixInto(mix, clips[i].clip, Math.round(line.start * SAMPLE_RATE), gainOf.get(line.who)!));

  // Table sounds: dice whenever someone rolls or takes a turn, clinks every so often.
  const events: { kind: string; at: number }[] = [];
  truth.forEach((line) => {
    if (/\b(dado|rol|rolei|minha vez|sua vez)/i.test(line.text)) events.push({ kind: "dice", at: line.end + 0.1 });
  });
  for (let s = 5; s < t; s += 25 + rand() * 30) events.push({ kind: "clink", at: s });
  for (const e of events) {
    const clip = e.kind === "dice" ? diceRoll(rand) : clink(rand);
    mixInto(mix, clip, Math.round(e.at * SAMPLE_RATE), Math.min(1, 0.6 * NOISE));
  }

  normalizePeak(mix, 0.9);
  return { wav: encodeWav(mix), truth, seconds: total / SAMPLE_RATE, events };
}

async function main() {
  if (!KEY && !OFFLINE) throw new Error("Set ELEVENLABS_API_KEY (or pass --offline for placeholder voices).");
  const [script] = loadScripts(path.join(EVALS, "scripts"), [SCRIPT_ID]).filter((s) => s.id === SCRIPT_ID);
  if (!script) throw new Error(`No script "${SCRIPT_ID}".`);

  const given = option("voices")?.split(",").filter(Boolean);
  const voices = given
    ? given.map((id) => ({ voice_id: id, name: id }))
    : OFFLINE
      ? script.players.map((p) => ({ voice_id: `offline-${p}`, name: `babble-${p}` }))
      : await pickVoices(script.players.length);
  console.log(`Voices: ${script.players.map((p, i) => `${p}=${voices[i].name}`).join(", ")}`);

  const { wav, truth, seconds, events } = await render(script, voices);
  const outDir = path.join(EVALS, ".cache", "audio");
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${script.id}${NOISE !== 1 ? `-noise${NOISE}` : ""}${OFFLINE ? "-offline" : ""}`);
  writeFileSync(`${base}.wav`, wav);
  writeFileSync(
    `${base}.truth.json`,
    JSON.stringify(
      { script: script.id, language: script.language, players: script.players, terms: script.terms ?? [], noise: NOISE, model: MODEL,
        voices: Object.fromEntries(script.players.map((p, i) => [p, voices[i].voice_id])), lines: truth, events },
      null,
      2,
    ),
  );
  const overlaps = script.lines.filter((l) => l.overlap).length;
  console.log(`Wrote ${path.relative(process.cwd(), base)}.wav (${seconds.toFixed(0)} s, ${truth.length} lines, ${overlaps} overlapping, ${events.length} table sounds)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
