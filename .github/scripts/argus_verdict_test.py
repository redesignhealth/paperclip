#!/usr/bin/env python3
"""Unit tests for Argus review verdict evaluator (TECH-7014).

Covers all required acceptance scenarios:
- Argus exact-head approve
- missing review
- non-approve review (e.g. BLOCKING)
- stale review (review exists only for previous SHA)
- malformed review payload
- null verdict
- lowercase 'approve' rejected
- newest-at-SHA blocking newer than approve
- missing and malformed authoritative timestamp fail closed
- non-terminal newest round fails closed
- tied-newest all must be terminal APPROVE
- unexpected verdict string sanitization (no leak of private response values or prose)
- empty SHA rejected
"""

import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from argus_verdict import evaluate_argus_data

HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98"


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
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "VERDICT_BLOCKING")

    def test_stale_review(self):
        # Only review exists for OLD_SHA
        payload = {
            "rounds": [
                {
                    "sha": OLD_SHA,
                    "verdict": "APPROVE",
                    "created_at": "2026-10-01T10:00:00Z",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "STALE_REVIEW")

    def test_malformed_data(self):
        self.assertEqual(evaluate_argus_data(None, HEAD_SHA).reason_code, "MALFORMED_DATA")
        self.assertEqual(evaluate_argus_data("not valid json", HEAD_SHA).reason_code, "MALFORMED_DATA")
        self.assertEqual(evaluate_argus_data(12345, HEAD_SHA).reason_code, "MALFORMED_DATA")

    def test_null_verdict(self):
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": None,
                    "created_at": "2026-10-01T12:00:00Z",
                }
            ]
        }
        res = evaluate_argus_data(payload, HEAD_SHA)
        self.assertFalse(res.passed)
        self.assertEqual(res.reason_code, "INVALID_VERDICT_ENUM")

    def test_lowercase_approve_fails(self):
        # Must be exact uppercase APPROVE
        payload = {
            "rounds": [
                {
                    "sha": HEAD_SHA,
                    "verdict": "approve",
                    "created_at": "2026-10-01T12:00:00Z",
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
                },
                {
                    "sha": HEAD_SHA,
                    "verdict": "BLOCKING",
                    "created_at": "2026-10-01T11:00:00Z",
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
                }
            ]
        }
        res_malformed = evaluate_argus_data(payload_malformed, HEAD_SHA)
        self.assertFalse(res_malformed.passed)
        self.assertEqual(res_malformed.reason_code, "MISSING_OR_MALFORMED_TIMESTAMP")

    def test_nonterminal_newest_round_fails(self):
        # current_stage: "running"
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
        res_running = evaluate_argus_data(payload_running, HEAD_SHA)
        self.assertFalse(res_running.passed)
        self.assertEqual(res_running.reason_code, "NON_TERMINAL_ROUND")

    def test_tied_newest_all_approve(self):
        # Two reviews at exact same timestamp, both terminal APPROVE -> PASS
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

        # Two reviews at exact same timestamp, one is BLOCKING -> FAIL
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

        # Two reviews at exact same timestamp, one is non-terminal -> FAIL
        payload_nonterm = {
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
                    "current_stage": "running",
                },
            ]
        }
        res_nonterm = evaluate_argus_data(payload_nonterm, HEAD_SHA)
        self.assertFalse(res_nonterm.passed)
        self.assertEqual(res_nonterm.reason_code, "NON_TERMINAL_ROUND")

    def test_unexpected_verdict_sanitization(self):
        # Sensitive prose string must NOT be echoed in summary or details
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
                }
            ]
        }
        self.assertEqual(evaluate_argus_data(payload, "").reason_code, "EMPTY_SHA")
        self.assertEqual(evaluate_argus_data(payload, "   ").reason_code, "EMPTY_SHA")


if __name__ == "__main__":
    unittest.main()
