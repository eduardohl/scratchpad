# Evals

These evals measure whether Tablemate speaks when it should and stays quiet when it shouldn't. They run on short, labeled **table scripts**, replayed through the app's real decision engine (`src/lib/engine.ts`) on a simulated clock. Lines take time to say, pauses happen, and the listener takes ~2.5 s to respond.

```bash
npm run eval                         # free: validates scripts, counts checks, gate ceiling, cost estimate
npm run eval -- --yes                # live: calls Claude (needs ANTHROPIC_API_KEY); prints the estimate first
npm run eval -- --yes --only catan   # a subset
npm run eval -- --yes --repeat 3     # model output varies, so repeat for stable numbers
npm run eval -- --yes --no-speakers  # simulate browser speech recognition (no speaker labels)
```

## What the numbers mean

| Metric | Meaning | Beta target |
|---|---|---|
| Interruption precision | Of the things Tablemate surfaced unprompted, the share that were wanted | ≥ 90% |
| Recall | Planted moments (rule errors, skipped steps, stuck questions) it caught | ≥ 70% |
| Gate ceiling | Planted moments where the listener even got a look in time; no prompt can beat this | 100% |
| Near misses | Moments it noticed but only filed as a quiet tip | informational |
| Wrong rulings | Messages the grader judged to state a rule incorrectly | 0 with a rulebook |
| Checks per hour | Listener calls per hour of talk (cost proxy). Scripts are dense, so real games run lower | informational |

Matching works like this. A surfaced intervention counts for an expectation if it lands within the expectation's window (default 45 s after the trigger line). The Claude grader (`grade.ts`) must also agree that it conveys the expected fact. Anything else surfaced is an unwanted interruption.

## Writing a script

Add `scripts/<id>.json`. Write lines the way speech recognition hears them: lower case, little punctuation. Put an `expect` on the line where the moment happens:

```json
{ "who": "Ben", "say": "I'll give the bank two wheat for one ore",
  "expect": { "type": "speak", "category": "rule-error", "fact": "Without a harbor, bank trades are 4:1." } }
```

- `type: "speak"` means it must surface this. `type: "ok"` means surfacing is fine but not required (e.g. a phase pointer).
- Categories: `rule-error`, `skipped-step`, `stuck-question`, `phase`.
- Add `"pause": 4` for silence before a line, and `"rulebook": "..."` for an excerpt to treat as the rulebook.
- Lines with no expectation are stretches where it should stay quiet.

**Every miss or bad interruption from a real game night should become a new script.**

Playbooks are generated once per game setup and cached in `.cache/briefs/` so runs are comparable. Use `--refresh-briefs` after changing the prepare prompt. Results are written to `results/`.
