#!/usr/bin/env python3
"""Canonical Pull Request and Commit SHA resolver for Merge Gate (TECH-7014).

Resolves the exact target pull request and commit SHA for workflow_run and
workflow_dispatch triggers. Gathers candidate PRs, enforces a 5-page / 500-PR
fail-closed cap, structurally hydrates every candidate via REST, filters with
strict default-branch/fork/SHA rules, rejects ambiguity, and guards against
synchronize races via live-head re-reads.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

from gate_constants import DEFAULT_BRANCH, is_valid_40_hex_sha, shas_equal

MAX_PAGES = 5
PER_PAGE = 100


class GitHubAPIError(RuntimeError):
    """Raised when GitHub API returns an HTTP error code."""

    def __init__(self, status: int, message: str, body: str = "") -> None:
        super().__init__(f"GitHub API HTTP {status}: {message}")
        self.status = status
        self.body = body


def make_github_request(url: str, token: str) -> Any:
    """Perform an authenticated GitHub REST API GET request."""
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "merge-gate-pr-resolver",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise GitHubAPIError(e.code, str(e), body)
    except Exception as e:
        raise RuntimeError(f"GitHub API request failed for {url}: {e}")


def gather_candidate_pr_numbers(
    repo: str,
    head_sha: str,
    token: str,
    event_payload: dict[str, Any] | None = None,
) -> tuple[set[int], bool]:
    """Gather candidate PR numbers across payload, commit associations, and open listings.

    Returns (set_of_pr_numbers, hit_exhaustion_cap).
    """
    candidate_numbers: set[int] = set()

    # 1. Event payload pull_requests
    if event_payload:
        wf_run = event_payload.get("workflow_run") or {}
        raw_prs = wf_run.get("pull_requests")
        if isinstance(raw_prs, list):
            for pr in raw_prs:
                if isinstance(pr, dict) and pr.get("number"):
                    candidate_numbers.add(int(pr["number"]))

    # 2. Commit-associated PRs (re-raises auth/rate-limit errors, warns on 404/network)
    commit_url = f"https://api.github.com/repos/{repo}/commits/{head_sha}/pulls"
    try:
        commit_prs = make_github_request(commit_url, token)
        if isinstance(commit_prs, list):
            for pr in commit_prs:
                if isinstance(pr, dict) and pr.get("number"):
                    candidate_numbers.add(int(pr["number"]))
    except GitHubAPIError as e:
        if e.status in {401, 403, 429}:
            raise
        sys.stderr.write(
            f"Warning: commit-associated PR lookup returned HTTP {e.status}; falling back to paginated search\n"
        )
    except Exception as e:
        sys.stderr.write(
            f"Warning: commit-associated PR lookup failed ({e}); falling back to paginated search\n"
        )

    # 3. Paginate open PRs matching head_sha up to MAX_PAGES
    page = 1
    hit_exhaustion_cap = False
    while page <= MAX_PAGES:
        url = f"https://api.github.com/repos/{repo}/pulls?state=open&per_page={PER_PAGE}&page={page}"
        data = make_github_request(url, token)
        if not isinstance(data, list):
            raise RuntimeError(
                f"GitHub API returned non-list response for open PRs on page {page}: expected list, got {type(data).__name__}"
            )
        if not data:
            break

        for pr in data:
            if isinstance(pr, dict):
                p_head = pr.get("head") or {}
                if p_head.get("sha") == head_sha and pr.get("number"):
                    candidate_numbers.add(int(pr["number"]))

        if len(data) == PER_PAGE and page == MAX_PAGES:
            # Full 5th page exhausted without reaching end
            hit_exhaustion_cap = True

        if len(data) < PER_PAGE:
            break
        page += 1

    return candidate_numbers, hit_exhaustion_cap


def filter_hydrated_candidates(
    hydrated_prs: list[dict[str, Any]],
    head_sha: str,
    default_branch: str,
    expected_base_repo: str,
) -> list[dict[str, Any]]:
    """Strictly filter fully-hydrated PR objects.

    Requirements:
    - state == 'open'
    - head.sha == head_sha
    - base.ref == default_branch
    - base.repo.full_name == expected_base_repo (case-insensitive)
    - head.repo exists and has full_name (valid fork/branch metadata)
    """
    base_repo_lower = expected_base_repo.lower()
    matching: list[dict[str, Any]] = []

    for pr in hydrated_prs:
        if not isinstance(pr, dict) or pr.get("state") != "open":
            continue

        head = pr.get("head") or {}
        if head.get("sha") != head_sha:
            continue

        base = pr.get("base") or {}
        if base.get("ref") != default_branch:
            continue

        base_repo = base.get("repo") or {}
        if base_repo.get("full_name", "").lower() != base_repo_lower:
            continue

        head_repo = head.get("repo") or {}
        if not head_repo.get("full_name"):
            continue

        matching.append(pr)

    return matching


def resolve_workflow_run_pr(
    repo: str,
    head_sha: str,
    default_branch: str = DEFAULT_BRANCH,
    token: str = "",
    event_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve target PR for a workflow_run event."""
    if not is_valid_40_hex_sha(head_sha):
        return {
            "skip": False,
            "validation_failed": True,
            "head_sha": "",
            "error_message": f"Malformed or invalid head SHA ({head_sha!r}). Fail closed.",
        }

    candidate_numbers, cap_exhausted = gather_candidate_pr_numbers(
        repo=repo,
        head_sha=head_sha,
        token=token,
        event_payload=event_payload,
    )

    # Fail closed immediately if pagination cap was exhausted (Finding 1)
    if cap_exhausted:
        raise RuntimeError(
            f"Exhausted {MAX_PAGES}-page / {MAX_PAGES * PER_PAGE} open PR pagination cap without complete enumeration. Fail closed."
        )

    # Hydrate every candidate via individual pulls.get REST request
    hydrated: list[dict[str, Any]] = []
    for num in sorted(candidate_numbers):
        pr_url = f"https://api.github.com/repos/{repo}/pulls/{num}"
        try:
            full_pr = make_github_request(pr_url, token)
        except Exception as e:
            raise RuntimeError(f"Failed to hydrate candidate PR #{num}: {e}")

        if (
            not isinstance(full_pr, dict)
            or not isinstance(full_pr.get("number"), int)
            or isinstance(full_pr.get("number"), bool)
            or full_pr["number"] != num
        ):
            raise RuntimeError(
                f"Candidate PR #{num} returned malformed hydration payload: {full_pr!r}"
            )
        hydrated.append(full_pr)

    # Strict filtering
    matching = filter_hydrated_candidates(
        hydrated_prs=hydrated,
        head_sha=head_sha,
        default_branch=default_branch,
        expected_base_repo=repo,
    )

    if not matching:
        return {
            "skip": True,
            "reason": "NO_OPEN_PR_FOR_SHA",
            "details": f"No open PR targeting {default_branch} found for head SHA {head_sha}.",
        }

    if len(matching) > 1:
        ambiguous_nums = [p["number"] for p in matching]
        raise RuntimeError(
            f"Ambiguous PR resolution: multiple open PRs ({ambiguous_nums}) match head SHA {head_sha}. Fail closed."
        )

    target_pr = matching[0]
    pr_number = target_pr["number"]

    # Live-head race re-read: verify head SHA has not moved
    recheck_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}"
    live_pr = make_github_request(recheck_url, token)
    if not isinstance(live_pr, dict):
        raise RuntimeError(
            f"Malformed PR response for PR #{pr_number}: expected JSON object"
        )

    live_head = live_pr.get("head") or {}
    live_sha = live_head.get("sha")

    if not is_valid_40_hex_sha(live_sha):
        raise RuntimeError(
            f"PR #{pr_number} returned invalid live head SHA {live_sha!r} on recheck. API fault; fail closed."
        )

    if not shas_equal(live_sha, head_sha):
        return {
            "skip": True,
            "reason": "STALE_LIVE_HEAD",
            "details": f"PR #{pr_number} head moved from {head_sha} to {live_sha}. Stale invocation.",
            "pr_number": pr_number,
            "head_sha": head_sha,
            "live_sha": live_sha,
        }

    return {
        "skip": False,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "default_branch": default_branch,
    }


