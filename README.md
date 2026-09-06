# scratchpad

## Behavioral simulation: communication policy vs. focus and results

A small agent-based simulation for studying how workplace communication
policies (sync-heavy meetings, async-default, mixed) affect focus time,
throughput, and stress, across agents with different psychological profiles.

Each agent is parameterized by a Big Five (OCEAN) personality profile and
works through a task backlog over simulated 30-minute blocks in an 8-hour
day. Meetings and async messages arrive according to an org-level
`CommunicationPolicy`; how quickly an agent checks messages, and how costly
an interruption is to recover from, is derived from their profile (see the
docstring in `sim/agent.py` for the exact, deliberately simple formulas).
This is a toy model for exploring policy tradeoffs, not a validated
psychological instrument.

### Run the benchmark

```
python3 -m experiments.run_benchmark --days 20 --seeds 8
```

This runs every preset persona (`sim/profiles.py`) against every preset
policy (`sim/communication.py`), prints a comparison table of mean outcomes
(focus blocks, interruptions, tasks completed, response latency, end-of-run
stress), and writes the raw per-scenario results to `benchmark_results.csv`.

### Run the tests

```
python3 -m unittest discover -s tests -v
```

### Layout

- `sim/profiles.py` — Big Five persona presets
- `sim/tasks.py` — work backlog generation
- `sim/communication.py` — org communication policies (meeting/message scheduling)
- `sim/agent.py` — per-block agent decision rules (checking messages, context-switch cost, fatigue)
- `sim/engine.py` — runs one persona x policy scenario over N days
- `sim/metrics.py` — aggregates and prints scenario results
- `sim/llm_persona.py` — optional: ask Claude to write a first-person reflection from a persona, given a scenario's results (requires `ANTHROPIC_API_KEY`; not used by the core simulation)
- `experiments/run_benchmark.py` — CLI: run every persona x policy combination and compare

### Extending it

The engine currently simulates each agent independently — there's no
cross-agent interaction (e.g., a manager's meeting load affecting a report's
focus, or contagious stress). That's the natural next axis if you want to
model team-level dynamics rather than individual outcomes.
