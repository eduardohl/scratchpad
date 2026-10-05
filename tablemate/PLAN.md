# Tablemate: plan for v1 (friends beta)

## Status

| Milestone | Status |
|---|---|
| M0 Eval harness | **Built.** 19 scripts, simulator on the real engine, scoring, grader, free dry run. Not yet run live (needs `ANTHROPIC_API_KEY`). |
| M1 Speech-to-text with speaker labels | Data model ready (`Utterance.speaker`). **Bake-off tooling built:** synthetic pt-BR game night (`npm run gamenight`) + real-time comparison of AssemblyAI and Soniox (`npm run bakeoff`). Waiting on ElevenLabs / AssemblyAI / Soniox keys. |
| M2 Rules trust | Not started |
| M3 Phase polish | Not started |
| M4 Beta guardrails + deploy | Not started |
| M5 Playtest + tune | Not started |

**Decisions since the plan:**
- The table speaks **Brazilian Portuguese mixed with English**, is loud and jokey, and has **4–8 players**.
- Tablemate answers in pt-BR and keeps the table's English game terms.
- The app now has a table-language setting, Portuguese cue phrases (accents ignored), and 17 pt-BR eval scripts.
- Speech-to-text candidates are narrowed to the ones that do live Portuguese/English code-switching *and* live speaker labels: **AssemblyAI Universal-3.6 Pro** and **Soniox stt-rt-v5**.
  - Speechmatics' live mode doesn't code-switch.
  - ElevenLabs' live Scribe has no speaker labels.
- **ElevenLabs** is the pick for Tablemate's voice.

**Findings so far (dry run, no model calls):** the original gate only got 13 of 16 planted moments to the listener in time. Quiet rule errors without a cue phrase, and round transitions, waited for the 60 s routine sweep. Two fixes brought it to 16/16: a busy-table sweep (5+ new lines and 20 s since the last check) and round-transition cues. Game-specific watch words from the playbook should add headroom in live runs. Cost: about 3 extra checks per pass.

## Context

**Goal.** A board game companion that helps with complex games without making game night feel robotic. It listens to the whole table, keeps track of the game, and only speaks up when that's clearly worth the interruption. It covers four phases: setup, teaching the rules, play, and wrap-up/scoring.

**Decisions made.**

| Decision | Choice |
|---|---|
| Audience | Me and friends (private beta) |
| Platform | Web app / PWA first |
| Listening | Cloud speech-to-text with speaker labels |
| Games | Any game; rulebook optional but encouraged |

**Starting point.** A prototype already exists in `tablemate/` on branch `ccr-546a9bb4-btxxy1`: Next.js, Claude, browser speech recognition, and an "etiquette" layer. Treat it as a spike. Keep the parts that worked and replace the listening layer. It has never run against the real API, so the first job is to *measure* whether the core idea works, before building more.

**The two biggest risks**, which drive the order of work:
1. **Etiquette.** Does it stay quiet enough without missing what matters? Too chatty and people turn it off; too quiet and it's useless.
2. **Accuracy.** A wrong rules call stated confidently is worse than silence.

---

## Milestone 0: Measure before building (eval harness)

Make "is it annoying / is it right?" a number that can be re-run.

- **Table scripts.** Write `tablemate/evals/scripts/*.json`: 15–25 short scripted transcripts across 4–5 games (e.g. Catan, Wingspan, Terraforming Mars, Root, Azul). Each line has a speaker and text.
  - Each script is labeled with **should-speak** moments: a real rule error, a skipped upkeep step, a stuck question, a phase transition. Each has a key fact the reply must contain.
  - Each script also has **must-stay-quiet** stretches: banter, a debate that resolves correctly, a question someone at the table already answered.
- **Runner.** Add `tablemate/evals/run.ts`. It replays each script through the real `shouldCheck` → `listen()` → `admit()` path from `src/lib/gate.ts` and `src/lib/claude.ts`, on simulated time.
  - **Interruption precision:** the share of unprompted speech that was wanted.
  - **Recall:** the share of should-speak moments it caught.
  - **Correctness:** did the message contain the key fact? Graded by a Claude grader.
  - **Calls per hour:** a proxy for cost.
- **Targets for beta:** precision ≥ 0.9, recall ≥ 0.7 on rule errors, no confidently wrong ruling on scripts that come with a rulebook.
- **Budget.** Every run costs real API money, so estimate the cost first and keep the script set small.

## Milestone 1: Hearing who said what (cloud speech-to-text with speaker labels)

**Architecture.**
- The browser captures the mic with `getUserMedia` and streams audio **directly** to the speech-to-text provider over WebSocket.
- Our server only mints a **short-lived token** (`/api/stt-token`). This keeps the API key private and avoids hosting limits on long-lived connections.
- The app server never handles audio.

**Provider.** Do a 1-day spike comparing Deepgram, AssemblyAI and Speechmatics on 15 minutes of recorded real-table audio: crosstalk, 4 voices, background music. Compare speaker-label accuracy, latency and price, then pick one. Hide the choice behind an interface so it can be swapped later:
  - New `src/lib/transcriber.ts`: `interface Transcriber { start(); stop(); onFinal(cb: (u: {text, speaker, at}) => void); onInterim(cb) }`.
  - `src/hooks/useSpeech.ts` becomes one implementation, the browser fallback. The new `src/hooks/useCloudTranscriber.ts` is the default.

**Mapping voices to players.** Do a "voice roll call" at the start of setup: each player says *"I'm Ana"*. The speaker label heard (e.g. `speaker_2`) is mapped to Ana.
  - If the mapping drifts, it can be fixed with a tap on any transcript line ("this was Ben").
  - Unmapped speakers show as "someone".

