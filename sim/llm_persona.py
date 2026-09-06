"""Optional: have Claude write a first-person reflection from a persona.

The quantitative engine (sim/engine.py) never depends on this — it stays
deterministic and runs offline. This module is a separate, opt-in layer for
turning a scenario's numbers into a qualitative persona reaction, e.g. for a
report. Requires ANTHROPIC_API_KEY and the `anthropic` package.
"""

import os

from sim.engine import ScenarioResult
from sim.profiles import Profile

MODEL = "claude-sonnet-5"

_PROMPT_TEMPLATE = """\
You are role-playing a workplace persona for a behavioral-simulation study.
Stay in character, first person, 3-5 sentences, no headers.

Persona: {name} ({role})
Big Five traits (0-1 scale): openness={openness}, conscientiousness={conscientiousness}, \
extraversion={extraversion}, agreeableness={agreeableness}, neuroticism={neuroticism}

You just finished a {days}-day simulated work period under the "{policy_name}" \
communication policy. Your measured outcomes: {focus_blocks} focus blocks completed, \
{interruptions} interruptions, {tasks_completed} tasks finished, average message \
response latency of {avg_response_latency_blocks:.1f} blocks (each block = 30 min), \
ending stress level {end_stress:.2f} (0=calm, 1=maxed out).

In character, react to how this communication policy affected your focus and results.
"""


def reflect_on_result(profile: Profile, result: ScenarioResult, days: int) -> str:
    """Return a persona's first-person reaction to their scenario result.

    Raises RuntimeError if ANTHROPIC_API_KEY is not set or the `anthropic`
    package is not installed.
    """
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY is not set; cannot call the Claude API.")
    try:
        import anthropic
    except ImportError as exc:
        raise RuntimeError("The 'anthropic' package is not installed (pip install anthropic).") from exc

    prompt = _PROMPT_TEMPLATE.format(
        name=profile.name,
        role=profile.role,
        openness=profile.openness,
        conscientiousness=profile.conscientiousness,
        extraversion=profile.extraversion,
        agreeableness=profile.agreeableness,
        neuroticism=profile.neuroticism,
        days=days,
        policy_name=result.policy_name,
        focus_blocks=result.focus_blocks,
        interruptions=result.interruptions,
        tasks_completed=result.tasks_completed,
        avg_response_latency_blocks=result.avg_response_latency_blocks,
        end_stress=result.end_stress,
    )

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text
