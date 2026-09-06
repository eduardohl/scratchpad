"""Work items agents chip away at during focus blocks."""

import random
from dataclasses import dataclass
from itertools import count

_ids = count(1)


@dataclass
class Task:
    id: int
    effort_blocks: int
    progress_blocks: float = 0.0

    @property
    def done(self) -> bool:
        return self.progress_blocks >= self.effort_blocks


def generate_backlog(rng: random.Random, n: int, min_effort=2, max_effort=8) -> list[Task]:
    return [Task(id=next(_ids), effort_blocks=rng.randint(min_effort, max_effort)) for _ in range(n)]
