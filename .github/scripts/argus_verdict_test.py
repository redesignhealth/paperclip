#!/usr/bin/env python3
"""Unit tests for Argus review verdict evaluator (TECH-7014).

Covers all required acceptance scenarios:
- Argus exact-head approve
- missing review
- non-approve review (e.g. BLOCKING)
- stale review (review exists only for previous SHA)
- malformed review payload (requires canonical {'rounds': [...]})
- null verdict
- lowercase 'approve' rejected
- newest-at-SHA blocking newer than approve
- missing and malformed authoritative timestamp fail closed
- timezone-naive timestamps fail closed
- first present timestamp key used without falsy-OR fallback
- missing, null, and nonterminal (running/planning) current_stage fail closed
- accepted terminal 'completed' stage passes
- tied-newest all must be terminal APPROVE
- unexpected verdict and stage string sanitization (no leak of private values or prose)
- empty SHA rejected
- dedicated timestamp parsing unit tests
- CLI entrypoint tests (--sha, --input-file, stdin, output format, exit codes)
"""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from argus_verdict import evaluate_argus_data, main as argus_main, parse_iso_timestamp  # noqa: E402

HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98"


class TestParseIsoTimestamp(unittest.TestCase):
    def test_utc_z_suffix(self):
        ts_upper = parse_iso_timestamp("2026-10-01T12:00:00Z")
        self.assertIsNotNone(ts_upper)

        # Lowercase z suffix accepted (Requirement 13)
        ts_lower = parse_iso_timestamp("2026-10-01T12:00:00z")
        self.assertIsNotNone(ts_lower)
        self.assertEqual(ts_upper, ts_lower)

    def test_explicit_offset(self):
        ts = parse_iso_timestamp("2026-10-01T12:00:00+00:00")
        self.assertIsNotNone(ts)

        ts_est = parse_iso_timestamp("2026-10-01T08:00:00-04:00")
        self.assertIsNotNone(ts_est)
        self.assertEqual(ts, ts_est)

    def test_naive_timestamp_rejected(self):
        # Timezone-naive timestamp must return None (fail closed)
        self.assertIsNone(parse_iso_timestamp("2026-10-01T12:00:00"))

    def test_whitespace_and_invalid(self):
        self.assertIsNone(parse_iso_timestamp(""))
        self.assertIsNone(parse_iso_timestamp("   "))
        self.assertIsNone(parse_iso_timestamp(None))
        self.assertIsNone(parse_iso_timestamp(12345))
        self.assertIsNone(parse_iso_timestamp("not-a-timestamp"))


