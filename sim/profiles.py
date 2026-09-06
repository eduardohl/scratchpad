"""Psychological profiles that parameterize agent behavior.

Traits use the Big Five (OCEAN) model, each on a 0-1 scale. The mapping from
traits to behavior (sim/agent.py) is a simplifying model for exploring
communication-policy tradeoffs, not a validated psychological instrument.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Profile:
    name: str
    openness: float
    conscientiousness: float
    extraversion: float
    agreeableness: float
    neuroticism: float
    role: str = "individual_contributor"


PRESET_PROFILES = [
    Profile(
        name="Anxious Achiever",
        openness=0.5, conscientiousness=0.8, extraversion=0.4,
        agreeableness=0.6, neuroticism=0.8,
    ),
    Profile(
        name="Steady Introvert",
        openness=0.5, conscientiousness=0.7, extraversion=0.2,
        agreeableness=0.5, neuroticism=0.3,
    ),
    Profile(
        name="Social Connector",
        openness=0.6, conscientiousness=0.5, extraversion=0.9,
        agreeableness=0.7, neuroticism=0.4,
    ),
    Profile(
        name="Disengaged Cynic",
        openness=0.3, conscientiousness=0.3, extraversion=0.3,
        agreeableness=0.3, neuroticism=0.5,
    ),
    Profile(
        name="Perfectionist Manager",
        openness=0.5, conscientiousness=0.9, extraversion=0.6,
        agreeableness=0.5, neuroticism=0.6, role="manager",
    ),
]
