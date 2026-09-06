"""Org-level communication policies: how meetings and messages are scheduled.

A policy describes the *environment* an agent works in, independent of the
agent's own personality. Comparing policies against the same population of
agents is the benchmark this app is built for.
"""

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class CommunicationPolicy:
    name: str
    meetings_per_day: int
    meeting_length_blocks: int
    async_messages_per_day: int
    # If True, org culture expects a reply within 1 block regardless of the
    # agent's personal batching preference (an "always-on" culture).
    enforce_immediate_response: bool = False


POLICIES = [
    CommunicationPolicy(
        name="Sync-Heavy",
        meetings_per_day=4,
        meeting_length_blocks=2,
        async_messages_per_day=6,
        enforce_immediate_response=True,
    ),
    CommunicationPolicy(
        name="Async-Default",
        meetings_per_day=1,
        meeting_length_blocks=2,
        async_messages_per_day=10,
        enforce_immediate_response=False,
    ),
    CommunicationPolicy(
        name="Mixed",
        meetings_per_day=2,
        meeting_length_blocks=2,
        async_messages_per_day=8,
        enforce_immediate_response=False,
    ),
]


def schedule_meetings(rng: random.Random, policy: CommunicationPolicy, blocks_per_day: int) -> set[int]:
    """Return the set of block indices occupied by meetings for one day."""
    occupied: set[int] = set()
    for _ in range(policy.meetings_per_day):
        start = rng.randint(0, max(0, blocks_per_day - policy.meeting_length_blocks))
        occupied.update(range(start, start + policy.meeting_length_blocks))
    return occupied


def schedule_messages(rng: random.Random, policy: CommunicationPolicy, blocks_per_day: int) -> list[int]:
    """Return sorted block indices at which an async message arrives."""
    return sorted(rng.randint(0, blocks_per_day - 1) for _ in range(policy.async_messages_per_day))
