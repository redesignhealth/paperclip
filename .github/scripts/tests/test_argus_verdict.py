import subprocess
import unittest
from unittest import mock

import _path  # noqa: F401
import argus_verdict as av
import gate_lib
from gate_lib import GateError
from fakes import SHA, SHA2

PR = 7


def rnd(sha=SHA, verdict="APPROVE", stage="completed", ts="2026-10-12T10:00:00Z", pr=PR, repo=gate_lib.REPO):
    return {"repo": repo, "pr_number": pr, "sha": sha, "current_stage": stage, "created_at": ts, "verdict": verdict}


def ev(rounds, sha=SHA):
    return av.evaluate({"rounds": rounds}, sha, PR)


class EvaluateTests(unittest.TestCase):
    def test_terminal_approve_at_head_passes(self):
        r = ev([rnd()])
        self.assertTrue(r.passed)
        self.assertEqual(r.code, "EXACT_HEAD_APPROVE")

    def test_no_rounds_and_other_sha_are_pending_not_pass(self):
        self.assertEqual(ev([]).state, "pending")
        self.assertEqual(ev([]).code, "MISSING_REVIEW")
        self.assertEqual(ev([rnd(sha=SHA2)]).code, "STALE_REVIEW")

    def test_older_approve_never_rescues_newer_blocking(self):
        r = ev([rnd(verdict="BLOCKING", ts="2026-10-12T11:00:00Z"), rnd(ts="2026-10-12T10:00:00Z")])
        self.assertEqual(r.state, "blocking")
        # and the order in the list is irrelevant
        r = ev([rnd(ts="2026-10-12T10:00:00Z"), rnd(verdict="BLOCKING", ts="2026-10-12T11:00:00Z")])
        self.assertEqual(r.state, "blocking")

    def test_newer_approve_after_blocking_passes(self):
        self.assertTrue(ev([rnd(verdict="BLOCKING", ts="2026-10-12T10:00:00Z"), rnd(ts="2026-10-12T11:00:00Z")]).passed)

    def test_genuine_three_round_history_newest_negative_overrides_older_approves(self):
        # A real re-review chain at one head: approve, re-run approve, then the
        # newest round goes BLOCKING -- the newest timestamp decides, no fallback.
        history = [
            rnd(ts="2026-10-12T10:00:00Z"),                        # approve (oldest)
            rnd(ts="2026-10-12T11:00:00Z"),                        # approve again
            rnd(verdict="BLOCKING", ts="2026-10-12T12:00:00Z"),    # newest: negative
        ]
        self.assertEqual(ev(history), ev(list(reversed(history))))  # order-independent
        r = ev(history)
        self.assertEqual((r.state, r.code), ("blocking", "VERDICT_BLOCKING"))
        # and the mirror image: blocking, then two newer approvals passes
        mirror = [
            rnd(verdict="BLOCKING", ts="2026-10-12T10:00:00Z"),
            rnd(ts="2026-10-12T11:00:00Z"),
            rnd(ts="2026-10-12T12:00:00Z"),
        ]
        self.assertTrue(ev(mirror).passed)

    def test_every_tie_at_the_newest_instant_must_approve(self):
        r = ev([rnd(), rnd(verdict="BLOCKING")])
        self.assertEqual(r.state, "blocking")
        r = ev([rnd(), rnd(stage="running")])
        self.assertEqual(r.state, "pending")
        self.assertFalse(r.passed)

    def test_non_terminal_newest_is_pending_even_with_older_approve(self):
        r = ev([rnd(stage="running", ts="2026-10-12T11:00:00Z"), rnd(ts="2026-10-12T10:00:00Z")])
        self.assertEqual((r.state, r.code), ("pending", "NON_TERMINAL_ROUND"))

    def test_invalid_verdicts_fail_closed(self):
        for v in [None, "approve", "REQUEST_CHANGES", "", 5]:
            with self.subTest(v=v):
                self.assertEqual(ev([rnd(verdict=v)]).state, "error")

    def test_timestamps_must_be_timezone_aware_and_valid(self):
        for ts in [None, "", "yesterday", "2026-10-12T10:00:00", 5]:
            with self.subTest(ts=ts):
                self.assertEqual(ev([rnd(ts=ts)]).code, "MALFORMED_TIMESTAMP")
        self.assertTrue(ev([rnd(ts="2026-10-12T06:00:00-04:00")]).passed)

    def test_timestamp_of_other_sha_rounds_is_not_inspected(self):
        self.assertTrue(ev([rnd(), rnd(sha=SHA2, ts="garbage")]).passed)

    def test_equivalent_instants_in_different_offsets_are_ties(self):
        # 10:00Z == 06:00-04:00: the server stamps tie, so every tied round must approve.
        self.assertTrue(ev([rnd(ts="2026-10-12T10:00:00Z"), rnd(ts="2026-10-12T06:00:00-04:00")]).passed)
        r = ev([rnd(ts="2026-10-12T10:00:00Z"), rnd(verdict="BLOCKING", ts="2026-10-12T06:00:00-04:00")])
        self.assertEqual((r.state, r.code), ("blocking", "VERDICT_BLOCKING"))
        r = ev([rnd(ts="2026-10-12T10:00:00Z"), rnd(stage="running", ts="2026-10-12T06:00:00-04:00")])
        self.assertEqual((r.state, r.code), ("pending", "NON_TERMINAL_ROUND"))

    def test_one_malformed_timestamp_among_tied_rounds_fails_closed(self):
        self.assertEqual(ev([rnd(ts="2026-10-12T10:00:00Z"), rnd(ts=None)]).code, "MALFORMED_TIMESTAMP")

    def test_fractional_seconds_and_surrounding_whitespace_are_valid(self):
        self.assertTrue(ev([rnd(ts=" 2026-10-12T10:00:00.123456Z ")]).passed)
        self.assertTrue(ev([rnd(ts="2026-10-12T10:00:00.5+00:00")]).passed)

    def test_identity_mismatch_fails_closed(self):
        self.assertEqual(ev([rnd(pr=8)]).code, "ROUND_IDENTITY_MISMATCH")
        self.assertEqual(ev([rnd(repo="redesignhealth/other")]).code, "ROUND_IDENTITY_MISMATCH")
        self.assertEqual(ev([rnd(pr=True)]).code, "ROUND_IDENTITY_MISMATCH")

    def test_malformed_shapes(self):
        for raw in [None, [], "x", {"rounds": "no"}, {"data": []}, {}]:
            with self.subTest(raw=raw):
                self.assertEqual(av.evaluate(raw, SHA, PR).state, "error")
        self.assertEqual(av.evaluate({"rounds": [5]}, SHA, PR).code, "MALFORMED_ROUND")
        self.assertEqual(av.evaluate({"rounds": []}, "short", PR).code, "INVALID_SHA")

    def test_hostile_review_text_is_never_echoed(self):
        r = ev([{**rnd(), "review_comment": "::error::SECRET", "verdict": "BLOCKING\n::add-mask::x"}])
        self.assertNotIn("SECRET", r.summary + r.code)
        self.assertNotIn("::", r.summary + r.code)


