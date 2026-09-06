import unittest

from sim.agent import checking_interval_blocks, context_switch_penalty_blocks
from sim.communication import POLICIES
from sim.engine import run_scenario
from sim.profiles import PRESET_PROFILES


class TestDeterminism(unittest.TestCase):
    def test_same_seed_same_result(self):
        profile = PRESET_PROFILES[0]
        policy = POLICIES[0]
        a = run_scenario(profile, policy, days=5, seed=42)
        b = run_scenario(profile, policy, days=5, seed=42)
        self.assertEqual(a, b)

    def test_different_seed_can_differ(self):
        profile = PRESET_PROFILES[0]
        policy = POLICIES[0]
        results = {run_scenario(profile, policy, days=5, seed=s) for s in range(5)}
        self.assertGreater(len(results), 1)


class TestTraitFormulas(unittest.TestCase):
    def test_immediate_response_enforced(self):
        profile = PRESET_PROFILES[0]
        self.assertEqual(checking_interval_blocks(profile, enforce_immediate=True), 1)

    def test_interval_in_bounds(self):
        for profile in PRESET_PROFILES:
            interval = checking_interval_blocks(profile, enforce_immediate=False)
            self.assertGreaterEqual(interval, 1)
            self.assertLessEqual(interval, 8)

    def test_penalty_in_bounds(self):
        for profile in PRESET_PROFILES:
            penalty = context_switch_penalty_blocks(profile)
            self.assertGreaterEqual(penalty, 0)
            self.assertLessEqual(penalty, 3)


class TestScenarioSanity(unittest.TestCase):
    def test_results_are_non_negative(self):
        for profile in PRESET_PROFILES:
            for policy in POLICIES:
                result = run_scenario(profile, policy, days=10, seed=1)
                self.assertGreaterEqual(result.focus_blocks, 0)
                self.assertGreaterEqual(result.tasks_completed, 0)
                self.assertGreaterEqual(result.interruptions, 0)
                self.assertGreaterEqual(result.end_stress, 0)

    def test_sync_heavy_has_more_interruptions_than_async_default(self):
        profile = PRESET_PROFILES[0]
        sync_heavy = next(p for p in POLICIES if p.name == "Sync-Heavy")
        async_default = next(p for p in POLICIES if p.name == "Async-Default")
        seeds = range(10)
        sync_interruptions = sum(run_scenario(profile, sync_heavy, days=10, seed=s).interruptions for s in seeds)
        async_interruptions = sum(run_scenario(profile, async_default, days=10, seed=s).interruptions for s in seeds)
        self.assertGreater(sync_interruptions, async_interruptions)


if __name__ == "__main__":
    unittest.main()
