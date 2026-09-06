"""Runs a communication policy against a population of agents over N days."""

import random
from dataclasses import dataclass

from sim.agent import Agent
from sim.communication import CommunicationPolicy
from sim.profiles import Profile
from sim.tasks import generate_backlog

BLOCKS_PER_DAY = 16  # 30-minute blocks across an 8-hour day


@dataclass(frozen=True)
class ScenarioResult:
    profile_name: str
    policy_name: str
    seed: int
    focus_blocks: int
    interruptions: int
    messages_handled: int
    avg_response_latency_blocks: float
    tasks_completed: int
    end_stress: float


def run_scenario(
    profile: Profile,
    policy: CommunicationPolicy,
    days: int,
    seed: int,
    backlog_size: int = 20,
) -> ScenarioResult:
    rng = random.Random(seed)
    backlog = generate_backlog(rng, backlog_size)
    agent = Agent(profile, backlog)

    totals = dict(focus_blocks=0, interruptions=0, messages_handled=0, tasks_completed=0)
    latencies: list[int] = []

    for _ in range(days):
        day_stats = agent.simulate_day(rng, policy, BLOCKS_PER_DAY)
        totals["focus_blocks"] += day_stats.focus_blocks
        totals["interruptions"] += day_stats.interruptions
        totals["messages_handled"] += day_stats.messages_handled
        totals["tasks_completed"] += day_stats.tasks_completed
        latencies.extend(day_stats.response_latencies)

    return ScenarioResult(
        profile_name=profile.name,
        policy_name=policy.name,
        seed=seed,
        avg_response_latency_blocks=(sum(latencies) / len(latencies)) if latencies else 0.0,
        end_stress=agent.stress,
        **totals,
    )
