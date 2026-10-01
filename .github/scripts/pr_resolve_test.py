#!/usr/bin/env python3
"""Unit tests for canonical Pull Request and SHA resolver (TECH-7014).

Covers all required acceptance scenarios:
- workflow_dispatch with valid PR and matching SHA succeeds
- workflow_dispatch with SHA mismatch fails closed
- workflow_dispatch with closed PR or wrong base branch fails closed
- workflow_dispatch with null head falls back to requested SHA
- workflow_run with single matching candidate succeeds
- workflow_run with fork PR candidate succeeds
- workflow_run with duplicate-head PR ambiguity fails closed
- workflow_run with stale live head skips cleanly
- workflow_run with null live head handled safely without AttributeError
- workflow_run with 0 candidates after full enumeration skips cleanly
- workflow_run with 5-page / 500 open PRs cap exhaustion fails closed
- workflow_run with 1 matching candidate under cap exhaustion still fails closed
- commit-associated lookup 404/network error warns and falls back to pagination
- commit-associated lookup 403/401/429 fails closed immediately
- structural hydration of partial candidates via REST
- workflow_run hydration REST failure for a gathered candidate fails closed
- make_github_request Authorization header present with token, absent without
- make_github_request wraps a real urllib HTTPError into GitHubAPIError with
  status code and decoded body preserved
"""

import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from pr_resolve import (  # noqa: E402
    GitHubAPIError,
    filter_hydrated_candidates,
    make_github_request,
    resolve_workflow_dispatch_pr,
    resolve_workflow_run_pr,
)

HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
REPO = "redesignhealth/paperclip"
DEFAULT_BRANCH = "master"


