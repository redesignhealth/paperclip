#!/usr/bin/env python3
"""CI run aggregator and evaluator for merge gates (TECH-7014).

Sweeps all pull_request workflow runs for a target commit SHA, identifies the
latest run per workflow, evaluates them against the applicable workflows set,
and determines aggregate CI status (SUCCESS, PENDING, FAILURE).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

MAX_PAGES = 10
PER_PAGE = 100
ANCHOR_WORKFLOW_NAME = "Merge Gate Trigger"


@dataclass
class AggregateResult:
    status: str  # SUCCESS, PENDING, FAILURE
    reason: str  # Short machine-readable code
    summary: str  # Human-readable summary
    details: dict[str, Any] | None = None


def fetch_workflow_runs_for_sha(
    repo: str, head_sha: str, token: str
) -> list[dict[str, Any]]:
    """Fetch all pull_request workflow runs for the head SHA, up to MAX_PAGES.

    Fails closed if the total pages exceeds MAX_PAGES.
    """
    base_url = f"https://api.github.com/repos/{repo}/actions/runs"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "merge-gate-ci-aggregate",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    collected_runs: list[dict[str, Any]] = []
    page = 1
    total_count = 0

    while page <= MAX_PAGES:
        url = f"{base_url}?head_sha={head_sha}&event=pull_request&per_page={PER_PAGE}&page={page}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            raise RuntimeError(f"Failed to fetch workflow runs for {head_sha} on page {page}: {e}")

        runs = data.get("workflow_runs", [])
        collected_runs.extend(runs)

        total_count = data.get("total_count", len(collected_runs))
        if len(runs) < PER_PAGE or len(collected_runs) >= total_count:
            break

        page += 1

    if page > MAX_PAGES and len(collected_runs) < total_count:
        raise RuntimeError(
            f"Workflow runs for {head_sha} exceeded maximum pagination cap of {MAX_PAGES} pages. Fail closed."
        )

    return collected_runs


def group_latest_runs(
    runs: list[dict[str, Any]],
    exclude_anchor: bool = True,
) -> dict[str, dict[str, Any]]:
    """Group runs by workflow and return the latest run per workflow by run_number.

    Filters out anchor workflow (Merge Gate Trigger) if exclude_anchor is True.
    Returns map of workflow_name -> latest run dict.
    """
    latest_by_id: dict[int, dict[str, Any]] = {}

    for run in runs:
        name = run.get("name") or "Unknown"
        if exclude_anchor and name == ANCHOR_WORKFLOW_NAME:
            continue

        wf_id = run.get("workflow_id")
        if wf_id is None:
            continue

        existing = latest_by_id.get(wf_id)
        if existing is None or run.get("run_number", 0) > existing.get("run_number", 0):
            latest_by_id[wf_id] = run

    # Map by name for comparison with applicable workflows set
    latest_by_name: dict[str, dict[str, Any]] = {}
    for run in latest_by_id.values():
        name = run.get("name") or str(run.get("workflow_id"))
        latest_by_name[name] = run

    return latest_by_name


def evaluate_ci_runs(
    applicable_workflow_names: set[str],
    latest_runs_by_name: dict[str, dict[str, Any]],
) -> AggregateResult:
    """Evaluate observed runs against applicable workflows according to policy:

    - waiting / action_required => FAILURE actionable
    - non-completed => PENDING
    - missing applicable run => FAILURE (called after polling)
    - any non-success conclusion (skipped, neutral, cancelled, timed_out, failure) => FAILURE
    - A empty and O empty => SUCCESS with explicit summary
    - otherwise all success => SUCCESS
    - unexpected observed workflows in O are also evaluated
    """
    A = set(applicable_workflow_names)
    O = latest_runs_by_name

    # Case 1: Zero applicable workflows and zero observed runs
    if len(A) == 0 and len(O) == 0:
        return AggregateResult(
            status="SUCCESS",
            reason="ZERO_RUNS_APPLICABLE",
            summary="No CI workflows applicable for this change (e.g. documentation-only changes) and none observed.",
            details={"applicable": [], "observed": []},
        )

    # Case 2: Applicable workflows exist but zero observed runs
    if len(A) > 0 and len(O) == 0:
        return AggregateResult(
            status="FAILURE",
            reason="MISSING_APPLICABLE_RUNS",
            summary=f"Applicable CI workflows have not run: {sorted(A)}.",
            details={"applicable": sorted(A), "observed": []},
        )

    # Evaluate each observed run
    pending_workflows: list[str] = []
    action_required_workflows: list[str] = []
    failed_workflows: list[str] = []

    for name, run in sorted(O.items()):
        status = run.get("status")
        conclusion = run.get("conclusion")

        if status == "waiting" or conclusion == "action_required":
            action_required_workflows.append(
                f"{name} (status={status}, conclusion={conclusion})"
            )
        elif status != "completed":
            pending_workflows.append(f"{name} (status={status})")
        elif conclusion != "success":
            failed_workflows.append(f"{name} (conclusion={conclusion})")

    # Priority of failure/pending:
    # 1. Actionable human approvals / waiting
    if action_required_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="ACTION_REQUIRED",
            summary=f"CI workflows require human approval or action: {', '.join(action_required_workflows)}.",
            details={"action_required": action_required_workflows, "observed": sorted(O.keys())},
        )

    # 2. Hard failures / non-success conclusion
    if failed_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="NON_SUCCESS_CONCLUSION",
            summary=f"CI workflows finished with non-success conclusion: {', '.join(failed_workflows)}.",
            details={"failed": failed_workflows, "observed": sorted(O.keys())},
        )

    # 3. Missing applicable workflows
    missing_workflows = sorted(A - set(O.keys()))
    if missing_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="MISSING_APPLICABLE_RUNS",
            summary=f"Missing required CI workflow runs: {', '.join(missing_workflows)}.",
            details={"missing": missing_workflows, "observed": sorted(O.keys())},
        )

    # 4. In-progress runs
    if pending_workflows:
        return AggregateResult(
            status="PENDING",
            reason="RUN_IN_PROGRESS",
            summary=f"CI workflows currently in progress: {', '.join(pending_workflows)}.",
            details={"pending": pending_workflows, "observed": sorted(O.keys())},
        )

    # 5. All observed green and all applicable present
    return AggregateResult(
        status="SUCCESS",
        reason="ALL_GREEN",
        summary=f"All relevant CI workflows succeeded: {', '.join(sorted(O.keys()))}.",
        details={"applicable": sorted(A), "observed": sorted(O.keys())},
    )


def sweep_and_evaluate_with_polling(
    repo: str,
    head_sha: str,
    token: str,
    applicable_workflow_names: set[str],
    poll_missing_timeout_s: int = 90,
    poll_interval_s: int = 15,
    settle_sleep_s: int = 20,
) -> AggregateResult:
    """Perform run sweep with missing-run polling and pre-success re-sweep settle."""
    A = set(applicable_workflow_names)
    start_time = time.time()

    # Step 1: Initial sweep and poll loop for missing runs
    while True:
        raw_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
        O = group_latest_runs(raw_runs)

        # Check if any applicable workflows are missing from O
        missing = A - set(O.keys())
        elapsed = time.time() - start_time

        if missing and elapsed < poll_missing_timeout_s:
            # Poll every poll_interval_s seconds
            time.sleep(poll_interval_s)
            continue
        break

    eval_result = evaluate_ci_runs(A, O)
    if eval_result.status != "SUCCESS":
        return eval_result

    # If eval_result is SUCCESS and not zero-runs case, perform settle sleep & re-sweep
    if len(O) > 0 and settle_sleep_s > 0:
        time.sleep(settle_sleep_s)
        recheck_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
        O_recheck = group_latest_runs(recheck_runs)

        # Require workflow set unchanged and all still green
        if set(O.keys()) != set(O_recheck.keys()):
            return evaluate_ci_runs(A, O_recheck)

        recheck_eval = evaluate_ci_runs(A, O_recheck)
        return recheck_eval

    return eval_result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Sweep and aggregate PR CI workflow runs")
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument("--sha", required=True, help="Commit head SHA")
    parser.add_argument(
        "--applicable",
        default="",
        help="Comma-separated list of applicable workflow names",
    )
    parser.add_argument(
        "--poll-timeout",
        type=int,
        default=90,
        help="Polling timeout for missing runs (seconds)",
    )
    parser.add_argument(
        "--settle-sleep",
        type=int,
        default=20,
        help="Settle sleep before declaring success (seconds)",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    applicable_set = {s.strip() for s in args.applicable.split(",") if s.strip()}

    result = sweep_and_evaluate_with_polling(
        repo=args.repo,
        head_sha=args.sha,
        token=token,
        applicable_workflow_names=applicable_set,
        poll_missing_timeout_s=args.poll_timeout,
        poll_interval_s=15,
        settle_sleep_s=args.settle_sleep,
    )

    output = {
        "status": result.status,
        "reason": result.reason,
        "summary": result.summary,
        "details": result.details,
    }
    print(json.dumps(output, indent=2))
    if result.status != "SUCCESS":
        sys.exit(1)


if __name__ == "__main__":
    main()
