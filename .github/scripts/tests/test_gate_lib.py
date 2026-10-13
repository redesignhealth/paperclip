import io
import unittest
import urllib.error
from unittest import mock

import _path  # noqa: F401
import gate_lib
from gate_lib import GateError
from fakes import SHA, pr


class ParseTests(unittest.TestCase):
    def test_pr_number_accepts_only_positive_decimal_integers(self):
        self.assertEqual(gate_lib.parse_pr_number("123"), 123)
        self.assertEqual(gate_lib.parse_pr_number(44), 44)
        for bad in ["0", "-1", "01", "1.5", " 1", "1 ", "1\n", "", "abc", "1e3", "+1", None, True, False, 1.0, "9" * 10, "١٢"]:
            with self.subTest(bad=bad), self.assertRaises(GateError):
                gate_lib.parse_pr_number(bad)

    def test_full_sha_only(self):
        self.assertTrue(gate_lib.is_full_sha(SHA))
        for bad in ["", "a" * 39, "a" * 41, "A" * 40, "g" * 40, None, 5, SHA + "\n", "master"]:
            with self.subTest(bad=bad):
                self.assertFalse(gate_lib.is_full_sha(bad))

    def test_safe_token_hides_pr_controlled_strings(self):
        self.assertEqual(gate_lib.safe_token("warm-cache"), "warm-cache")
        self.assertEqual(gate_lib.safe_token("x\n::error::boom"), "(unrecognized)")
        self.assertEqual(gate_lib.safe_token("a" * 65, "z"), "z")

    def test_workflow_path_strips_ref_and_rejects_non_files(self):
        self.assertEqual(gate_lib.workflow_path({"path": ".github/workflows/a.yml@refs/heads/x"}), ".github/workflows/a.yml")
        self.assertIsNone(gate_lib.workflow_path({"path": "dynamic/copilot"}))
        self.assertIsNone(gate_lib.workflow_path({"path": ".github/workflows/../../x.yml"}))
        self.assertIsNone(gate_lib.workflow_path({}))