def resolve_workflow_dispatch_pr(
    repo: str,
    pr_number: int,
    expected_sha: str | None,
    default_branch: str = DEFAULT_BRANCH,
    token: str = "",
) -> dict[str, Any]:
    """Resolve and validate PR for a workflow_dispatch event."""
    if not isinstance(pr_number, int) or isinstance(pr_number, bool) or pr_number <= 0:
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": "",
            "error_message": f"Invalid PR number: {pr_number!r}. Must be a positive integer.",
        }

    pr_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}"
    pr = make_github_request(pr_url, token)
    if not isinstance(pr, dict):
        raise RuntimeError(
            f"Malformed PR response for PR #{pr_number}: expected JSON object"
        )

    head = pr.get("head") or {}
    live_sha = head.get("sha")

    # Validate live head SHA strictly; empty or malformed returns validation failure with head_sha=""
    if not is_valid_40_hex_sha(live_sha):
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": "",
            "error_message": f"PR #{pr_number} has missing or malformed live head SHA ({live_sha!r}). Fail closed.",
        }

    # expected_sha is comparison-only, never used as check target
    if expected_sha is not None and expected_sha != "":
        if not is_valid_40_hex_sha(expected_sha) or not shas_equal(
            expected_sha, live_sha
        ):
            return {
                "skip": False,
                "validation_failed": True,
                "pr_number": pr_number,
                "head_sha": live_sha,
                "error_message": f"SHA mismatch on workflow_dispatch: input SHA {expected_sha} != live PR HEAD {live_sha}. Fail closed.",
            }

    if pr.get("state") != "open":
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": live_sha,
            "error_message": f"PR #{pr_number} is not open (state: {pr.get('state')}). Fail closed.",
        }

    base = pr.get("base") or {}
    base_ref = base.get("ref")
    if base_ref != default_branch:
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": live_sha,
            "error_message": f"PR #{pr_number} targets base branch '{base_ref}', not default branch '{default_branch}'. Fail closed.",
        }

    return {
        "skip": False,
        "validation_failed": False,
        "pr_number": pr_number,
        "head_sha": live_sha,
        "default_branch": default_branch,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve target PR for merge gate")
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument(
        "--default-branch", default=DEFAULT_BRANCH, help="Repository default branch"
    )
    parser.add_argument("--head-sha", help="Workflow run head commit SHA")
    parser.add_argument("--event-payload", help="Path to GitHub event payload JSON")
    parser.add_argument(
        "--pr-number", type=int, help="PR number (for workflow_dispatch)"
    )
    parser.add_argument("--expected-sha", help="Expected SHA (for workflow_dispatch)")
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")

    event_payload = None
    if args.event_payload and os.path.exists(args.event_payload):
        with open(args.event_payload, encoding="utf-8") as f:
            event_payload = json.load(f)

    if args.pr_number:
        result = resolve_workflow_dispatch_pr(
            repo=args.repo,
            pr_number=args.pr_number,
            expected_sha=args.expected_sha,
            default_branch=args.default_branch,
            token=token,
        )
    elif args.head_sha:
        result = resolve_workflow_run_pr(
            repo=args.repo,
            head_sha=args.head_sha,
            default_branch=args.default_branch,
            token=token,
            event_payload=event_payload,
        )
    else:
        raise RuntimeError(
            "Must provide either --pr-number or --head-sha to resolve PR."
        )

    print(json.dumps(result, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
