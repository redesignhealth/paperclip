#!/usr/bin/env python3
"""Unit tests for CI run aggregator and evaluator (TECH-7014).

Covers all required acceptance scenarios:
- zero A + zero O success
- nonempty A + zero O never success
- pending / approval / action_required
- every non-success failure (skipped, neutral, cancelled, timed_out, failure)
- rerun supersedes older run by run_number
- anchor workflow (Merge Gate Trigger) excluded
- unexpected observed workflows evaluated
- API pagination/truncation caps fail closed
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from ci_aggregate import (
    MAX_PAGES,
    evaluate_ci_runs,
    fetch_workflow_runs_for_sha,
    group_latest_runs,
)


class TestCIAggregateEvaluation(unittest.TestCase):
    def test_zero_a_zero_o_success(self):
        # Docs-only / zero applicable and zero observed
        res = evaluate_ci_runs(set(), {})
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ZERO_RUNS_APPLICABLE")
        self.assertIn("documentation-only", res.summary)

    def test_nonempty_a_zero_o_never_success(self):
        # Applicable workflows exist, but none have run
        res = evaluate_ci_runs({"PR"}, {})
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "MISSING_APPLICABLE_RUNS")

    def test_pending_in_progress(self):
        O = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "in_progress",
                "conclusion": None,
            }
        }
        res = evaluate_ci_runs({"PR"}, O)
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")

    def test_pending_queued(self):
        O = {
            "Docker Runner check": {
                "name": "Docker Runner check",
                "workflow_id": 2,
                "status": "queued",
                "conclusion": None,
            }
        }
        res = evaluate_ci_runs({"Docker Runner check"}, O)
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")

    def test_waiting_and_action_required(self):
        O1 = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "waiting",
                "conclusion": None,
            }
        }
        res1 = evaluate_ci_runs({"PR"}, O1)
        self.assertEqual(res1.status, "FAILURE")
        self.assertEqual(res1.reason, "ACTION_REQUIRED")

        O2 = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "action_required",
            }
        }
        res2 = evaluate_ci_runs({"PR"}, O2)
        self.assertEqual(res2.status, "FAILURE")
        self.assertEqual(res2.reason, "ACTION_REQUIRED")

    def test_every_non_success_conclusion_fails(self):
        for conclusion in ["failure", "skipped", "neutral", "cancelled", "timed_out"]:
            with self.subTest(conclusion=conclusion):
                O = {
                    "PR": {
                        "name": "PR",
                        "workflow_id": 1,
                        "status": "completed",
                        "conclusion": conclusion,
                    }
                }
                res = evaluate_ci_runs({"PR"}, O)
                self.assertEqual(res.status, "FAILURE")
                self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")

    def test_rerun_supersedes(self):
        runs = [
            {
                "name": "PR",
                "workflow_id": 1,
                "run_number": 1,
                "status": "completed",
                "conclusion": "failure",
            },
            {
                "name": "PR",
                "workflow_id": 1,
                "run_number": 2,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        O = group_latest_runs(runs)
        self.assertEqual(len(O), 1)
        self.assertEqual(O["PR"]["run_number"], 2)
        self.assertEqual(O["PR"]["conclusion"], "success")

        res = evaluate_ci_runs({"PR"}, O)
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")

    def test_anchor_excluded(self):
        runs = [
            {
                "name": "Merge Gate Trigger",
                "workflow_id": 999,
                "run_number": 1,
                "status": "completed",
                "conclusion": "success",
            },
            {
                "name": "PR",
                "workflow_id": 1,
                "run_number": 1,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        O = group_latest_runs(runs, exclude_anchor=True)
        self.assertNotIn("Merge Gate Trigger", O)
        self.assertIn("PR", O)

    def test_unexpected_observed_evaluated(self):
        O = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            },
            "Unplanned Workflow": {
                "name": "Unplanned Workflow",
                "workflow_id": 99,
                "status": "completed",
                "conclusion": "failure",
            },
        }
        res = evaluate_ci_runs({"PR"}, O)
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")
        self.assertIn("Unplanned Workflow", res.summary)

        O["Unplanned Workflow"]["conclusion"] = "success"
        res_ok = evaluate_ci_runs({"PR"}, O)
        self.assertEqual(res_ok.status, "SUCCESS")
        self.assertEqual(res_ok.reason, "ALL_GREEN")

    def test_missing_one_of_multiple_applicable(self):
        O = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "success",
            }
        }
        res = evaluate_ci_runs({"PR", "Docker Runner check"}, O)
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "MISSING_APPLICABLE_RUNS")
        self.assertIn("Docker Runner check", res.summary)


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
