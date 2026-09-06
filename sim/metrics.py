"""Aggregation helpers for comparing scenario results across policies."""

from collections import defaultdict
from statistics import mean

from sim.engine import ScenarioResult

FIELDS = [
    "focus_blocks",
    "interruptions",
    "messages_handled",
    "avg_response_latency_blocks",
    "tasks_completed",
    "end_stress",
]


def summarize_by_policy(results: list[ScenarioResult]) -> dict[str, dict[str, float]]:
    grouped: dict[str, list[ScenarioResult]] = defaultdict(list)
    for r in results:
        grouped[r.policy_name].append(r)

    summary: dict[str, dict[str, float]] = {}
    for policy_name, rs in grouped.items():
        summary[policy_name] = {field: mean(getattr(r, field) for r in rs) for field in FIELDS}
    return summary


def print_summary_table(summary: dict[str, dict[str, float]]) -> None:
    header = ["policy"] + FIELDS
    rows = [header] + [
        [name] + [f"{values[f]:.2f}" for f in FIELDS] for name, values in summary.items()
    ]
    widths = [max(len(row[i]) for row in rows) for i in range(len(header))]
    for row in rows:
        print("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)))
