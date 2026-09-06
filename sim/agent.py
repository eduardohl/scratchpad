"""Agent state and the per-block decision rules driven by a Profile.

The trait -> behavior formulas below are a deliberately simple, documented
model (not a validated psychological finding) so the effect of each policy
lever is legible and tunable:

- checking_interval: how many blocks an agent goes between checking async
  messages when left to their own preference. Higher conscientiousness ->
  more disciplined batching (longer interval). Higher neuroticism and
  extraversion -> more frequent, anxious/social checking (shorter interval).
- context_switch_penalty: focus blocks lost resuming deep work after an
  interruption (meeting or an immediately-handled message). Higher
  neuroticism -> costlier switches; higher conscientiousness -> cheaper
  recovery.
- effective_capacity: fraction of a block's nominal output an agent
  produces, degraded by accumulated stress (fatigue from interruptions).
"""

from dataclasses import dataclass, field

from sim.profiles import Profile
from sim.tasks import Task


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def checking_interval_blocks(profile: Profile, enforce_immediate: bool) -> int:
    if enforce_immediate:
        return 1
    raw = 6 - profile.neuroticism * 4 - profile.extraversion * 1 + profile.conscientiousness * 3
    return int(round(_clamp(raw, 1, 8)))


def context_switch_penalty_blocks(profile: Profile) -> int:
    raw = 1 + profile.neuroticism * 2 - profile.conscientiousness * 1
    return int(round(_clamp(raw, 0, 3)))


@dataclass
class DayStats:
    focus_blocks: int = 0
    interruptions: int = 0
    messages_handled: int = 0
    response_latencies: list[int] = field(default_factory=list)
    tasks_completed: int = 0
    end_stress: float = 0.0


class Agent:
    def __init__(self, profile: Profile, backlog: list[Task]):
        self.profile = profile
        self.backlog = backlog
        self.stress = 0.0

    def effective_capacity(self) -> float:
        return _clamp(1 - self.stress * 0.3, 0.4, 1.0)

    def current_task(self) -> Task | None:
        for task in self.backlog:
            if not task.done:
                return task
        return None

    def simulate_day(self, rng, policy, blocks_per_day: int) -> DayStats:
        from sim.communication import schedule_meetings, schedule_messages

        meeting_blocks = schedule_meetings(rng, policy, blocks_per_day)
        message_blocks = schedule_messages(rng, policy, blocks_per_day)
        pending_messages: list[int] = []  # arrival block indices, awaiting response

        interval = checking_interval_blocks(self.profile, policy.enforce_immediate_response)
        stats = DayStats()
        blocks_since_check = 0

        for block in range(blocks_per_day):
            if block in message_blocks:
                pending_messages.append(block)

            if block in meeting_blocks:
                stats.interruptions += 1
                self.stress += 0.03 * (1 + self.profile.neuroticism)
                continue

            blocks_since_check += 1
            should_check = blocks_since_check >= interval and pending_messages
            if should_check:
                blocks_since_check = 0
                for arrival in pending_messages:
                    stats.response_latencies.append(block - arrival)
                    stats.messages_handled += 1
                stats.interruptions += 1
                self.stress += 0.02 * (1 + self.profile.neuroticism)
                penalty = context_switch_penalty_blocks(self.profile)
                pending_messages = []
                # A block with a nonzero penalty is lost to context-switch
                # recovery rather than deep work (a simplified one-block cost).
                if penalty > 0:
                    continue

            task = self.current_task()
            if task is None:
                continue
            task.progress_blocks += self.effective_capacity()
            stats.focus_blocks += 1
            if task.done:
                stats.tasks_completed += 1

        stats.end_stress = self.stress
        return stats
