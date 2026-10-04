"use client";

import { useEffect, useState } from "react";
import { useTable } from "@/hooks/useTable";
import type { Activity, FeedItem, Session } from "@/hooks/useTable";
import { PHASES } from "@/lib/types";
import type { Phase, Presence } from "@/lib/types";
import { PlayPanel, SetupPanel, TeachPanel, WrapupPanel } from "./Panels";
import { PRESENCE_OPTIONS } from "./StartScreen";

const PHASE_LABEL: Record<Phase, string> = { setup: "Setup", teach: "Rules", play: "Play", wrapup: "Wrap-up" };
const KIND_LABEL: Record<FeedItem["kind"], string> = {
  answer: "Answer",
  correction: "Rule check",
  reminder: "Reminder",
  phase: "Next up",
  teach: "Rules",
  tip: "Tip",
};

export function TableView({ initial, onNewGame }: { initial: Session; onNewGame: () => void }) {
  const { session, activity, phaseNotice, apiError, speech, actions } = useTable(initial);
  const { state, brief, settings } = session;

  const Panel = { setup: SetupPanel, teach: TeachPanel, play: PlayPanel, wrapup: WrapupPanel }[state.phase];

  return (
    <>
      <header className="topbar">
        <div className="wrap stack" style={{ gap: 8 }}>
          <div className="row">
            <h1 style={{ fontSize: "1.35rem" }}>{brief.title}</h1>
            <span className="spacer" />
            <PresenceIndicator activity={activity} listening={speech.listening} hearing={speech.interim !== ""} />
            <button className="btn ghost sm" onClick={() => confirm("End this game and start a new one?") && onNewGame()}>
              New game
            </button>
          </div>
          <nav className="phases" aria-label="Game phase">
            {PHASES.map((p, i) => (
              <button key={p} aria-current={state.phase === p ? "step" : undefined} onClick={() => actions.setPhase(p)}>
                <span className="n">{i + 1}</span>
                {PHASE_LABEL[p]}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="wrap layout">
        <div className="stack">
          {phaseNotice && (
            <div className="notice" role="status">
              <span>
                Sounds like you've moved on to <strong>{PHASE_LABEL[phaseNotice.to]}</strong>.
              </span>
              <span className="spacer" />
              <button className="btn sm" onClick={actions.undoPhase}>
                Undo
              </button>
              <button className="btn ghost sm" aria-label="Dismiss" onClick={actions.dismissPhaseNotice}>
                ✕
              </button>
            </div>
          )}
          <Panel session={session} actions={actions} />
        </div>

        <aside className="side stack">
          <Companion session={session} actions={actions} />
          {speech.error && <p className="error">{speech.error}</p>}
          {apiError && <p className="error">{apiError}</p>}
          {!speech.supported && (
            <p className="banner">
              This browser can't transcribe speech. Try Chrome, Edge or Safari, or type into the bar below.
            </p>
          )}
          <SettingsCard
            presence={settings.presence}
            voice={settings.voice}
            onPresence={(presence) => actions.setSettings({ presence })}
            onVoice={(voice) => actions.setSettings({ voice })}
          />
          <Transcript session={session} />
        </aside>
      </main>

      <Toast item={session.feed.at(-1)} />

      <AskBar
        listening={speech.listening}
        supported={speech.supported}
        interim={speech.interim}
        onMic={() => (speech.listening ? speech.stop() : speech.start())}
        onSubmit={(text) => actions.hear(text, true)}
      />
    </>
  );
}

/** Phone-only: show the newest nudge for a little while so it isn't buried below the board. */
function Toast({ item }: { item: FeedItem | undefined }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  if (!item || hidden === item.id || now - item.at > 25_000) return null;
  return (
    <div className="toast">
      <article className={`card stack nudge ${item.kind}`} style={{ gap: 4 }}>
        <div className="row">
          <span className="kind">{item.direct ? "You asked" : KIND_LABEL[item.kind]}</span>
          <span className="spacer" />
          <button className="btn ghost sm" aria-label="Hide" onClick={() => setHidden(item.id)}>
            Hide
          </button>
        </div>
        <p className="msg">{item.message || <span className="spinner" style={{ display: "inline-block" }} />}</p>
      </article>
    </div>
  );
}

function PresenceIndicator({ activity, listening, hearing }: { activity: Activity; listening: boolean; hearing: boolean }) {
  const thinking = activity.kind === "checking" || activity.kind === "answering";
  const cls = thinking ? "thinking" : listening ? `listening ${hearing ? "hearing" : ""}` : "";
  const label = thinking
    ? activity.kind === "answering"
      ? "Answering…"
      : "Thinking…"
    : listening
      ? "Listening"
      : "Paused";
  return (
    <span className="presence small muted" title={activity.kind === "checking" ? activity.reason : undefined}>
      <span className={`orb ${cls}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function Companion({ session, actions }: { session: Session; actions: ReturnType<typeof useTable>["actions"] }) {
  const [showTips, setShowTips] = useState(false);
  const feed = session.feed.slice(-6).reverse();

  return (
    <section className="stack" aria-live="polite">
      {session.tips.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="tips-toggle" onClick={() => setShowTips(!showTips)} aria-expanded={showTips}>
            💡 {session.tips.length} quiet {session.tips.length === 1 ? "thought" : "thoughts"}
          </button>
          {showTips && (
            <div className="card stack" style={{ gap: 8 }}>
              {session.tips
                .slice()
                .reverse()
                .map((t) => (
                  <div key={t.id} className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                    <span className="small" style={{ flex: 1 }}>
                      {t.message}
                    </span>
                    <button className="btn ghost sm" onClick={() => actions.promoteTip(t.id)}>
                      Pin
                    </button>
                  </div>
                ))}
              <button className="btn ghost sm" onClick={actions.clearTips}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      <div className="feed">
        {feed.length === 0 && (
          <div className="card muted small">
            I'm here if you need me. Say <strong>"Tablemate"</strong> and your question, or just play. I'll chime in
            only if something matters.
          </div>
        )}
        {feed.map((f) => (
          <article key={f.id} className={`card stack nudge ${f.kind}`} style={{ gap: 6 }}>
            <span className="kind">{f.direct ? "You asked" : KIND_LABEL[f.kind]}</span>
            {f.question && <p className="q">“{f.question}”</p>}
            <p className="msg">{f.message || <span className="spinner" style={{ display: "inline-block" }} />}</p>
            {!f.streaming && (
              <div className="actions">
                <button
                  className="btn ghost sm"
                  aria-pressed={f.feedback === "up"}
                  aria-label="Helpful"
                  onClick={() => actions.feedback(f.id, true)}
                >
                  👍
                </button>
                {!f.direct && (
                  <button
                    className="btn ghost sm"
                    aria-pressed={f.feedback === "down"}
                    title="Not helpful: I'll be more reserved"
                    onClick={() => actions.feedback(f.id, false)}
                  >
                    Not now
                  </button>
                )}
                <button className="btn ghost sm" aria-label="Dismiss" onClick={() => actions.dismiss(f.id)}>
                  ✕
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsCard(props: {
  presence: Presence;
  voice: boolean;
  onPresence: (p: Presence) => void;
  onVoice: (v: boolean) => void;
}) {
  return (
    <details className="card">
      <summary style={{ cursor: "pointer" }} className="small">
        Presence: <strong>{PRESENCE_OPTIONS.find((o) => o.value === props.presence)?.label}</strong>
        {props.voice ? " · speaks aloud" : " · silent"}
      </summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <div className="segmented" role="group" aria-label="Presence">
          {PRESENCE_OPTIONS.map((o) => (
            <button key={o.value} aria-pressed={props.presence === o.value} onClick={() => props.onPresence(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="muted small">{PRESENCE_OPTIONS.find((o) => o.value === props.presence)?.blurb}</p>
        <label className="row small">
          <input type="checkbox" checked={props.voice} onChange={(e) => props.onVoice(e.target.checked)} />
          Speak answers aloud
        </label>
      </div>
    </details>
  );
}

function Transcript({ session }: { session: Session }) {
  const items = session.utterances.slice(-60);
  const start = session.utterances[0]?.at ?? session.startedAt;
  return (
    <details className="card transcript">
      <summary>What I heard ({session.utterances.length})</summary>
      <ol>
        {items.length === 0 && <li className="muted">Nothing yet.</li>}
        {items.map((u) => {
          const s = Math.max(0, Math.round((u.at - start) / 1000));
          return (
            <li key={u.id} className={u.addressed ? "addr" : ""}>
              <span className="t">
                {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
              </span>
              {u.text}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function AskBar(props: {
  listening: boolean;
  supported: boolean;
  interim: string;
  onMic: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="askbar">
      <div className="wrap stack" style={{ gap: 4, paddingTop: 10, paddingBottom: 12 }}>
        <div className="interim" aria-live="off">
          {props.listening ? props.interim || "Listening to the table…" : props.supported ? "Mic is off." : ""}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            props.onSubmit(text.trim());
            setText("");
          }}
        >
          {props.supported && (
            <button
              type="button"
              className={`mic ${props.listening ? "on" : ""}`}
              onClick={props.onMic}
              aria-label={props.listening ? "Stop listening" : "Start listening"}
              aria-pressed={props.listening}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
                {!props.listening && <path d="M3 3l18 18" />}
              </svg>
            </button>
          )}
          <input
            type="text"
            placeholder="Ask a rules question…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Ask Tablemate"
          />
          <button className="btn primary" type="submit" disabled={!text.trim()}>
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}
