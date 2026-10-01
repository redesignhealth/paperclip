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

MAX_PAGES = 5
PER_PAGE = 100


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
        raise RuntimeError(f"GitHub API HTTP {e.code} for {url}: {body}")
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
        for pr in wf_run.get("pull_requests", []):
            if isinstance(pr, dict) and pr.get("number"):
                candidate_numbers.add(int(pr["number"]))

    # 2. Commit-associated PRs
    commit_url = f"https://api.github.com/repos/{repo}/commits/{head_sha}/pulls"
    try:
        commit_prs = make_github_request(commit_url, token)
        if isinstance(commit_prs, list):
            for pr in commit_prs:
                if isinstance(pr, dict) and pr.get("number"):
                    candidate_numbers.add(int(pr["number"]))
    except Exception:
        # Commit PR endpoint may fail or be unavailable; proceed to paginated search
        pass

    # 3. Paginate open PRs matching head_sha up to MAX_PAGES
    page = 1
    hit_exhaustion_cap = False
    while page <= MAX_PAGES:
        url = f"https://api.github.com/repos/{repo}/pulls?state=open&per_page={PER_PAGE}&page={page}"
        data = make_github_request(url, token)
        if not isinstance(data, list) or not data:
            break

        for pr in data:
            if isinstance(pr, dict):
                p_head = pr.get("head") or {}
                if p_head.get("sha") == head_sha and pr.get("number"):
                    candidate_numbers.add(int(pr["number"]))

        if len(data) == PER_PAGE and page == MAX_PAGES:
            # 5 full pages exhausted without reaching end
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
        if pr.get("state") != "open":
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
    default_branch: str,
    token: str,
    event_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve target PR for a workflow_run event."""
    candidate_numbers, cap_exhausted = gather_candidate_pr_numbers(
        repo=repo,
        head_sha=head_sha,
        token=token,
        event_payload=event_payload,
    )

    # Hydrate every candidate via individual pulls.get REST request
    hydrated: list[dict[str, Any]] = []
    for num in sorted(candidate_numbers):
        pr_url = f"https://api.github.com/repos/{repo}/pulls/{num}"
        try:
            full_pr = make_github_request(pr_url, token)
            if isinstance(full_pr, dict) and full_pr.get("number"):
                hydrated.append(full_pr)
        except Exception as e:
            raise RuntimeError(f"Failed to hydrate candidate PR #{num}: {e}")

    # Strict filtering
    matching = filter_hydrated_candidates(
        hydrated_prs=hydrated,
        head_sha=head_sha,
        default_branch=default_branch,
        expected_base_repo=repo,
    )

    if not matching:
        if cap_exhausted:
            raise RuntimeError(
                f"Exhausted {MAX_PAGES}-page / 500 open PR pagination cap without complete enumeration. Fail closed."
            )
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
    live_sha = live_pr.get("head", {}).get("sha")

    if live_sha != head_sha:
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
    default_branch: str,
    token: str,
) -> dict[str, Any]:
    """Resolve and validate PR for a workflow_dispatch event."""
    pr_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}"
    pr = make_github_request(pr_url, token)
    head_sha = pr.get("head", {}).get("sha", "")

    if pr.get("state") != "open":
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": head_sha or expected_sha or "",
            "error_message": f"PR #{pr_number} is not open (state: {pr.get('state')}). Fail closed.",
        }

    base_ref = pr.get("base", {}).get("ref")
    if base_ref != default_branch:
        return {
            "skip": False,
            "validation_failed": True,
            "pr_number": pr_number,
            "head_sha": head_sha or expected_sha or "",
            "error_message": f"PR #{pr_number} targets base branch '{base_ref}', not default branch '{default_branch}'. Fail closed.",
        }

    if expected_sha and expected_sha.strip():
        req_sha = expected_sha.strip()
        if req_sha != head_sha:
            return {
                "skip": False,
                "validation_failed": True,
                "pr_number": pr_number,
                "head_sha": head_sha,
                "error_message": f"SHA mismatch on workflow_dispatch: input SHA {req_sha} != live PR HEAD {head_sha}. Fail closed.",
            }

    return {
        "skip": False,
        "validation_failed": False,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "default_branch": default_branch,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve target PR for merge gate")
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument("--default-branch", default="master", help="Repository default branch")
    parser.add_argument("--head-sha", help="Workflow run head commit SHA")
    parser.add_argument("--event-payload", help="Path to GitHub event payload JSON")
    parser.add_argument("--pr-number", type=int, help="PR number (for workflow_dispatch)")
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
        raise RuntimeError("Must provide either --pr-number or --head-sha to resolve PR.")

    print(json.dumps(result, indent=2))
    if result.get("skip") is False:
        sys.exit(0)
    else:
        # Exit 0 with skip=true so caller can branch cleanly
        sys.exit(0)


if __name__ == "__main__":
    main()