class TestPrResolve(unittest.TestCase):
    def test_filter_hydrated_candidates_strict(self):
        # Valid candidate
        cand = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        res = filter_hydrated_candidates([cand], HEAD_SHA, DEFAULT_BRANCH, REPO)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["number"], 28)

        # Fork PR
        fork_cand = {
            "number": 29,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": "contributor/paperclip"}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        res_fork = filter_hydrated_candidates(
            [fork_cand], HEAD_SHA, DEFAULT_BRANCH, REPO
        )
        self.assertEqual(len(res_fork), 1)

        # Closed PR excluded
        closed_cand = dict(cand, state="closed")
        self.assertEqual(
            filter_hydrated_candidates([closed_cand], HEAD_SHA, DEFAULT_BRANCH, REPO),
            [],
        )

        # SHA mismatch excluded
        sha_cand = dict(cand, head={"sha": "other_sha", "repo": {"full_name": REPO}})
        self.assertEqual(
            filter_hydrated_candidates([sha_cand], HEAD_SHA, DEFAULT_BRANCH, REPO), []
        )

        # Wrong base ref excluded
        base_cand = dict(
            cand, base={"ref": "feature-branch", "repo": {"full_name": REPO}}
        )
        self.assertEqual(
            filter_hydrated_candidates([base_cand], HEAD_SHA, DEFAULT_BRANCH, REPO), []
        )

        # Missing fork head repo metadata excluded
        malformed_fork = dict(cand, head={"sha": HEAD_SHA, "repo": None})
        self.assertEqual(
            filter_hydrated_candidates(
                [malformed_fork], HEAD_SHA, DEFAULT_BRANCH, REPO
            ),
            [],
        )

        # Null head or null base safely handled
        null_head = dict(cand, head=None)
        self.assertEqual(
            filter_hydrated_candidates([null_head], HEAD_SHA, DEFAULT_BRANCH, REPO), []
        )
        null_base = dict(cand, base=None)
        self.assertEqual(
            filter_hydrated_candidates([null_base], HEAD_SHA, DEFAULT_BRANCH, REPO), []
        )

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_success(self, mock_get):
        mock_get.return_value = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA},
            "base": {"ref": DEFAULT_BRANCH},
        }
        res = resolve_workflow_dispatch_pr(REPO, 28, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertFalse(res["skip"])
        self.assertEqual(res["pr_number"], 28)
        self.assertEqual(res["head_sha"], HEAD_SHA)

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_sha_mismatch_fails(self, mock_get):
        mock_get.return_value = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA},
            "base": {"ref": DEFAULT_BRANCH},
        }
        res = resolve_workflow_dispatch_pr(
            REPO, 28, "different_sha", DEFAULT_BRANCH, "token"
        )
        self.assertTrue(res["validation_failed"])
        self.assertIn("SHA mismatch on workflow_dispatch", res["error_message"])

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_closed_pr_fails(self, mock_get):
        mock_get.return_value = {
            "number": 28,
            "state": "closed",
            "head": {"sha": HEAD_SHA},
            "base": {"ref": DEFAULT_BRANCH},
        }
        res = resolve_workflow_dispatch_pr(REPO, 28, None, DEFAULT_BRANCH, "token")
        self.assertTrue(res["validation_failed"])
        self.assertIn("is not open", res["error_message"])

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_wrong_base_branch_fails(self, mock_get):
        mock_get.return_value = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA},
            "base": {"ref": "feature-branch"},
        }
        res = resolve_workflow_dispatch_pr(REPO, 28, None, DEFAULT_BRANCH, "token")
        self.assertTrue(res["validation_failed"])
        self.assertIn("targets base branch", res["error_message"])
        self.assertIn("feature-branch", res["error_message"])
        self.assertIn(DEFAULT_BRANCH, res["error_message"])

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_null_head_returns_empty_fail_sha(self, mock_get):
        # Empty or malformed live head SHA must return head_sha="" (never fall back to requested_sha)
        mock_get.return_value = {
            "number": 28,
            "state": "open",
            "head": None,
            "base": {"ref": DEFAULT_BRANCH},
        }
        res = resolve_workflow_dispatch_pr(REPO, 28, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertTrue(res["validation_failed"])
        self.assertEqual(res["head_sha"], "")
        self.assertIn("missing or malformed live head SHA", res["error_message"])

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_live_reread_malformed_sha_raises_api_fault(self, mock_get):
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        malformed_live_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": "not-a-40-hex-sha"},
            "base": {"ref": DEFAULT_BRANCH},
        }

        calls = 0

        def mock_router(url, token):
            nonlocal calls
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                calls += 1
                if calls == 1:
                    return full_pr
                return malformed_live_pr
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("returned invalid live head SHA", str(ctx.exception))
        self.assertIn("API fault", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_single_match(self, mock_get):
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }

        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                return full_pr
            return {}

        mock_get.side_effect = mock_router
        res = resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertFalse(res["skip"])
        self.assertEqual(res["pr_number"], 28)
        self.assertEqual(res["head_sha"], HEAD_SHA)

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_ambiguity_fails(self, mock_get):
        pr28 = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        pr30 = {
            "number": 30,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": "fork/paperclip"}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }

        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}, {"number": 30}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                return pr28
            if "pulls/30" in url:
                return pr30
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("Ambiguous PR resolution", str(ctx.exception))
        self.assertIn("28", str(ctx.exception))
        self.assertIn("30", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_stale_live_head_skips(self, mock_get):
        moved_40_hex_sha = "fedcba9876543210fedcba9876543210fedcba98"
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        recheck_pr = dict(
            full_pr, head={"sha": moved_40_hex_sha, "repo": {"full_name": REPO}}
        )

        calls = 0

        def mock_router(url, token):
            nonlocal calls
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                calls += 1
                if calls == 1:
                    return full_pr
                return recheck_pr
            return {}

        mock_get.side_effect = mock_router
        res = resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertTrue(res["skip"])
        self.assertEqual(res["reason"], "STALE_LIVE_HEAD")

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_null_live_head_handles_safely(self, mock_get):
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        recheck_pr = {
            "number": 28,
            "state": "open",
            "head": None,
            "base": {"ref": DEFAULT_BRANCH},
        }

        calls = 0

        def mock_router(url, token):
            nonlocal calls
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                calls += 1
                if calls == 1:
                    return full_pr
                return recheck_pr
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("API fault", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_zero_candidates_skips(self, mock_get):
        mock_get.return_value = []
        res = resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertTrue(res["skip"])
        self.assertEqual(res["reason"], "NO_OPEN_PR_FOR_SHA")

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_hydration_failure_fails_closed(self, mock_get):
        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                raise RuntimeError("GitHub API HTTP 404 for .../pulls/28: Not Found")
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("Failed to hydrate candidate PR #28", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_5_page_cap_exhaustion_fails(self, mock_get):
        # 100 items per page for all 5 pages
        def mock_router(url, token):
            if "commits" in url:
                return []
            if "pulls?state=open" in url:
                return [{"number": i, "head": {"sha": "other"}} for i in range(100)]
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn(
            "Exhausted 5-page / 500 open PR pagination cap", str(ctx.exception)
        )

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_one_match_under_truncation_fails_closed(self, mock_get):
        # One matching candidate found on page 1, but page 5 hits 100 items (cap exhausted).
        # Must fail closed immediately regardless of match count (Finding 1).
        def mock_router(url, token):
            if "commits" in url:
                return []
            if "pulls?state=open" in url:
                if "page=1" in url:
                    # Includes one matching PR and 99 others
                    items = [{"number": 28, "head": {"sha": HEAD_SHA}}] + [
                        {"number": 1000 + i, "head": {"sha": "other"}}
                        for i in range(99)
                    ]
                    return items
                return [{"number": i, "head": {"sha": "other"}} for i in range(100)]
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn(
            "Exhausted 5-page / 500 open PR pagination cap", str(ctx.exception)
        )

    @patch("sys.stderr", new_callable=io.StringIO)
    @patch("pr_resolve.make_github_request")
    def test_commit_association_404_warns_and_falls_back(self, mock_get, mock_stderr):
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }

        def mock_router(url, token):
            if "commits" in url:
                raise GitHubAPIError(404, "Not Found")
            if "pulls?state=open" in url:
                return [{"number": 28, "head": {"sha": HEAD_SHA}}]
            if "pulls/28" in url:
                return full_pr
            return {}

        mock_get.side_effect = mock_router
        res = resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertFalse(res["skip"])
        self.assertEqual(res["pr_number"], 28)
        self.assertIn(
            "Warning: commit-associated PR lookup returned HTTP 404",
            mock_stderr.getvalue(),
        )

    @patch("pr_resolve.make_github_request")
    def test_commit_association_403_fails_closed(self, mock_get):
        def mock_router(url, token):
            if "commits" in url:
                raise GitHubAPIError(403, "Resource not accessible by integration")
            return []

        mock_get.side_effect = mock_router
        with self.assertRaises(GitHubAPIError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertEqual(ctx.exception.status, 403)

    @patch("pr_resolve.make_github_request")
    def test_commit_association_401_and_429_fail_closed(self, mock_get):
        for status in (401, 429):
            with self.subTest(status=status):

                def mock_router(url, token, status=status):
                    if "commits" in url:
                        raise GitHubAPIError(status, "denied")
                    return []

                mock_get.side_effect = mock_router
                with self.assertRaises(GitHubAPIError) as ctx:
                    resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
                self.assertEqual(ctx.exception.status, status)


class TestMakeGithubRequestAuthAndErrorWrapping(unittest.TestCase):
    """API auth/fallback: real header construction and real HTTPError wrapping."""

    @patch("urllib.request.urlopen")
    def test_authorization_header_present_with_token(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"ok": true}'
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        make_github_request("https://api.github.com/repos/org/repo", "secret-token")

        sent_req = mock_urlopen.call_args[0][0]
        self.assertEqual(sent_req.get_header("Authorization"), "Bearer secret-token")

    @patch("urllib.request.urlopen")
    def test_authorization_header_absent_without_token(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"ok": true}'
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        make_github_request("https://api.github.com/repos/org/repo", "")

        sent_req = mock_urlopen.call_args[0][0]
        self.assertIsNone(sent_req.get_header("Authorization"))

    @patch("urllib.request.urlopen")
    def test_real_http_error_wrapped_as_github_api_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://api.github.com/repos/org/repo/pulls/28",
            code=404,
            msg="Not Found",
            hdrs=None,
            fp=io.BytesIO(b'{"message": "Not Found"}'),
        )

        with self.assertRaises(GitHubAPIError) as ctx:
            make_github_request(
                "https://api.github.com/repos/org/repo/pulls/28", "token"
            )
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("Not Found", ctx.exception.body)

    @patch("urllib.request.urlopen")
    def test_generic_network_error_wrapped_as_runtime_error(self, mock_urlopen):
        mock_urlopen.side_effect = OSError("connection reset")

        with self.assertRaises(RuntimeError) as ctx:
            make_github_request("https://api.github.com/repos/org/repo", "token")
        self.assertIn("GitHub API request failed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
