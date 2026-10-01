#!/usr/bin/env python3
"""Unit tests for CI run aggregator and evaluator (TECH-7014).

Covers all required acceptance scenarios:
- zero A + zero O success
- nonempty A + zero O never success
- pending / approval / action_required
- every non-success failure (skipped, neutral, cancelled, timed_out, failure)
- rerun supersedes older run by (run_number, run_attempt)
- name collision resolution using (run_number, run_attempt)
- anchor and gate workflow exclusion by name and file path
- classifier-aware evaluation:
  - label-not-present workflows ignored entirely, including a stale non-skipped
    (e.g. failed) prior run recorded before the label was removed/absent
  - other non-applicable skipped runs ignored
  - other non-applicable non-skipped runs trigger CLASSIFIER_DRIFT
  - unknown workflows evaluated fail-closed (non-success, waiting/action_required,
    and still-in-progress branches)
- settle window workflow-set drift returns PENDING with WORKFLOW_SET_DRIFT
- mocked sweep_and_evaluate_with_polling covering poll timeout, elapsed time, settle sleep, drift
- API pagination/truncation caps fail closed
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from ci_aggregate import (  # noqa: E402
    evaluate_ci_runs,
    fetch_workflow_runs_for_sha,
    group_latest_runs,
    sweep_and_evaluate_with_polling,
)


class TestCIAggregateEvaluation(unittest.TestCase):
    def test_zero_a_zero_o_success(self):
        res = evaluate_ci_runs(set(), {})
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ZERO_RUNS_APPLICABLE")
        self.assertIn("documentation-only", res.summary)

    def test_nonempty_a_zero_o_never_success(self):
        res = evaluate_ci_runs({"PR"}, {})
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "MISSING_APPLICABLE_RUNS")

    def test_pending_in_progress(self):
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "in_progress",
                "conclusion": None,
            }
        }
        res = evaluate_ci_runs({"PR"}, observed)
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")

    def test_pending_queued(self):
        observed = {
            "Docker Runner check": {
                "name": "Docker Runner check",
                "workflow_id": 2,
                "status": "queued",
                "conclusion": None,
            }
        }
        res = evaluate_ci_runs({"Docker Runner check"}, observed)
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")

    def test_waiting_and_action_required(self):
        obs1 = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "waiting",
                "conclusion": None,
            }
        }
        res1 = evaluate_ci_runs({"PR"}, obs1)
        self.assertEqual(res1.status, "FAILURE")
        self.assertEqual(res1.reason, "ACTION_REQUIRED")

        obs2 = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "action_required",
            }
        }
        res2 = evaluate_ci_runs({"PR"}, obs2)
        self.assertEqual(res2.status, "FAILURE")
        self.assertEqual(res2.reason, "ACTION_REQUIRED")

    def test_every_non_success_conclusion_fails(self):
        for conclusion in ["failure", "skipped", "neutral", "cancelled", "timed_out"]:
            with self.subTest(conclusion=conclusion):
                observed = {
                    "PR": {
                        "name": "PR",
                        "workflow_id": 1,
                        "status": "completed",
                        "conclusion": conclusion,
                    }
                }
                res = evaluate_ci_runs({"PR"}, observed)
                self.assertEqual(res.status, "FAILURE")
                self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")

    def test_rerun_supersedes_with_run_attempt(self):
        runs = [
            {
                "name": "PR",
                "workflow_id": 1,
                "run_number": 1,
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "failure",
            },
            {
                "name": "PR",
                "workflow_id": 1,
                "run_number": 1,
                "run_attempt": 2,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        observed = group_latest_runs(runs)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed["PR"]["run_attempt"], 2)
        self.assertEqual(observed["PR"]["conclusion"], "success")

        res = evaluate_ci_runs({"PR"}, observed)
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")

    def test_name_collision_resolved_by_run_number_and_attempt(self):
        runs = [
            {
                "name": "Duplicated Workflow",
                "workflow_id": 101,
                "run_number": 5,
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "failure",
            },
            {
                "name": "Duplicated Workflow",
                "workflow_id": 102,
                "run_number": 5,
                "run_attempt": 2,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        observed = group_latest_runs(runs)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed["Duplicated Workflow"]["workflow_id"], 102)
        self.assertEqual(observed["Duplicated Workflow"]["conclusion"], "success")

    def test_anchor_and_gate_excluded_by_name_and_path(self):
        runs = [
            {
                "name": "Merge Gate Trigger",
                "workflow_id": 991,
                "path": ".github/workflows/merge-gate-trigger.yml",
                "status": "completed",
                "conclusion": "success",
            },
            {
                "name": "Merge Gate",
                "workflow_id": 992,
                "path": ".github/workflows/merge-gate.yml",
                "status": "completed",
                "conclusion": "success",
            },
            {
                "name": "Custom Trigger Name",
                "workflow_id": 993,
                "path": ".github/workflows/merge-gate-trigger.yml",
                "status": "completed",
                "conclusion": "success",
            },
            {
                "name": "PR",
                "workflow_id": 1,
                "path": ".github/workflows/pr.yml",
                "status": "completed",
                "conclusion": "success",
            },
        ]
        observed = group_latest_runs(runs, exclude_anchor=True)
        self.assertNotIn("Merge Gate Trigger", observed)
        self.assertNotIn("Merge Gate", observed)
        self.assertNotIn("Custom Trigger Name", observed)
        self.assertIn("PR", observed)

    def test_label_not_present_ignored_entirely(self):
        # Storybook Visual observed as skipped (or even failed from a stale run)
        # but label is absent -> must be ignored and not cause failure
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Storybook Visual": {
                "name": "Storybook Visual",
                "workflow_id": 50,
                "status": "completed",
                "conclusion": "skipped",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names={"Storybook Visual"},
            all_known_workflow_names={"PR", "Docker Runner check", "Storybook Visual"},
        )
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")

    def test_other_non_applicable_skipped_ignored(self):
        # Docker Runner check was non-applicable and skipped -> ignored
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Docker Runner check": {
                "name": "Docker Runner check",
                "workflow_id": 2,
                "status": "completed",
                "conclusion": "skipped",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR", "Docker Runner check", "Storybook Visual"},
        )
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")

    def test_other_non_applicable_non_skipped_is_classifier_drift(self):
        # Docker Runner check was classified as non-applicable, but ran with success/failure
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Docker Runner check": {
                "name": "Docker Runner check",
                "workflow_id": 2,
                "status": "completed",
                "conclusion": "success",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR", "Docker Runner check", "Storybook Visual"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "CLASSIFIER_DRIFT")

    def test_unknown_workflow_evaluated_fail_closed(self):
        # A completely unknown workflow outside all_known_workflow_names
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "completed",
                "conclusion": "failure",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR", "Docker Runner check", "Storybook Visual"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")
        self.assertIn("Surprise Workflow", res.summary)

    def test_unknown_workflow_waiting_is_action_required(self):
        # An unknown workflow sitting in 'waiting' (e.g. an environment protection
        # rule) must fail closed as ACTION_REQUIRED, same as a known applicable
        # workflow would, rather than falling through to the in-progress/PENDING
        # or non-success branches.
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "waiting",
                "conclusion": None,
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "ACTION_REQUIRED")
        self.assertIn("Surprise Workflow", res.summary)

    def test_unknown_workflow_in_progress_is_pending(self):
        # An unknown workflow still running (not waiting, not completed) must
        # yield PENDING rather than being skipped or treated as a hard failure.
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "in_progress",
                "conclusion": None,
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR"},
        )
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")
        self.assertIn("Surprise Workflow", res.summary)

    def test_label_not_present_stale_nonskipped_run_ignored_entirely(self):
        # Finding 2 requires label-not-present workflows to be ignored ENTIRELY,
        # including a stale prior run recorded before the label was removed (or
        # never applied on this head). A non-skipped (e.g. failed) stale run must
        # not leak through and must not be treated as classifier drift either --
        # unlike an ordinary non-applicable workflow, a label-gated one is excluded
        # before the applicable-vs-known branching logic ever runs.
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Storybook Visual": {
                "name": "Storybook Visual",
                "workflow_id": 50,
                "status": "completed",
                "conclusion": "failure",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            label_not_present_workflow_names={"Storybook Visual"},
            all_known_workflow_names={"PR", "Storybook Visual"},
        )
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")
        self.assertNotIn("Storybook Visual", res.details.get("observed", []))


class TestSweepAndEvaluatePolling(unittest.TestCase):
    @patch("ci_aggregate.time.sleep")
    @patch("ci_aggregate.fetch_workflow_runs_for_sha")
    def test_polling_settle_drift_returns_pending(self, mock_fetch, mock_sleep):
        # Initial sweep returns PR green
        # Re-sweep during settle returns PR + New Workflow -> Drift!
        run_pr = {
            "name": "PR",
            "workflow_id": 1,
            "run_number": 1,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }
        run_new = {
            "name": "Docker Runner check",
            "workflow_id": 2,
            "run_number": 1,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }

        mock_fetch.side_effect = [
            [run_pr],           # initial sweep
            [run_pr, run_new],  # re-sweep after 20s
        ]

        res = sweep_and_evaluate_with_polling(
            repo="org/repo",
            head_sha="sha123",
            token="token",
            applicable_workflow_names={"PR"},
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR", "Docker Runner check"},
            poll_missing_timeout_s=5,
            settle_sleep_s=20,
        )
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "WORKFLOW_SET_DRIFT")

    @patch("ci_aggregate.time.sleep")
    @patch("ci_aggregate.fetch_workflow_runs_for_sha")
    def test_polling_missing_timeout_fails(self, mock_fetch, mock_sleep):
        # Applicable has PR, but fetch returns empty runs repeatedly until timeout
        mock_fetch.return_value = []
        res = sweep_and_evaluate_with_polling(
            repo="org/repo",
            head_sha="sha123",
            token="token",
            applicable_workflow_names={"PR"},
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR"},
            poll_missing_timeout_s=0,
            settle_sleep_s=0,
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "MISSING_APPLICABLE_RUNS")


class TestPaginationTruncationCap(unittest.TestCase):
    @patch("urllib.request.urlopen")
    def test_pagination_cap_fails_closed(self, mock_urlopen):
        mock_resp = MagicMock()
        page_payload = {
            "total_count": 1500,
            "workflow_runs": [{"id": i, "workflow_id": i, "run_number": 1} for i in range(100)],
        }
        mock_resp.read.return_value = (
            __import__("json").dumps(page_payload).encode("utf-8")
        )
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        with self.assertRaises(RuntimeError) as ctx:
            fetch_workflow_runs_for_sha("org/repo", "abcdef1234567890abcdef1234567890abcdef12", "dummy_token")

        self.assertIn("exceeded maximum pagination cap", str(ctx.exception))
        self.assertIn("Fail closed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