class EligibilityTests(unittest.TestCase):
    def test_ok_internal_and_fork(self):
        self.assertIsNone(gate_lib.pr_ineligibility(pr()))
        # Public fork PRs with positive integer head repo ID are eligible
        self.assertIsNone(gate_lib.pr_ineligibility(pr(head_repo=987654321)))

    def test_rejections(self):
        cases = {
            "NOT_OPEN": pr(state="closed"),
            "WRONG_BASE": pr(base="release"),
            "WRONG_BASE_MAIN": pr(base="main"),  # base must be master, not main
            "WRONG_BASE_RH_ID": pr(base_repo=1326026498),  # rh-paperclip repo ID is not allowed
            "WRONG_BASE_UPSTREAM_ID": pr(base_repo=1170821064),  # upstream paperclipai repo ID not allowed
            "FORK_OR_MISSING_HEAD_REPO_DELETED": pr(head_repo=None),  # fork deleted
            "FORK_OR_MISSING_HEAD_REPO_ZERO": pr(head_repo=0),
            "AUTHOR_IS_GATE_APP": pr(author="rh-pr-approval-gate[bot]"),
            "AUTHOR_IS_GATE_APP_UPPER": pr(author="RH-PR-Approval-Gate[bot]"),
            "MALFORMED_PR": pr(author=""),
            "INVALID_HEAD_SHA": pr(sha="abc"),
        }
        for code, value in cases.items():
            expected_code = "WRONG_BASE" if code.startswith("WRONG_BASE") else ("FORK_OR_MISSING_HEAD_REPO" if code.startswith("FORK_OR_MISSING_HEAD_REPO") else ("AUTHOR_IS_GATE_APP" if code.startswith("AUTHOR_IS_GATE_APP") else code))
            with self.subTest(code=code):
                self.assertEqual(gate_lib.pr_ineligibility(value), expected_code)
        self.assertEqual(gate_lib.pr_ineligibility(None), "MALFORMED_PR")

    def test_head_moved(self):
        self.assertEqual(gate_lib.pr_ineligibility(pr(sha="b" * 40), expected_head=SHA), "HEAD_MOVED")
        self.assertIsNone(gate_lib.pr_ineligibility(pr(), expected_head=SHA))

    def test_hostile_title_body_and_labels_are_ignored_and_never_gate_a_pr(self):
        hostile = pr(extra={"title": "::error::pwned", "body": "::add-mask::SECRET\nshell-injection",
                            "labels": [{"name": "::error::label"}]})
        self.assertIsNone(gate_lib.pr_ineligibility(hostile))
        self.assertIsNone(gate_lib.pr_ineligibility(hostile, expected_head=SHA))


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class RequestTests(unittest.TestCase):
    def test_only_fixed_bases_and_clean_paths(self):
        with self.assertRaises(GateError) as c:
            gate_lib.request_json("https://evil.example", "/x", headers={})
        self.assertEqual(c.exception.code, "BASE_URL_NOT_ALLOWED")
        for p in ["x", "//evil.example/x", "/a\r\nHost: evil", "/a\\b"]:
            with self.subTest(p=p), self.assertRaises(GateError):
                gate_lib.request_json(gate_lib.GITHUB_API, p, headers={})

    def test_redirects_are_refused(self):
        handler = gate_lib._NoRedirect()
        self.assertIsNone(handler.redirect_request(mock.Mock(), mock.Mock(), 302, "Found", {}, "https://evil.example"))

    def test_get_retries_on_5xx_but_post_never_does(self):
        calls = []

        def boom(req, timeout):
            calls.append(req.get_method())
            raise urllib.error.HTTPError(req.full_url, 502, "bad", {}, None)

        with mock.patch.object(gate_lib, "_urlopen", boom), mock.patch.object(gate_lib.time, "sleep"):
            with self.assertRaises(GateError) as c:
                gate_lib.request_json(gate_lib.GITHUB_API, "/x", headers={})
            self.assertEqual(c.exception.code, "HTTP_502")
            self.assertEqual(calls, ["GET"] * 3)
            calls.clear()
            with self.assertRaises(GateError):
                gate_lib.request_json(gate_lib.GITHUB_API, "/x", headers={}, method="POST", body={})
            self.assertEqual(calls, ["POST"])

    def test_4xx_is_not_retried_and_body_never_leaks(self):
        calls = []

        def forbidden(req, timeout):
            calls.append(1)
            raise urllib.error.HTTPError(req.full_url, 403, "SECRET-BODY", {}, io.BytesIO(b"SECRET-BODY"))

        with mock.patch.object(gate_lib, "_urlopen", forbidden):
            with self.assertRaises(GateError) as c:
                gate_lib.request_json(gate_lib.ARGUS_API, "/x", headers={"X-API-Key": "k"})
        self.assertEqual(len(calls), 1)
        self.assertNotIn("SECRET", str(c.exception))
        self.assertEqual(c.exception.code, "HTTP_403")

    def test_write_output_rejects_newlines(self):
        with self.assertRaises(GateError):
            gate_lib.write_output("k", "v\nbad", None)
        with self.assertRaises(GateError):
            gate_lib.write_output("k", "v\rbad", None)


class GitHubClientTests(unittest.TestCase):
    def test_token_required(self):
        with self.assertRaises(GateError):
            gate_lib.GitHub("")

    def test_paginate_collects_and_respects_limits(self):
        gh = gate_lib.GitHub("tok")
        with mock.patch.object(gh, "get") as m:
            m.side_effect = [{"items": [1, 2]}, {"items": [3]}]
            res = gh.paginate("/x", "items", per_page=2, max_pages=5)
            self.assertEqual(res, [1, 2, 3])

        with mock.patch.object(gh, "get") as m:
            m.return_value = {"items": [1, 2]}
            with self.assertRaises(GateError) as c:
                gh.paginate("/x", "items", per_page=2, max_pages=2)
            self.assertEqual(c.exception.code, "PAGINATION_LIMIT")


if __name__ == "__main__":
    unittest.main()
