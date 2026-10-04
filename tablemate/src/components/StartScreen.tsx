"use client";

import { useState } from "react";
import { newSession } from "@/hooks/useTable";
import type { Session } from "@/hooks/useTable";
import type { Experience, GameBrief, GameConfig, Presence, RulebookRef } from "@/lib/types";

export const DEFAULT_WAKE_WORDS = ["tablemate", "table mate", "hey table"];

export const PRESENCE_OPTIONS: { value: Presence; label: string; blurb: string }[] = [
  { value: "quiet", label: "Quiet", blurb: "Answers when asked. Only interrupts for a rule mistake that changes the game." },
  { value: "balanced", label: "Balanced", blurb: "Also steps in when the table is stuck, or a step gets skipped." },
  { value: "guide", label: "Guide", blurb: "For learning a new game: walks you through more and offers gentle tips." },
];

const EXPERIENCE: { value: Experience; label: string }[] = [
  { value: "new", label: "Everyone's new" },
  { value: "mixed", label: "Mixed" },
  { value: "experienced", label: "We know it" },
];

export function StartScreen({ onReady }: { onReady: (s: Session) => void }) {
  const [gameName, setGameName] = useState("");
  const [players, setPlayers] = useState<string[]>([]);
  const [playerDraft, setPlayerDraft] = useState("");
  const [experience, setExperience] = useState<Experience>("mixed");
  const [presence, setPresence] = useState<Presence>("balanced");
  const [voice, setVoice] = useState(true);
  const [rulesMode, setRulesMode] = useState<"none" | "pdf" | "text">("none");
  const [rulesText, setRulesText] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addPlayer() {
    const names = playerDraft
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length) setPlayers((p) => [...p, ...names].slice(0, 12));
    setPlayerDraft("");
  }

  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const roster = [...players, ...playerDraft.split(",").map((n) => n.trim()).filter(Boolean)];
    if (!gameName.trim()) return setError("Which game are you playing?");
    if (roster.length === 0) return setError("Add at least one player.");

    try {
      let rulebook: RulebookRef = { kind: "none" };
      if (rulesMode === "pdf" && pdf) {
        setBusy("Uploading the rulebook…");
        const form = new FormData();
        form.append("file", pdf);
        const res = await fetch("/api/rulebook", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Upload failed");
        rulebook = { kind: "file", fileId: body.fileId, name: body.name };
      } else if (rulesMode === "text" && rulesText.trim()) {
        rulebook = { kind: "text", text: rulesText.trim(), name: `${gameName} rules` };
      }

      const config: GameConfig = { gameName: gameName.trim(), players: roster, experience, rulebook };
      setBusy(rulebook.kind === "none" ? "Recalling the rules…" : "Reading the rulebook…");
      const res = await fetch("/api/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't prepare the game");
      onReady(newSession(config, body.brief as GameBrief, { presence, voice, wakeWords: DEFAULT_WAKE_WORDS }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="wrap">
      <header className="hero stack">
        <h1>Tablemate</h1>
        <p className="muted" style={{ maxWidth: 560 }}>
          Leave it on the table. It listens, keeps track, and speaks up only when it's worth it: a rule you're stuck
          on, a step you skipped, a phase that's starting. Say <strong>"Tablemate…"</strong> any time to ask directly.
        </p>
      </header>

      <form onSubmit={prepare} className="start-grid">
        <section className="card stack">
          <h2>Tonight's game</h2>
          <label className="field">
            Game
            <input
              type="text"
              placeholder="e.g. Terraforming Mars, Wingspan, Root"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              autoFocus
            />
          </label>

          <div className="field stack" style={{ gap: 6 }}>
            <label htmlFor="player-input" style={{ fontWeight: 500 }}>
              Players <span className="hint">in seat order, if you like</span>
            </label>
            {players.length > 0 && (
              <div className="chips">
                {players.map((p, i) => (
                  <span className="chip" key={`${p}-${i}`}>
                    {p}
                    <button type="button" aria-label={`Remove ${p}`} onClick={() => setPlayers(players.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                id="player-input"
                type="text"
                placeholder="Name (or several, comma-separated)"
                value={playerDraft}
                onChange={(e) => setPlayerDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPlayer();
                  }
                }}
              />
              <button type="button" className="btn" onClick={addPlayer}>
                Add
              </button>
            </div>
          </div>

          <div className="field stack" style={{ gap: 6 }}>
            <span style={{ fontWeight: 500 }}>How well does the table know it?</span>
            <div className="segmented" role="group">
              {EXPERIENCE.map((x) => (
                <button type="button" key={x.value} aria-pressed={experience === x.value} onClick={() => setExperience(x.value)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field stack" style={{ gap: 6 }}>
            <span style={{ fontWeight: 500 }}>
              Rulebook <span className="hint">optional, but makes rulings far more reliable</span>
            </span>
            <div className="segmented" role="group">
              <button type="button" aria-pressed={rulesMode === "none"} onClick={() => setRulesMode("none")}>
                From memory
              </button>
              <button type="button" aria-pressed={rulesMode === "pdf"} onClick={() => setRulesMode("pdf")}>
                Upload PDF
              </button>
              <button type="button" aria-pressed={rulesMode === "text"} onClick={() => setRulesMode("text")}>
                Paste text
              </button>
            </div>
            {rulesMode === "pdf" && (
              <input type="file" accept="application/pdf" onChange={(e) => setPdf(e.target.files?.[0] ?? null)} />
            )}
            {rulesMode === "text" && (
              <textarea
                placeholder="Paste the rules, a FAQ, or your house rules"
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
              />
            )}
          </div>
        </section>

        <section className="card stack">
          <h2>How present should it be?</h2>
          <div className="stack" style={{ gap: 4 }} role="radiogroup">
            {PRESENCE_OPTIONS.map((o) => (
              <label key={o.value} className={`option ${presence === o.value ? "selected" : ""}`}>
                <input type="radio" name="presence" checked={presence === o.value} onChange={() => setPresence(o.value)} />
                <span>
                  <strong>{o.label}</strong>
                  <br />
                  <span className="muted small">{o.blurb}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="option">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            <span>
              <strong>Speak answers aloud</strong>
              <br />
              <span className="muted small">
                Direct questions and game-changing corrections are spoken; everything else appears quietly on screen.
              </span>
            </span>
          </label>

          {error && <p className="error">{error}</p>}
          <button className="btn primary" type="submit" disabled={busy !== null} style={{ padding: "12px 16px" }}>
            {busy ? (
              <span className="row" style={{ justifyContent: "center" }}>
                <span className="spinner" /> {busy}
              </span>
            ) : (
              "Prepare the table"
            )}
          </button>
          <p className="muted small">
            Your browser's speech recognition turns audio into text (some browsers use their vendor's cloud for this).
            Tablemate sends Claude text only, and only at moments that look worth checking.
          </p>
        </section>
      </form>
    </main>
  );
}
