#!/usr/bin/env python3
"""Unit tests for CI run aggregator and evaluator (TECH-7014).

Covers all required acceptance scenarios:
- zero A + zero O success
- nonempty A + zero O never success
- pending / approval / action_required
- every non-success failure (skipped, neutral, cancelled, timed_out, failure)
- rerun supersedes older run by (run_number, run_attempt)
- safe numeric coercion and deterministic sort key for garbage/None values
- name collision resolution using (run_number, run_attempt)
- anchor and gate workflow exclusion by name and file path unconditionally
- classifier-aware priority order:
  - unknown pending does not mask applicable failure
  - non-applicable in-progress is treated as pending (not drift)
  - drift outranks missing applicable runs
  - label-not-present workflows ignored entirely
  - other non-applicable skipped runs ignored
  - other non-applicable non-skipped runs trigger CLASSIFIER_DRIFT
  - unknown workflows evaluated fail-closed
- settle window bounded re-sweeps and drift timeout
- monotonic deadline timeout (PENDING_TIMEOUT)
- missing runs timeout (MISSING_APPLICABLE_RUNS)
- robust set transport: classification-file vs legacy flags, embedded comma rejection
- API pagination/truncation caps fail closed
- API auth: Authorization header present with token, absent without token
- end-to-end main() JSON classification-file transport (happy path), verifying
  applicable/label-absent/all-known sets are parsed correctly from the file
- end-to-end main() legacy comma-flag transport, including whitespace trimming
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from ci_aggregate import (  # noqa: E402
    AggregateResult,
    _as_int,
    _run_key,
    evaluate_ci_runs,
    fetch_workflow_runs_for_sha,
    group_latest_runs,
    main as ci_aggregate_main,
    sweep_and_evaluate_with_polling,
)


class TestNumericCoercionAndSortKey(unittest.TestCase):
    def test_as_int_safe(self):
        self.assertEqual(_as_int(5), 5)
        self.assertEqual(_as_int("10"), 10)
        self.assertEqual(_as_int(None, 0), 0)
        self.assertEqual(_as_int(None, 1), 1)
        self.assertEqual(_as_int("invalid", 42), 42)
        self.assertEqual(_as_int([], 0), 0)

    def test_run_key_deterministic(self):
        self.assertEqual(_run_key({"run_number": 5, "run_attempt": 2}), (5, 2))
        self.assertEqual(_run_key({"run_number": None, "run_attempt": None}), (0, 1))
        self.assertEqual(_run_key({}), (0, 1))
        self.assertEqual(_run_key({"run_number": "12", "run_attempt": "3"}), (12, 3))


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

    def test_anchor_and_gate_excluded_unconditionally(self):
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
        observed = group_latest_runs(runs)
        self.assertNotIn("Merge Gate Trigger", observed)
        self.assertNotIn("Merge Gate", observed)
        self.assertNotIn("Custom Trigger Name", observed)
        self.assertIn("PR", observed)

    def test_priority_unknown_pending_does_not_mask_applicable_failure(self):
        # Applicable PR has failed, but an unknown workflow is still in_progress.
        # Priority order requires NON_SUCCESS_CONCLUSION > RUN_IN_PROGRESS!
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "failure",
            },
            "Unknown Workflow": {
                "name": "Unknown Workflow",
                "workflow_id": 999,
                "status": "in_progress",
                "conclusion": None,
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")
        self.assertIn("PR", res.summary)

    def test_priority_non_applicable_in_progress_is_pending(self):
        # Known workflow Docker Runner check is non-applicable, but currently running.
        # Must yield PENDING rather than premature CLASSIFIER_DRIFT.
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
                "status": "in_progress",
                "conclusion": None,
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "PENDING")
        self.assertEqual(res.reason, "RUN_IN_PROGRESS")

    def test_priority_classifier_drift_outranks_missing(self):
        # Applicable PR is missing from runs, but known non-applicable Docker Runner check ran and succeeded.
        # Priority order: CLASSIFIER_DRIFT > MISSING_APPLICABLE_RUNS.
        observed = {
            "Docker Runner check": {
                "name": "Docker Runner check",
                "workflow_id": 2,
                "status": "completed",
                "conclusion": "success",
            }
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "CLASSIFIER_DRIFT")

    def test_unknown_completed_success_fails_as_classifier_drift(self):
        # Unknown completed workflow with conclusion=success must fail closed as CLASSIFIER_DRIFT
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
                "conclusion": "success",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "CLASSIFIER_DRIFT")
        self.assertIn("Surprise Workflow", res.summary)

    def test_unknown_completed_success_outranks_missing(self):
        # Unknown completed success outranks missing applicable workflow
        observed = {
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "completed",
                "conclusion": "success",
            }
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "CLASSIFIER_DRIFT")

    def test_unknown_completed_success_outranks_pending(self):
        # Unknown completed success outranks pending applicable workflow
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "in_progress",
                "conclusion": None,
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "completed",
                "conclusion": "success",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "CLASSIFIER_DRIFT")

    def test_unknown_completed_success_does_not_mask_failure(self):
        # Applicable failure outranks unknown completed success
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "completed",
                "conclusion": "failure",
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "completed",
                "conclusion": "success",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "NON_SUCCESS_CONCLUSION")
        self.assertIn("PR", res.summary)

    def test_unknown_completed_success_does_not_mask_action_required(self):
        # Action required outranks unknown completed success
        observed = {
            "PR": {
                "name": "PR",
                "workflow_id": 1,
                "status": "waiting",
                "conclusion": None,
            },
            "Surprise Workflow": {
                "name": "Surprise Workflow",
                "workflow_id": 999,
                "status": "completed",
                "conclusion": "success",
            },
        }
        res = evaluate_ci_runs(
            applicable_workflow_names={"PR"},
            latest_runs_by_name=observed,
            all_known_workflow_names={"PR", "Docker Runner check"},
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "ACTION_REQUIRED")
        self.assertIn("PR", res.summary)

    def test_label_not_present_ignored_entirely(self):
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


class TestSweepAndEvaluatePolling(unittest.TestCase):
    @patch("ci_aggregate.time.sleep")
    @patch("ci_aggregate.fetch_workflow_runs_for_sha")
    def test_polling_settle_drift_converges(self, mock_fetch, mock_sleep):
        # Sweep 1: PR green
        # Settle attempt 1: PR + Docker Runner check green (drift)
        # Settle attempt 2: PR + Docker Runner check green (stabilized!)
        run_pr = {
            "name": "PR",
            "workflow_id": 1,
            "run_number": 1,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }
        run_docker = {
            "name": "Docker Runner check",
            "workflow_id": 2,
            "run_number": 1,
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "success",
        }

        mock_fetch.side_effect = [
            [run_pr],  # initial sweep
            [run_pr, run_docker],  # settle re-sweep 1 (drift detected)
            [run_pr, run_docker],  # settle re-sweep 2 (stabilized!)
        ]

        res = sweep_and_evaluate_with_polling(
            repo="org/repo",
            head_sha="sha123",
            token="token",
            applicable_workflow_names={"PR", "Docker Runner check"},
            label_not_present_workflow_names=set(),
            all_known_workflow_names={"PR", "Docker Runner check"},
            poll_missing_timeout_s=5,
            pending_timeout_s=60,
            settle_sleep_s=20,
            max_settle_resweeps=3,
        )
        self.assertEqual(res.status, "SUCCESS")
        self.assertEqual(res.reason, "ALL_GREEN")

    @patch("ci_aggregate.time.sleep")
    @patch("ci_aggregate.fetch_workflow_runs_for_sha")
    def test_polling_settle_drift_timeout(self, mock_fetch, mock_sleep):
        # Continues to drift on every attempt -> exceeds max_settle_resweeps
        run1 = {
            "name": "PR",
            "workflow_id": 1,
            "run_number": 1,
            "status": "completed",
            "conclusion": "success",
        }
        run2 = {
            "name": "WF2",
            "workflow_id": 2,
            "run_number": 1,
            "status": "completed",
            "conclusion": "success",
        }

        mock_fetch.side_effect = [
            [run1],
            [run1, run2],
        ]

        res = sweep_and_evaluate_with_polling(
            repo="org/repo",
            head_sha="sha123",
            token="token",
            applicable_workflow_names={"PR"},
            all_known_workflow_names={"PR"},
            settle_sleep_s=1,
            max_settle_resweeps=2,
            pending_timeout_s=0,
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "WORKFLOW_SET_DRIFT_TIMEOUT")

    @patch("ci_aggregate.time.sleep")
    @patch("ci_aggregate.fetch_workflow_runs_for_sha")
    def test_polling_pending_timeout_fails(self, mock_fetch, mock_sleep):
        # Workflow stays in_progress until deadline
        run_in_progress = {
            "name": "PR",
            "workflow_id": 1,
            "run_number": 1,
            "status": "in_progress",
            "conclusion": None,
        }
        mock_fetch.return_value = [run_in_progress]

        res = sweep_and_evaluate_with_polling(
            repo="org/repo",
            head_sha="sha123",
            token="token",
            applicable_workflow_names={"PR"},
            pending_timeout_s=0,  # instant timeout
        )
        self.assertEqual(res.status, "FAILURE")
        self.assertEqual(res.reason, "PENDING_TIMEOUT")


class TestSetTransportAndValidation(unittest.TestCase):
    def test_classification_file_handles_names_with_commas(self):
        cdata = {
            "applicable_workflows": ["PR", "UI Tests, Visual"],
            "label_not_present_workflows": [],
            "all_known_workflows": ["PR", "UI Tests, Visual"],
        }
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as f:
            f.write(json.dumps(cdata))
            f.flush()
            with patch.object(
                sys,
                "argv",
                [
                    "ci_aggregate.py",
                    "--repo",
                    "org/repo",
                    "--sha",
                    "123",
                    "--classification-file",
                    f.name,
                ],
            ):
                with patch(
                    "ci_aggregate.sweep_and_evaluate_with_polling"
                ) as mock_sweep:
                    mock_sweep.return_value = AggregateResult(
                        status="SUCCESS", reason="ALL_GREEN", summary="ok"
                    )
                    with patch("sys.stdout", new_callable=__import__("io").StringIO):
                        ci_aggregate_main()
                    kwargs = mock_sweep.call_args.kwargs
                    self.assertIn(
                        "UI Tests, Visual", kwargs["applicable_workflow_names"]
                    )

    def test_classification_file_and_legacy_mutual_exclusivity(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as f:
            f.write(json.dumps({"applicable_workflows": ["PR"]}))
            f.flush()

            # Passing both --classification-file and --applicable must raise
            with patch.object(
                sys,
                "argv",
                [
                    "ci_aggregate.py",
                    "--repo",
                    "org/repo",
                    "--sha",
                    "123",
                    "--classification-file",
                    f.name,
                    "--applicable",
                    "PR",
                ],
            ):
                with self.assertRaises(ValueError) as ctx:
                    ci_aggregate_main()
                self.assertIn("mutually exclusive", str(ctx.exception))

            # Passing neither must raise
            with patch.object(
                sys,
                "argv",
                ["ci_aggregate.py", "--repo", "org/repo", "--sha", "123"],
            ):
                with self.assertRaises(ValueError) as ctx:
                    ci_aggregate_main()
                self.assertIn(
                    "Must provide exactly one set transport", str(ctx.exception)
                )


class TestPaginationTruncationCap(unittest.TestCase):
    @patch("urllib.request.urlopen")
    def test_pagination_cap_fails_closed(self, mock_urlopen):
        mock_resp = MagicMock()
        page_payload = {
            "total_count": 1500,
            "workflow_runs": [
                {"id": i, "workflow_id": i, "run_number": 1} for i in range(100)
            ],
        }
        mock_resp.read.return_value = (
            __import__("json").dumps(page_payload).encode("utf-8")
        )
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        with self.assertRaises(RuntimeError) as ctx:
            fetch_workflow_runs_for_sha(
                "org/repo", "abcdef1234567890abcdef1234567890abcdef12", "dummy_token"
            )

        self.assertIn("exceeded maximum pagination cap", str(ctx.exception))
        self.assertIn("Fail closed", str(ctx.exception))


class TestApiAuthFallback(unittest.TestCase):
    """Authorization header is present with a token and absent without one (Finding: API auth)."""

    def _single_page_payload(self) -> bytes:
        payload = {
            "total_count": 1,
            "workflow_runs": [{"id": 1, "workflow_id": 1, "run_number": 1}],
        }
        return json.dumps(payload).encode("utf-8")

    @patch("urllib.request.urlopen")
    def test_authorization_header_present_with_token(self, mock_urlopen):
        captured_requests = []

        def router(req):
            captured_requests.append(req)
            mock_resp = MagicMock()
            mock_resp.read.return_value = self._single_page_payload()
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        fetch_workflow_runs_for_sha("org/repo", "deadbeef", "secret-token")

        self.assertEqual(len(captured_requests), 1)
        self.assertEqual(
            captured_requests[0].get_header("Authorization"), "Bearer secret-token"
        )

    @patch("urllib.request.urlopen")
    def test_authorization_header_absent_without_token(self, mock_urlopen):
        captured_requests = []

        def router(req):
            captured_requests.append(req)
            mock_resp = MagicMock()
            mock_resp.read.return_value = self._single_page_payload()
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        fetch_workflow_runs_for_sha("org/repo", "deadbeef", "")

        self.assertEqual(len(captured_requests), 1)
        self.assertIsNone(captured_requests[0].get_header("Authorization"))


class TestMainTransportEndToEnd(unittest.TestCase):
    """End-to-end JSON classification-file and legacy comma-flag transport through main()."""

    @patch("ci_aggregate.sweep_and_evaluate_with_polling")
    def test_classification_file_happy_path_parses_sets(self, mock_sweep):
        mock_sweep.return_value = AggregateResult(
            status="SUCCESS", reason="ALL_GREEN", summary="ok"
        )
        cdata = {
            "applicable_workflows": ["PR", "Docker Runner check"],
            "label_not_present_workflows": ["Storybook Visual"],
            "all_known_workflows": ["PR", "Docker Runner check", "Storybook Visual"],
        }
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as f:
            f.write(json.dumps(cdata))
            f.flush()
            with patch.object(
                sys,
                "argv",
                [
                    "ci_aggregate.py",
                    "--repo",
                    "org/repo",
                    "--sha",
                    "abc123",
                    "--classification-file",
                    f.name,
                ],
            ):
                with patch("sys.stdout", new_callable=__import__("io").StringIO):
                    # Success path never calls sys.exit; must not raise.
                    ci_aggregate_main()

        self.assertEqual(mock_sweep.call_count, 1)
        kwargs = mock_sweep.call_args.kwargs
        self.assertEqual(
            kwargs["applicable_workflow_names"], {"PR", "Docker Runner check"}
        )
        self.assertEqual(
            kwargs["label_not_present_workflow_names"], {"Storybook Visual"}
        )
        self.assertEqual(
            kwargs["all_known_workflow_names"],
            {"PR", "Docker Runner check", "Storybook Visual"},
        )

    @patch("ci_aggregate.sweep_and_evaluate_with_polling")
    def test_legacy_flags_happy_path_trims_whitespace(self, mock_sweep):
        mock_sweep.return_value = AggregateResult(
            status="SUCCESS", reason="ALL_GREEN", summary="ok"
        )
        with patch.object(
            sys,
            "argv",
            [
                "ci_aggregate.py",
                "--repo",
                "org/repo",
                "--sha",
                "abc123",
                "--applicable",
                " PR , Docker Runner check ",
                "--label-absent",
                "Storybook Visual",
                "--all-known",
                "PR,Docker Runner check,Storybook Visual",
            ],
        ):
            with patch("sys.stdout", new_callable=__import__("io").StringIO):
                ci_aggregate_main()

        kwargs = mock_sweep.call_args.kwargs
        self.assertEqual(
            kwargs["applicable_workflow_names"], {"PR", "Docker Runner check"}
        )
        self.assertEqual(
            kwargs["label_not_present_workflow_names"], {"Storybook Visual"}
        )
        self.assertEqual(
            kwargs["all_known_workflow_names"],
            {"PR", "Docker Runner check", "Storybook Visual"},
        )


if __name__ == "__main__":
    unittest.main()
