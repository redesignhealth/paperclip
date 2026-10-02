#!/usr/bin/env python3
"""Unit tests for canonical Pull Request and SHA resolver (TECH-7014).

Covers all required acceptance scenarios:
- workflow_dispatch with valid PR and matching SHA succeeds
- workflow_dispatch with SHA mismatch fails closed
- workflow_dispatch with closed PR or wrong base branch fails closed
- workflow_dispatch with null or malformed head fails closed with validation_failed and empty head_sha (never falls back to requested SHA)
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

import inspect
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from gate_constants import (  # noqa: E402
    DEFAULT_BRANCH as CENTRALIZED_DEFAULT_BRANCH,
    is_valid_40_hex_sha,
    is_valid_compatible_40_hex_sha,
    normalize_compatible_sha,
    normalize_sha,
    shas_equal,
)
from pr_resolve import (  # noqa: E402
    GitHubAPIError,
    filter_hydrated_candidates,
    gather_candidate_pr_numbers,
    main,
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


class TestCentralizedDefaultBranch(unittest.TestCase):
    """default_branch parameters must default to the single
    gate_constants.DEFAULT_BRANCH constant, not an independently hardcoded
    "master" literal that could silently drift from it."""

    def test_module_constant_matches_centralized_constant(self):
        self.assertEqual(DEFAULT_BRANCH, CENTRALIZED_DEFAULT_BRANCH)

    def test_signatures_default_to_centralized_constant(self):
        for fn in (resolve_workflow_run_pr, resolve_workflow_dispatch_pr):
            with self.subTest(fn=fn.__qualname__):
                default = inspect.signature(fn).parameters["default_branch"].default
                self.assertEqual(default, CENTRALIZED_DEFAULT_BRANCH)


class TestResolverGatherAndHydration(unittest.TestCase):
    """Tests for gather_candidate_pr_numbers, entry SHA validation, hydration strictness."""

    @patch("pr_resolve.make_github_request")
    def test_gather_pull_requests_null_safe(self, mock_get):
        mock_get.return_value = []
        payload = {"workflow_run": {"pull_requests": None}}
        candidates, hit_cap = gather_candidate_pr_numbers(
            REPO, HEAD_SHA, "token", payload
        )
        self.assertEqual(candidates, set())
        self.assertFalse(hit_cap)

    @patch("pr_resolve.make_github_request")
    def test_gather_open_prs_non_list_raises(self, mock_get):
        def router(url, token):
            if "commits" in url:
                return []
            if "pulls?state=open" in url:
                return {
                    "message": "Server error",
                    "documentation_url": "https://docs.github.com",
                }
            return []

        mock_get.side_effect = router
        with self.assertRaises(RuntimeError) as ctx:
            gather_candidate_pr_numbers(REPO, HEAD_SHA, "token", None)
        self.assertIn("non-list response for open PRs", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_entry_malformed_sha_returns_validation_failed_before_network(
        self, mock_get
    ):
        res = resolve_workflow_run_pr(
            REPO, "not-a-valid-40-hex-sha", DEFAULT_BRANCH, "token"
        )
        self.assertFalse(res["skip"])
        self.assertTrue(res["validation_failed"])
        self.assertEqual(res["head_sha"], "")
        self.assertIn("Malformed or invalid head SHA", res["error_message"])
        mock_get.assert_not_called()

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_entry_whitespace_padded_sha_returns_validation_failed_before_network(
        self, mock_get
    ):
        padded_sha = f" {HEAD_SHA} "
        res = resolve_workflow_run_pr(REPO, padded_sha, DEFAULT_BRANCH, "token")
        self.assertFalse(res["skip"])
        self.assertTrue(res["validation_failed"])
        self.assertEqual(res["head_sha"], "")
        mock_get.assert_not_called()

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_malformed_hydrated_payload_raises(self, mock_get):
        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                return {"number": "28", "state": "open"}  # string instead of int
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("malformed hydration payload", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_hydrated_boolean_number_raises(self, mock_get):
        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                return {"number": True, "state": "open"}  # bool instead of int
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("malformed hydration payload", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_hydrated_mismatched_number_raises(self, mock_get):
        def mock_router(url, token):
            if "commits" in url:
                return [{"number": 28}]
            if "pulls?state=open" in url:
                return []
            if "pulls/28" in url:
                return {"number": 999, "state": "open"}  # mismatched number
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("malformed hydration payload", str(ctx.exception))

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_invalid_pr_number_fails_closed_before_network(
        self, mock_get
    ):
        # Zero, negative, non-int, and bool PR numbers must all fail closed
        # via the strict pr_number guard, without ever calling the network.
        for bad_pr_number in (0, -5, True, "28", None, 3.5):
            with self.subTest(pr_number=bad_pr_number):
                mock_get.reset_mock()
                res = resolve_workflow_dispatch_pr(
                    REPO, bad_pr_number, None, DEFAULT_BRANCH, "token"
                )
                self.assertFalse(res["skip"])
                self.assertTrue(res["validation_failed"])
                self.assertEqual(res["head_sha"], "")
                self.assertIn("Invalid PR number", res["error_message"])
                self.assertIn("positive integer", res["error_message"])
                mock_get.assert_not_called()

    @patch("pr_resolve.make_github_request")
    def test_workflow_dispatch_whitespace_padded_expected_sha_fails_closed(
        self, mock_get
    ):
        # expected_sha is compatibility-free: a whitespace-padded value that
        # would otherwise match the live head SHA after stripping must still
        # fail closed under the strict 40-hex boundary (no laundering).
        mock_get.return_value = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA},
            "base": {"ref": DEFAULT_BRANCH},
        }
        padded_expected_sha = f" {HEAD_SHA} "
        res = resolve_workflow_dispatch_pr(
            REPO, 28, padded_expected_sha, DEFAULT_BRANCH, "token"
        )
        self.assertFalse(res["skip"])
        self.assertTrue(res["validation_failed"])
        self.assertEqual(res["head_sha"], HEAD_SHA)
        self.assertIn("SHA mismatch on workflow_dispatch", res["error_message"])

    @patch("pr_resolve.make_github_request")
    def test_workflow_run_live_reread_whitespace_padded_sha_raises_api_fault(
        self, mock_get
    ):
        full_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": HEAD_SHA, "repo": {"full_name": REPO}},
            "base": {"ref": DEFAULT_BRANCH, "repo": {"full_name": REPO}},
        }
        padded_live_pr = {
            "number": 28,
            "state": "open",
            "head": {"sha": f" {HEAD_SHA} "},
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
                return padded_live_pr
            return {}

        mock_get.side_effect = mock_router
        with self.assertRaises(RuntimeError) as ctx:
            resolve_workflow_run_pr(REPO, HEAD_SHA, DEFAULT_BRANCH, "token")
        self.assertIn("returned invalid live head SHA", str(ctx.exception))
        self.assertIn("API fault", str(ctx.exception))


class TestShaInvariantsAndNormalization(unittest.TestCase):
    """Strict 40-hex boundary vs compatible normalization pinned tests."""

    def test_is_valid_40_hex_sha_strict(self):
        self.assertTrue(is_valid_40_hex_sha(HEAD_SHA))
        self.assertTrue(is_valid_40_hex_sha(HEAD_SHA.upper()))
        # Whitespace padded MUST fail
        self.assertFalse(is_valid_40_hex_sha(f" {HEAD_SHA}"))
        self.assertFalse(is_valid_40_hex_sha(f"{HEAD_SHA}\n"))
        self.assertFalse(is_valid_40_hex_sha(f" {HEAD_SHA} "))
        # Malformed length/chars MUST fail
        self.assertFalse(is_valid_40_hex_sha(HEAD_SHA[:39]))
        self.assertFalse(is_valid_40_hex_sha(HEAD_SHA + "a"))
        self.assertFalse(is_valid_40_hex_sha("z" * 40))
        self.assertFalse(is_valid_40_hex_sha(None))
        self.assertFalse(is_valid_40_hex_sha(123))

    def test_normalize_sha_strict(self):
        self.assertEqual(normalize_sha(HEAD_SHA.upper()), HEAD_SHA.lower())
        with self.assertRaises(ValueError):
            normalize_sha(f" {HEAD_SHA} ")
        with self.assertRaises(ValueError):
            normalize_sha("invalid")

    def test_shas_equal_strict(self):
        self.assertTrue(shas_equal(HEAD_SHA.lower(), HEAD_SHA.upper()))
        self.assertFalse(shas_equal(HEAD_SHA, "other-sha"))
        self.assertFalse(shas_equal(HEAD_SHA, f" {HEAD_SHA} "))

    def test_compatible_sha_normalization(self):
        self.assertTrue(is_valid_compatible_40_hex_sha(f"  {HEAD_SHA}  "))
        self.assertEqual(
            normalize_compatible_sha(f"  {HEAD_SHA.upper()}  \n"), HEAD_SHA.lower()
        )
        with self.assertRaises(ValueError):
            normalize_compatible_sha("not-a-sha")
        with self.assertRaises(ValueError):
            normalize_compatible_sha(None)


class TestResolverCLI(unittest.TestCase):
    """CLI invocations for pr_resolve."""

    @patch("sys.stdout", new_callable=io.StringIO)
    def test_cli_malformed_head_sha_prints_validation_failed(self, mock_stdout):
        test_args = ["pr_resolve.py", "--repo", REPO, "--head-sha", "bad-sha"]
        with patch.object(sys, "argv", test_args):
            with self.assertRaises(SystemExit) as ctx:
                main()
            self.assertEqual(ctx.exception.code, 0)
        output = json.loads(mock_stdout.getvalue())
        self.assertTrue(output.get("validation_failed"))
        self.assertEqual(output.get("head_sha"), "")


if __name__ == "__main__":
    unittest.main()