class CheckTests(unittest.TestCase):
    def test_api_failures_are_errors_never_approve(self):
        for code in ["HTTP_401", "HTTP_403", "HTTP_500", "NETWORK_ERROR", "MALFORMED_RESPONSE"]:
            with self.subTest(code=code), mock.patch.object(av, "fetch_reviews", side_effect=GateError(code)):
                r = av.check(PR, SHA, "k")
                self.assertEqual((r.state, r.code), ("error", f"ARGUS_API_{code}"))
                self.assertFalse(r.passed)

    def test_success_path_uses_fixed_endpoint(self):
        seen = {}

        def fake(base, path, **kw):
            seen.update(base=base, path=path, headers=kw["headers"])
            return {"rounds": [rnd()]}

        with mock.patch.object(gate_lib, "request_json", fake):
            self.assertTrue(av.check(PR, SHA, "key-value").passed)
        self.assertEqual(seen["base"], "https://api.core.redesignhealth.com")
        self.assertEqual(seen["path"], f"/api/v1/code-review/storage/reviews/{gate_lib.OWNER}/{gate_lib.REPO_NAME}/7")
        self.assertEqual(seen["headers"]["X-API-Key"], "key-value")


class KeyTests(unittest.TestCase):
    def _run(self, stdout="", exc=None):
        def fake(cmd, **kw):
            self.cmd = cmd
            if exc:
                raise exc
            return subprocess.CompletedProcess(cmd, 0, stdout, "")
        return mock.patch.object(av.subprocess, "run", fake)

    def test_fixed_name_region_and_mask(self):
        with self._run("abcdEFGH12345678\n"), mock.patch("builtins.print") as pr_:
            self.assertEqual(av.fetch_api_key(), "abcdEFGH12345678")
        pr_.assert_called_once_with("::add-mask::abcdEFGH12345678")
        self.assertEqual(self.cmd[self.cmd.index("--name") + 1], "/general/prod/api-secret-key")
        self.assertEqual(self.cmd[self.cmd.index("--region") + 1], "us-east-1")

    def test_failures_and_garbage_fail_closed_without_detail(self):
        for out in ["None", "", "has space in it 12345", "short"]:
            with self.subTest(out=out), self._run(out):
                with self.assertRaises(GateError):
                    av.fetch_api_key()
        with self._run(exc=subprocess.CalledProcessError(1, "aws", stderr="SECRET")):
            with self.assertRaises(GateError) as c:
                av.fetch_api_key()
        self.assertEqual(c.exception.code, "ARGUS_KEY_UNAVAILABLE")
        self.assertNotIn("SECRET", str(c.exception))


if __name__ == "__main__":
    unittest.main()