class TestArgusVerdict(unittest.TestCase):
    def test_exact_head_approve(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertTrue(res.passed)
        self.assertEqual(res.reason_code, "EXACT_HEAD_APPROVE")

    def test_lowercase_z_timestamp_approval(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertTrue(res.passed)
        self.assertEqual(res.reason_code, "EXACT_HEAD_APPROVE")

    def test_canonical_rounds_schema_required(self):
        # Bare list rejected (must be {"rounds": [...]})
        bare_list = [
            {
                "sha": HEAD_SHA,
                "verdict": "APPROVE",
                "created_at": "2026-10-01T12:00:00Z",
                "current_stage": "completed",
            }
        ]
        self.assertEqual(
            evaluate_argus_data(bare_list, HEAD_SHA).reason_code, "MALFORMED_DATA"
        )

        # Unknown wrapper dict rejected
        unknown_wrapper = {"reviews": bare_list}
        self.assertEqual(
            evaluate_argus_data(unknown_wrapper, HEAD_SHA).reason_code, "MALFORMED_DATA"
        )

    def test_first_present_timestamp_key_without_falsy_fallback(self):
        # If created_at is present as empty string, it must not fall back to date
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "",
                    "date": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "MISSING_OR_MALFORMED_TIMESTAMP")

    def test_missing_review(self):
        payload = {"rounds": []}
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "MISSING_REVIEW")

    def test_nonapprove_verdict(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "BLOCKING",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "VERDICT_BLOCKING")

    def test_stale_review(self):
        payload = {
            "rounds": [
                {
                    "sha": OLD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T10:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "STALE_REVIEW")

    def test_malformed_data(self):
        self.assertEqual(
            evaluate_argus_data(None, HEAD_SHA).reason_code, "MALFORMED_DATA"
        )
        self.assertEqual(
            evaluate_argus_data("not valid json", HEAD_SHA).reason_code,
            "MALFORMED_DATA",
        )
        self.assertEqual(
            evaluate_argus_data(12345, HEAD_SHA).reason_code, "MALFORMED_DATA"
        )

    def test_null_verdict(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": None,
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "INVALID_VERDICT_ENUM")

    def test_lowercase_approve_fails(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "approve",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "INVALID_VERDICT_ENUM")

    def test_newest_at_sha_blocking_newer_than_approve(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T10:00:00Z",
                    "current_stage": "completed",
                },
                {
                    "sha": HEAD_SHA,
                    "verdict": "BLOCKING",
                    "created_at": "2026-10-01T11:00:00Z",
                    "current_stage": "completed",
                },
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "VERDICT_BLOCKING")

    def test_missing_and_malformed_authoritative_timestamp_fails(self):
        # Missing created_at on exact-SHA round
        payload_missing = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "current_stage": "completed",
                }
            ]
        }
        res_missing = evaluate_argus_data(payload_missing, HEAD_SHA)
        self.assertFalse(res_missing.passed)
        self.assertEqual(res_missing.reason_code, "MISSING_OR_MALFORMED_TIMESTAMP")

        # Malformed timestamp
        payload_malformed = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "unparseable-date",
                    "current_stage": "completed",
                }
            ]
        }
        res_malformed = evaluate_argus_data(payload_malformed, HEAD_SHA)
        self.assertFalse(res_malformed.passed)
        self.assertEqual(res_malformed.reason_code, "MISSING_OR_MALFORMED_TIMESTAMP")

    def test_missing_current_stage_fails(self):
        payload_no_stage = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                }
            ]
        }
        res = evaluate_argus_data(payload_no_stage, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "NON_TERMINAL_ROUND")

    def test_null_current_stage_fails(self):
        payload_null_stage = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": None,
                }
            ]
        }
        res = evaluate_argus_data(payload_null_stage, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "NON_TERMINAL_ROUND")

    def test_running_current_stage_fails(self):
        payload_running = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "running",
                }
            ]
        }
        res = evaluate_argus_data(payload_running, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "NON_TERMINAL_ROUND")

    def test_unexpected_nonterminal_stage_fails_and_sanitizes(self):
        secret_stage = "CONFIDENTIAL_PROGRESS_STAGE_123"
        payload_stage = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": secret_stage,
                }
            ]
        }
        res = evaluate_argus_data(payload_stage, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "NON_TERMINAL_ROUND")
        self.assertNotIn(secret_stage, res.summary)
        self.assertNotIn(secret_stage, str(res.details))

    def test_tied_newest_all_approve(self):
        payload_pass = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                },
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                },
            ]
        }
        res_pass = evaluate_argus_data(payload_pass, HEAD_SHA)
        self.assertTrue(res_pass.passed)
        self.assertEqual(res_pass.reason_code, "EXACT_HEAD_APPROVE")

        payload_fail = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                },
                {
                    "sha": HEAD_SHA,
                    "verdict": "BLOCKING",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                },
            ]
        }
        res_fail = evaluate_argus_data(payload_fail, HEAD_SHA)
        self.assertFalse(res_fail.passed)
        self.assertEqual(res_fail.reason_code, "VERDICT_BLOCKING")

        payload_missing_stage = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                },
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                },
            ]
        }
        res_missing_stage = evaluate_argus_data(payload_missing_stage, HEAD_SHA)
        self.assertFalse(res_missing_stage.passed)
        self.assertEqual(res_missing_stage.reason_code, "NON_TERMINAL_ROUND")

    def test_unexpected_verdict_sanitization(self):
        secret_leak = "AWS_SECRET_PROSE_LEAK_12345"
        payload_leak = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": secret_leak,
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload_leak, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "INVALID_VERDICT_ENUM")
        self.assertNotIn(secret_leak, res.summary)
        self.assertNotIn(secret_leak, str(res.details))

    def test_empty_sha(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        self.assertEqual(evaluate_argus_data(payload, "").reason_code, "EMPTY_SHA")
        self.assertEqual(evaluate_argus_data(payload, "   ").reason_code, "EMPTY_SHA")

    def test_expected_sha_strict_no_whitespace_laundering(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        # Padded expected_sha MUST NOT be laundered to valid 40-hex
        res_padded = evaluate_argus_data(payload, f" {HEAD_SHA} ")
        self.assertFalse(res_padded.passed)
        self.assertEqual(res_padded.reason_code, "INVALID_INPUT")
        self.assertIn("not strict 40-hex", res_padded.summary)

        res_malformed = evaluate_argus_data(payload, "not-a-40-hex-sha")
        self.assertFalse(res_malformed.passed)
        self.assertEqual(res_malformed.reason_code, "INVALID_INPUT")

    def test_stored_review_compatible_whitespace_and_case_allowed(self):
        # Stored records in review DB may have whitespace or uppercase; compatibility normalizer handles this
        payload = {
            "rounds": [
                {
                    "sha": f"  {HEAD_SHA.upper()} \n",
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertTrue(res.passed)
        self.assertEqual(res.reason_code, "EXACT_HEAD_APPROVE")


class TestArgusCli(unittest.TestCase):
    def test_cli_stdin_success(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        raw = json.dumps(payload)
        with patch.object(sys, "argv", ["argus_verdict.py", "--sha", HEAD_SHA]):
            with patch("sys.stdin", io.StringIO(raw)):
                with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                    # On pass, exit is not called (or exits 0)
                    try:
                        argus_main()
                    except SystemExit as e:
                        self.assertEqual(e.code, 0)
                    out = json.loads(mock_stdout.getvalue())
                    self.assertTrue(out["passed"])
                    self.assertEqual(out["reason_code"], "EXACT_HEAD_APPROVE")

    def test_cli_input_file_failure(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "BLOCKING",
                    "created_at": "2026-10-01T12:00:00Z",
                    "current_stage": "completed",
                }
            ]
        }
        with tempfile.NamedTemporaryFile("w+", suffix=".json") as f:
            f.write(json.dumps(payload))
            f.flush()
            with patch.object(
                sys,
                "argv",
                ["argus_verdict.py", "--sha", HEAD_SHA, "--input-file", f.name],
            ):
                with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                    with self.assertRaises(SystemExit) as ctx:
                        argus_main()
                    self.assertEqual(ctx.exception.code, 1)
                    out = json.loads(mock_stdout.getvalue())
                    self.assertFalse(out["passed"])
                    self.assertEqual(out["reason_code"], "VERDICT_BLOCKING")


if __name__ == "__main__":
    unittest.main()
