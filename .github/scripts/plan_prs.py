#!/usr/bin/env python3
"""Choose which pull requests the auto-approval gate evaluates this run (TECH-7014).

Runs in the unprivileged `plan` job (read-only token, no OIDC, no secrets). The output is a JSON
array of positive integers: the PR numbers the privileged reusable workflow is called with.

- workflow_dispatch: exactly the one typed PR number.
- workflow_run: a completed `pull_request` CI run of this repository; resolves fork and branch PRs
  via bounded open master PR listing matching head_sha + head_repo_id (does not rely on pull_requests[]
  or /commits/{sha}/pulls, which may be empty for fork PRs).
- schedule: a bounded sweep of the open PRs into master (this is how an Argus approval that lands
  after CI is noticed). Every eligible open PR is queued on every sweep, including PRs whose head
  already holds green gate checks: the planner has no Argus API key and cannot tell whether a newer
  BLOCKING verdict now exists for the same SHA, and only the privileged re-evaluation can revoke or
  confirm. Only ineligible PRs (missing/deleted head repo, wrong base, closed, authored by the gate App)
  are dropped. More than MAX_PRS candidates, or more list pages than allowed, fails the sweep loudly
  instead of silently skipping PRs.

Unconfigured repository (role ARN or App id missing): the sweep and event paths do nothing, so the
old human-review ruleset keeps protecting `master`; a manual dispatch fails loudly.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import gate_lib
from gate_lib import GateError

MAX_PRS = 100
MAX_LIST_PAGES = 10


def _from_workflow_run(gh: Any, event: dict[str, Any]) -> list[int]:
    run = event.get("workflow_run")
    if not isinstance(run, dict) or run.get("event") != "pull_request":
        return []
    if (run.get("repository") or {}).get("id") != gate_lib.REPO_ID:
        return []
    sha = run.get("head_sha")
    if not gate_lib.is_full_sha(sha):
        return []
    head_repo_id = (run.get("head_repository") or {}).get("id")
    if not isinstance(head_repo_id, int) or head_repo_id <= 0:
        return []

    numbers: list[int] = []
    # Resolve PR via bounded open master PR listing matching head_sha + head_repo_id
    pulls = gh.paginate(f"/repos/{gate_lib.REPO}/pulls?state=open&base={gate_lib.DEFAULT_BRANCH}", max_pages=MAX_LIST_PAGES)
    for pr in pulls:
        if not isinstance(pr, dict):
            continue
        p_head = pr.get("head") or {}
        p_sha = p_head.get("sha")
        p_head_repo = p_head.get("repo") or {}
        if p_sha == sha and p_head_repo.get("id") == head_repo_id:
            if gate_lib.pr_ineligibility(pr, expected_head=sha) is None:
                numbers.append(gate_lib.parse_pr_number(pr.get("number")))
    return numbers


def _sweep(gh: Any) -> list[int]:
    pulls = gh.paginate(f"/repos/{gate_lib.REPO}/pulls?state=open&base={gate_lib.DEFAULT_BRANCH}", max_pages=MAX_LIST_PAGES)
    numbers: list[int] = []
    for pr in pulls:
        if gate_lib.pr_ineligibility(pr) is not None:
            continue
        numbers.append(gate_lib.parse_pr_number(pr.get("number")))
    return numbers


def plan(event_name: str, event: dict[str, Any], gh: Any, input_pr: str, configured: bool) -> list[int]:
    if event_name == "workflow_dispatch":
        number = gate_lib.parse_pr_number(input_pr)  # validate before anything else, even if unconfigured
        if not configured:
            raise GateError("NOT_CONFIGURED")
        return [number]
    if not configured:
        print("::notice::auto-approve is not configured (role ARN / App id missing); nothing to do")
        return []
    if event_name == "workflow_run":
        numbers = _from_workflow_run(gh, event)
    elif event_name == "schedule":
        numbers = _sweep(gh)
    else:
        raise GateError("UNSUPPORTED_EVENT")
    numbers = sorted(set(numbers))
    if len(numbers) > MAX_PRS:
        raise GateError("TOO_MANY_PRS")
    return numbers


def main() -> int:
    out_path = os.environ.get("GITHUB_OUTPUT")
    try:
        event: dict[str, Any] = {}
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if event_path:
            with open(event_path, encoding="utf-8") as fh:
                event = json.load(fh)
        gh = gate_lib.GitHub(os.environ.get("GITHUB_TOKEN", ""))
        numbers = plan(
            os.environ.get("EVENT_NAME", ""),
            event,
            gh,
            os.environ.get("INPUT_PR_NUMBER", ""),
            os.environ.get("HAS_CONFIG") == "true",
        )
    except (GateError, ValueError, OSError) as exc:
        print(f"::error::plan failed: {getattr(exc, 'code', type(exc).__name__)}")
        return 1
    print(f"evaluating {len(numbers)} pull request(s)")
    gate_lib.write_output("prs", json.dumps(numbers, separators=(",", ":")), out_path)
    gate_lib.write_output("has_prs", "true" if numbers else "false", out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