**Data model.**
  - Add `speaker?: string` to `Utterance` in `src/lib/types.ts`.
  - Show speaker names in `transcriptText` in `src/lib/prompts.ts`, e.g. `[12:03] Ana: can I trade twice`.
  - Update the listener prompt: use speakers to track whose turn it is and who is acting.

**Keep the PWA listening.**
  - Keep the screen awake with the Screen Wake Lock API.
  - Add a web app manifest so it can be installed to the home screen.
  - Show a clear "mic paused" state when the browser suspends audio.

**Fallback.** If the cloud speech service fails, switch to browser recognition automatically, with a small notice.

## Milestone 2: Rules you can trust

- **Rulebook upload.** The current upload route hits hosting body limits (~4.5 MB on Vercel).
  - Fix: the client uploads to object storage (Vercel Blob client upload), then `/api/rulebook` forwards the file to the Claude Files API.
  - Rulebooks up to ~30 MB are fine.
- **Cited answers.** For direct questions in `ask()` in `src/lib/claude.ts`, enable `citations` on the rulebook document block. Answers can then say *"p. 7: …"*.
  - The UI shows the page reference on the answer card.
  - (Citations only work in the plain-text route, not with structured output, which suits the answer route.)
- **Honest confidence.** The playbook already reports `rulesConfidence` and `caveat`.
  - With no rulebook and low confidence, cap the listener at answering direct questions only. It doesn't correct the table on rules it's unsure of.
  - Tell the players once: "add a rulebook for rule checks".
- **Game library.** Save prepared playbooks in local storage by game name and rulebook, so the second game night starts instantly.
- **House rules.** Any ruling the table agrees on ("we'll allow that") is added to the game log and treated as overriding the rulebook for the rest of the session.

## Milestone 3: Each phase works end to end

The UI panels already exist in `src/components/Panels.tsx`; each phase gets these improvements:

- **Setup**
  - Voice roll call (Milestone 1).
  - The checklist ticks itself off from speech (already works).
  - "What's next?" answered aloud.
- **Teach**
  - Optional **voice-led teach**: Tablemate reads one section, pauses, and takes questions.
  - "Next" / "say that again" by voice.
  - The listener marks sections as covered.
- **Play**
  - Turn and round tracking from speakers.
  - **Upkeep reminders tied to round boundaries.** The `roundEnd` steps from the playbook are checked when a new round is detected, not just from what's been said.
  - A thinking timer is **out** of scope (it feels robotic).
- **Wrap-up**
  - **Voice scoring.** "Ana has 12 in birds" fills the score sheet. This needs a `scoreEntries` field added to `ListenResultSchema` in `src/lib/schemas.ts`.
  - Tie-breaker answered from the rulebook.
  - Recap (already exists).

## Milestone 4: Guardrails for a private beta

- A **shared access code** (environment variable) checked by middleware on every `/api/*` route. No accounts.
- A **per-session spend cap**. The server keeps rough counts of calls and tokens per session id and refuses beyond a limit. Plus basic per-IP rate limiting.
- **Privacy.**
  - Audio is never stored.
  - Transcripts stay on the device. They are sent to Claude only as text, and only on checks.
  - A one-screen explainer before the mic turns on, so everyone at the table knows it's listening.
- **Deploy** to Vercel. Keep secrets in environment variables: `ANTHROPIC_API_KEY`, the speech provider key, and the access code.

## Milestone 5: Playtest and tune

- 3–5 real game nights, mixing groups that know the game with groups learning it.
- **Seeded mistakes.** One player secretly makes 3 deliberate rule mistakes per game. This measures real-world recall without waiting for natural mistakes.
- **In-app feedback.** 👍 / "Not now" already exist. Add a **"You should have said something"** button that saves the last 2 minutes of transcript as a missed case.
- After each night, turn the misses and the bad interruptions into new eval scripts (Milestone 0). Then tune the prompts in `src/lib/prompts.ts` and the thresholds in `src/lib/gate.ts` against the eval set, never by feel alone.

---

## What stays from the prototype

- **Kept:**
  - `src/lib/gate.ts`: etiquette rules, with unit tests.
  - `src/lib/prompts.ts`, `src/lib/claude.ts`, `src/lib/schemas.ts`.
  - Phase panels and session persistence (`src/hooks/useTable.ts`).
- **Replaced:** `useSpeech` stops being the main input and becomes the fallback.

## Out of scope for v1

- Accounts and billing.
- A native app.
- Camera/board recognition.
- Shared state across several phones.
- Strategy coaching beyond the existing "guide" presence tips.

## Cost (to confirm in the spikes)

- **Claude:** cue-driven checks, with the rulebook prefix cached, so roughly tens to ~150 small calls per 2-hour game.
- **Speech-to-text:** priced per audio hour by the chosen provider. Measure both on the first playtest and show a per-session cost readout in a debug panel.

## Verification

- `npm test`: etiquette unit tests, plus new tests for speaker mapping and score extraction.
- `npm run typecheck` and `npm run build`.
- `npx tsx evals/run.ts` reports precision, recall, correctness and calls per hour against the targets above. Run it before and after every prompt or threshold change.
- Speech-to-text spike: a short report comparing providers on the same recorded clip.
- Playtest checklist per night:
  - unwanted interruptions per hour (target ≤ 1)
  - seeded mistakes caught (target ≥ 2 of 3)
  - direct questions answered correctly
  - "we turned it off" (target: never)

## Order of work

M0 eval harness → M1 speech spike, then integration → M2 rules trust → M4 guardrails and deploy → **first playtest** → M3 phase polish → M5 tune loop (repeat).
