# Tablemate

A board game companion that sits on the table, listens, and stays out of the way.
It helps with setup, teaching the rules, play and scoring, and it only speaks up when that's worth more than the interruption.

## How it behaves

| Phase | What Tablemate does |
|---|---|
| **Setup** | Shows a setup checklist for your exact player count and ticks steps off as it hears them ("ok, cards are dealt"). The next step's detail is the only one shown. |
| **Rules** | Gives you a teach script in order: the goal, then turn flow, then exceptions. Go at your own pace with an optional *read aloud*. It answers questions while you teach. |
| **Play** | Tracks the round and whose turn it is, keeps a reference card, and writes a short game log. It notices rule mistakes, steps you skipped, and questions the table can't settle. |
| **Wrap-up** | Gives you a score pad with the game's real scoring categories, works out the totals and the winner, and can write a short recap of the night. |

You can **ask it directly** any time by saying *"Tablemate, can I trade before rolling?"* or by typing in the bar. Direct questions always get an answer, spoken aloud if voice is on.

### Staying non-intrusive

Most of the work is deciding *not* to talk. There are three layers:

1. **Cheap local cues** (`src/lib/gate.ts`, `shouldCheck`). The browser transcribes speech continuously, and nothing goes to the model until a cue shows up. Cues include rule uncertainty ("wait, can you…", "I don't remember", "is that legal"), a phase change ("let's start", "last round"), or an occasional routine check on plain chatter. Even then it waits for a ~1.3 s pause in the conversation and never checks more often than every 6 s.
2. **The listener** (`/api/listen`). Claude reads the new transcript along with the playbook, the rulebook and the table state. It updates the state, then decides whether to speak, with a strong default toward silence. It stays quiet if the table is already working it out or someone has given the right answer. It returns a kind (answer, correction, reminder, phase, teach, tip), an urgency and a confidence score.
3. **Etiquette policy** (`admit`). The app, not the model, decides how loud a suggestion gets:
   - **voice**: only for direct questions and high-urgency corrections, and only if voice is on.
   - **card**: a quiet card with a soft chime.
   - **badge**: tucked into "💡 quiet thoughts", one tap away.
   - **drop**: discarded.

   Several rules feed into that decision. A minimum confidence depends on the presence level (quiet, balanced or guide). There's a cooldown between unprompted interruptions, and a topic raised once isn't repeated for 10 minutes. Anything waiting for a pause that the table never gives within 30 s is demoted to a badge. Each **"Not now"** makes it more reserved, and a 👍 resets that.

Every rule here is a pure function with unit tests (`npm test`), so the etiquette can be tuned without touching prompts. The decision loop itself lives in `src/lib/engine.ts`. Both the React hook and the eval harness drive it, so evals measure exactly what runs at the table.

The playbook also gives the gate a few **watch words**: words this particular game's rules tend to slip on (Catan: "robber", "bank"). Hearing one triggers a closer look, at most every 15 s.

### Accuracy

- **Rulebook grounding.** Upload the PDF (sent once to the Claude Files API and referenced by id) or paste rules or house rules. Claude is told to trust the rulebook over its memory.
- **Honest confidence.** The playbook reports `rulesConfidence`. When Claude doesn't know a game well and has no rulebook, the app says so instead of making rules up.
- **Prompt caching.** The rulebook and playbook form a stable prefix that is cached across the many listener calls in a game. Only the table state and the transcript change from call to call.

## Architecture

```
Browser (Next.js client)                          Server (Next.js route handlers)
───────────────────────                           ───────────────────────────────
Web Speech API ─► transcript ─► shouldCheck ─────► POST /api/listen   (structured: state + intervention)
                       │                               │
             wake word │                               ▼
                       └──────────────────────────► POST /api/ask      (streamed spoken answer / recap)
admit() ◄── intervention                          POST /api/prepare  (structured playbook for the game)
  ├─ voice (speechSynthesis)                      POST /api/rulebook (PDF ─► Files API)
  ├─ card / badge                                         │
  └─ drop                                                 ▼
localStorage: session survives refresh            Claude API (@anthropic-ai/sdk)
```

- `src/lib/gate.ts`: when to check and how loud to be (pure, tested)
- `src/lib/prompts.ts`: persona, listener, answer and recap prompts
- `src/lib/claude.ts`: all Claude calls (server-only)
- `src/hooks/useTable.ts`: the client orchestrator (transcript, listener loop, delivery into pauses)
- `src/hooks/useSpeech.ts`: continuous recognition with auto-restart, TTS, chime
- `src/components/`: start screen, phase panels, companion feed

The models are `claude-opus-5-5` for everything by default. The listener runs at `effort: "low"` and the playbook at `medium`. Requests opt into server-side refusal fallbacks (`fallbacks: "default"`). To trade some quality for cost, point the listener at a cheaper model with `TABLEMATE_LISTENER_MODEL`.

## Running it

```bash
cd tablemate
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
npm test                     # etiquette + eval-scoring unit tests
npm run eval                 # free dry run of the eval suite (see evals/README.md)
npm run eval -- --yes        # live eval run against Claude
```

The roadmap and milestone status are in [PLAN.md](PLAN.md).

Use Chrome, Edge or Safari for speech recognition. The mic needs `localhost` or HTTPS. Put a phone or tablet in the middle of the table.

**Cost.** Listener calls only happen on cues, and the rulebook and playbook prefix is read from cache, so a 2-hour game usually makes a few dozen to ~150 small calls. Measure with your own games.

## Known limits / next steps

- **Speech recognition.** The browser's Web Speech API is free and instant, but it has no speaker labels, and it does poorly with crosstalk and noisy rooms. The next step is streaming server-side STT with diarization, so Tablemate knows *who* said what (whose turn, who is breaking a rule).
- **Hidden information.** It never reveals hidden information, but it also can't see the board. Taking a photo of the board for setup checks and scoring is a natural addition.
- **Single device.** Each phone holds its own session. Shared multi-device state would let each player have their own view.
- **Rulebook size.** Uploads go through the app server, so hosting body limits apply (about 4.5 MB on Vercel). Large rulebooks should upload directly to storage.
- **No auth or rate limiting.** Anyone who can reach the deployment can spend your API key. Add both before sharing it publicly.
