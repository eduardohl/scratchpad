"use client";

// Continuous listening with the browser's Web Speech API.
// It's free and low-latency, but browser support varies (best in Chrome/Edge, OK in Safari)
// and recognition sessions end on their own every so often, so we restart them.

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings; the Web Speech API isn't in TypeScript's DOM lib.
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent {
  error: string;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface SpeechOptions {
  onFinal: (text: string) => void;
  lang?: string;
  /** While true, results are discarded (e.g. Tablemate is talking and would hear itself). */
  mutedRef?: React.RefObject<boolean>;
}

export function useSpeech({ onFinal, lang = "en-US", mutedRef }: SpeechOptions) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<Recognition | null>(null);
  const wantRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => setSupported(getCtor() !== null), []);

  const startRecognition = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onresult = (e) => {
      if (mutedRef?.current) return;
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) onFinalRef.current(text);
        else pending += `${text} `;
      }
      lastSpeechAtRef.current = Date.now();
      setInterim(pending.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantRef.current = false;
        setError("Microphone access was blocked. Allow it in the browser to let Tablemate listen.");
      } else {
        setError(`Speech recognition error: ${e.error}`);
      }
    };
    rec.onend = () => {
      setInterim("");
      if (wantRef.current) {
        // Sessions time out on their own; quietly pick back up.
        setTimeout(() => wantRef.current && startRecognition(), 250);
      } else {
        setListening(false);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setError(null);
    } catch {
      // start() throws if a session is already running; onend will restart us.
    }
  }, [lang, mutedRef]);

  const start = useCallback(() => {
    wantRef.current = true;
    startRecognition();
  }, [startRecognition]);

  const stop = useCallback(() => {
    wantRef.current = false;
    recRef.current?.stop();
    setListening(false);
    setInterim("");
  }, []);

  useEffect(() => () => {
    wantRef.current = false;
    recRef.current?.abort();
  }, []);

  return { supported, listening, interim, error, start, stop, lastSpeechAtRef };
}

/** Speak text aloud; resolves when finished. */
export function speak(text: string, lang = "en-US"): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.05;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

/** A soft two-note chime, so a card appearing doesn't go unnoticed. */
export function chime() {
  if (typeof window === "undefined") return;
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.06, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // Audio may be blocked until a user gesture; the card still shows.
  }
}
