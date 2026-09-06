"""Benchmark communication policies across a population of persona profiles.

Usage:
    python -m experiments.run_benchmark [--days 10] [--seeds 5]
"""

import argparse
import csv
import sys

from sim.communication import POLICIES
from sim.engine import ScenarioResult, run_scenario
from sim.metrics import print_summary_table, summarize_by_policy
from sim.profiles import PRESET_PROFILES


def run_all(days: int, seeds: int) -> list[ScenarioResult]:
    results = []
    for policy in POLICIES:
        for profile in PRESET_PROFILES:
            for seed in range(seeds):
                results.append(run_scenario(profile, policy, days=days, seed=seed))
    return results


def write_csv(results: list[ScenarioResult], path: str) -> None:
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(list(results[0].__dict__.keys()))
        for r in results:
            writer.writerow(list(r.__dict__.values()))


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=10, help="simulated work days per scenario")
    parser.add_argument("--seeds", type=int, default=5, help="random seeds per (policy, profile) pair")
    parser.add_argument("--csv", default="benchmark_results.csv", help="path to write raw results")
    args = parser.parse_args(argv)

    results = run_all(args.days, args.seeds)
    write_csv(results, args.csv)

    print(f"Ran {len(results)} scenarios ({args.days} days x {args.seeds} seeds x "
          f"{len(PRESET_PROFILES)} profiles x {len(POLICIES)} policies)\n")
    print("Mean outcomes by policy (averaged across all personas and seeds):\n")
    print_summary_table(summarize_by_policy(results))
    print(f"\nRaw per-scenario results written to {args.csv}")

    print("\nMean outcomes by policy, per persona:\n")
    for profile in PRESET_PROFILES:
        subset = [r for r in results if r.profile_name == profile.name]
        print(f"-- {profile.name} --")
        print_summary_table(summarize_by_policy(subset))
        print()


if __name__ == "__main__":
    main(sys.argv[1:])
