"use client";

// One panel per phase. Each is the "board" the table glances at; Tablemate keeps them
// current from what it hears, and everything can also be adjusted by hand.

import { useState } from "react";
import type { Session } from "@/hooks/useTable";
import type { Phase } from "@/lib/types";

interface PanelProps {
  session: Session;
  actions: {
    toggleSetup: (id: string) => void;
    setPhase: (p: Phase) => void;
    setRound: (r: number | null) => void;
    setActivePlayer: (p: string | null) => void;
    setScore: (player: string, category: string, value: number | null) => void;
    readAloud: (text: string) => void;
    recap: () => void;
  };
}

export function SetupPanel({ session, actions }: PanelProps) {
  const { setupSteps, caveat, rulesConfidence } = session.brief;
  const done = new Set(session.state.completedSetup);
  const count = setupSteps.filter((s) => done.has(s.id)).length;
  const next = setupSteps.find((s) => !done.has(s.id));

  return (
    <section className="card stack">
      <div className="row">
        <h2>Set up for {session.config.players.length}</h2>
        <span className="spacer" />
        <span className="muted small">
          {count}/{setupSteps.length}
        </span>
      </div>
      <div className="progress" aria-hidden>
        <div style={{ width: `${setupSteps.length ? (100 * count) / setupSteps.length : 0}%` }} />
      </div>
      {(rulesConfidence !== "high" || caveat) && (
        <p className="banner">
          {rulesConfidence === "low" && "I don't know this game well. Add a rulebook for reliable help. "}
          {caveat}
        </p>
      )}
      <ul className="checklist">
        {setupSteps.map((s) => (
          <li key={s.id} className={done.has(s.id) ? "done" : ""}>
            <input
              type="checkbox"
              id={`setup-${s.id}`}
              checked={done.has(s.id)}
              onChange={() => actions.toggleSetup(s.id)}
            />
            <label htmlFor={`setup-${s.id}`} className="stack" style={{ gap: 2, cursor: "pointer" }}>
              <span className="text">{s.text}</span>
              {s.detail && next?.id === s.id && <span className="detail">{s.detail}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <span className="muted small">Say what you've done ("cards are dealt") and I'll tick it off.</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => actions.setPhase("teach")}>
          {count === setupSteps.length ? "All set, teach the rules" : "Skip to the rules"}
        </button>
      </div>
    </section>
  );
}

export function TeachPanel({ session, actions }: PanelProps) {
  const { teach, oneLiner } = session.brief;
  const [i, setI] = useState(0);
  const section = teach[i];
  if (!section) return null;
  const last = i === teach.length - 1;

  return (
    <section className="card stack teach-card">
      <div className="row">
        <span className="muted small">
          Teach · {i + 1} of {teach.length}
        </span>
        <span className="spacer" />
        <div className="dots" aria-hidden>
          {teach.map((t, j) => (
            <span key={t.id} className={j <= i ? "on" : ""} />
          ))}
        </div>
      </div>
      {i === 0 && <p className="muted">{oneLiner}</p>}
      <h2>{section.title}</h2>
      <ul>
        {section.points.map((p, j) => (
          <li key={j}>{p}</li>
        ))}
      </ul>
      <span className="spacer" />
      <div className="row">
        <button className="btn ghost" onClick={() => actions.readAloud(`${section.title}. ${section.points.join(". ")}`)}>
          Read aloud
        </button>
        <span className="spacer" />
        <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>
          Back
        </button>
        {last ? (
          <button className="btn primary" onClick={() => actions.setPhase("play")}>
            Start playing
          </button>
        ) : (
          <button className="btn primary" onClick={() => setI(i + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}

export function PlayPanel({ session, actions }: PanelProps) {
  const { state, brief, config } = session;
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
          <div className="stat">
            <span className="label">Round</span>
            <div className="stepper">
              <button aria-label="Previous round" onClick={() => actions.setRound(Math.max(1, (state.round ?? 1) - 1))}>
                −
              </button>
              <span className="val">{state.round ?? "–"}</span>
              <button aria-label="Next round" onClick={() => actions.setRound((state.round ?? 0) + 1)}>
                +
              </button>
            </div>
          </div>
          <div className="stat" style={{ flex: 1, minWidth: 200 }}>
            <span className="label">Whose turn</span>
            <div className="player-pills">
              {config.players.map((p) => (
                <button key={p} aria-pressed={state.activePlayer === p} onClick={() => actions.setActivePlayer(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card stack">
        <h3>On your turn</h3>
        <ol className="ref-list">
          {brief.turnStructure.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {brief.roundEnd.length > 0 && (
          <>
            <h3>Between rounds</h3>
            <ul className="ref-list">
              {brief.roundEnd.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        )}
        <p className="small">
          <strong>Game ends when:</strong> {brief.endTrigger}
        </p>
      </section>

      {brief.commonMistakes.length > 0 && (
        <details className="card">
          <summary style={{ cursor: "pointer" }}>
            <strong>Easy to get wrong</strong>
          </summary>
          <ul className="ref-list" style={{ marginTop: 8 }}>
            {brief.commonMistakes.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}

      {state.log.length > 0 && (
        <section className="card stack">
          <h3>Game log</h3>
          <ul className="log">
            {state.log
              .slice()
              .reverse()
              .map((l, i) => (
                <li key={i}>{l}</li>
              ))}
          </ul>
        </section>
      )}

      <div className="row">
        <span className="spacer" />
        <button className="btn" onClick={() => actions.setPhase("wrapup")}>
          Game over? Go to scoring
        </button>
      </div>
    </div>
  );
}

export function WrapupPanel({ session, actions }: PanelProps) {
  const { brief, config, state } = session;
  const categories = brief.scoring.length ? brief.scoring : [{ id: "total", name: "Points", howTo: "" }];
  const totals = Object.fromEntries(
    config.players.map((p) => [p, Object.values(state.scores[p] ?? {}).reduce((a, b) => a + b, 0)]),
  );
  const anyScores = Object.values(state.scores).some((r) => Object.keys(r).length > 0);
  const best = Math.max(...Object.values(totals));

  return (
    <div className="stack">
      <section className="card stack">
        <h2>Final scoring</h2>
        <p className="muted small">Go category by category. Call out scores and I'll keep the tally honest, or type them in.</p>
        <div className="scores-wrap">
          <table className="scores">
            <thead>
              <tr>
                <th>Category</th>
                {config.players.map((p) => (
                  <th key={p}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td title={c.howTo}>
                    {c.name}
                    {c.howTo && <div className="muted small">{c.howTo}</div>}
                  </td>
                  {config.players.map((p) => (
                    <td key={p}>
                      <input
                        type="number"
                        inputMode="numeric"
                        aria-label={`${p} ${c.name}`}
                        value={state.scores[p]?.[c.id] ?? ""}
                        onChange={(e) =>
                          actions.setScore(p, c.id, e.target.value === "" ? null : Number(e.target.value))
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                {config.players.map((p) => (
                  <td key={p} className={anyScores && totals[p] === best ? "winner" : ""}>
                    {totals[p]}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="card stack">
        <div className="row">
          <h3>Recap</h3>
          <span className="spacer" />
          <button className="btn" onClick={actions.recap}>
            {session.recap ? "Rewrite" : "Write the recap"}
          </button>
        </div>
        {session.recap ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{session.recap}</p>
        ) : (
          <p className="muted small">A short story of tonight's game, from what I heard.</p>
        )}
      </section>
    </div>
  );
}
