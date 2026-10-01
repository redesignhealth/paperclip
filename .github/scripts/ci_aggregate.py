#!/usr/bin/env python3
"""CI run aggregator and evaluator for merge gates (TECH-7014).

Sweeps all pull_request workflow runs for a target commit SHA, identifies the
latest run per workflow by (run_number, run_attempt), evaluates them against
the classifier-aware applicable workflow sets, and determines aggregate CI
status (SUCCESS, PENDING, FAILURE).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gate_constants import (
    GATE_EXCLUDED_WORKFLOW_FILES,
    GATE_EXCLUDED_WORKFLOW_NAMES,
)

MAX_PAGES = 10
PER_PAGE = 100


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
    """Group runs by workflow and return the latest run per workflow by (run_number, run_attempt).

    Filters out anchor/gate workflows by name or file path if exclude_anchor is True.
    Resolves name collisions using latest (run_number, run_attempt).
    """
    latest_by_id: dict[int, dict[str, Any]] = {}

    for run in runs:
        name = run.get("name") or "Unknown"
        path = run.get("path") or ""
        file_name = Path(path).name if path else ""

        if exclude_anchor:
            if (
                name in GATE_EXCLUDED_WORKFLOW_NAMES
                or file_name in GATE_EXCLUDED_WORKFLOW_FILES
            ):
                continue

        wf_id = run.get("workflow_id")
        if wf_id is None:
            continue

        run_key = (int(run.get("run_number", 0)), int(run.get("run_attempt", 1)))
        existing = latest_by_id.get(wf_id)
        if existing is None:
            latest_by_id[wf_id] = run
        else:
            existing_key = (int(existing.get("run_number", 0)), int(existing.get("run_attempt", 1)))
            if run_key > existing_key:
                latest_by_id[wf_id] = run

    # Map by name, resolving any name collisions using (run_number, run_attempt)
    latest_by_name: dict[str, dict[str, Any]] = {}
    for run in latest_by_id.values():
        name = run.get("name") or str(run.get("workflow_id"))
        run_key = (int(run.get("run_number", 0)), int(run.get("run_attempt", 1)))

        if name not in latest_by_name:
            latest_by_name[name] = run
        else:
            cur = latest_by_name[name]
            cur_key = (int(cur.get("run_number", 0)), int(cur.get("run_attempt", 1)))
            if run_key > cur_key:
                latest_by_name[name] = run

    return latest_by_name


def evaluate_ci_runs(
    applicable_workflow_names: set[str],
    latest_runs_by_name: dict[str, dict[str, Any]],
    label_not_present_workflow_names: set[str] | None = None,
    all_known_workflow_names: set[str] | None = None,
) -> AggregateResult:
    """Evaluate observed runs against applicable workflows according to classifier-aware policy:

    - Applicable workflows must succeed.
    - Label-not-present workflows are ignored entirely (including stale prior runs).
    - Other non-applicable skipped runs are ignored, but non-skipped become CLASSIFIER_DRIFT.
    - Unknown workflows outside all_known_workflow_names remain fail-closed.
    - Waiting / action_required => FAILURE actionable.
    - In-progress => PENDING.
    - Zero applicable and zero active observed => SUCCESS with explicit summary.
    """
    A = set(applicable_workflow_names)
    L_absent = set(label_not_present_workflow_names or [])
    K = set(all_known_workflow_names or [])

    # Filter out label-not-present workflows entirely (Finding 2)
    active_O = {name: run for name, run in latest_runs_by_name.items() if name not in L_absent}

    # Case 1: Zero applicable workflows and zero active observed runs
    if len(A) == 0 and len(active_O) == 0:
        return AggregateResult(
            status="SUCCESS",
            reason="ZERO_RUNS_APPLICABLE",
            summary="No CI workflows applicable for this change (e.g. documentation-only changes) and none observed.",
            details={"applicable": [], "observed": []},
        )

    # Case 2: Applicable workflows exist but zero active observed runs
    if len(A) > 0 and len(active_O) == 0:
        return AggregateResult(
            status="FAILURE",
            reason="MISSING_APPLICABLE_RUNS",
            summary=f"Applicable CI workflows have not run: {sorted(A)}.",
            details={"applicable": sorted(A), "observed": []},
        )

    pending_workflows: list[str] = []
    action_required_workflows: list[str] = []
    failed_workflows: list[str] = []

    for name, run in sorted(active_O.items()):
        status = run.get("status")
        conclusion = run.get("conclusion")

        # Observed run for workflow NOT classified as applicable
        if name not in A:
            if name in K:
                # Known repository workflow (e.g. path-filtered)
                if conclusion == "skipped":
                    # Expected job/workflow skip: safely ignore
                    continue
                else:
                    # Non-skipped execution for a workflow deemed non-applicable indicates classifier drift
                    return AggregateResult(
                        status="FAILURE",
                        reason="CLASSIFIER_DRIFT",
                        summary=(
                            f"Workflow '{name}' was classified as non-applicable but executed with "
                            f"status '{status}', conclusion '{conclusion}'. Classifier drift detected."
                        ),
                        details={"workflow": name, "status": status, "conclusion": conclusion},
                    )
            else:
                # Completely unknown workflow run: evaluate fail-closed
                if status == "waiting" or conclusion == "action_required":
                    return AggregateResult(
                        status="FAILURE",
                        reason="ACTION_REQUIRED",
                        summary=f"Unknown workflow '{name}' requires human approval/action.",
                        details={"workflow": name},
                    )
                if status != "completed":
                    return AggregateResult(
                        status="PENDING",
                        reason="RUN_IN_PROGRESS",
                        summary=f"Unknown workflow '{name}' is currently in progress (status: {status}).",
                        details={"workflow": name},
                    )
                if conclusion != "success":
                    return AggregateResult(
                        status="FAILURE",
                        reason="NON_SUCCESS_CONCLUSION",
                        summary=f"Unknown workflow '{name}' completed with non-success conclusion '{conclusion}'.",
                        details={"workflow": name},
                    )
                continue

        # Applicable workflow evaluation
        if status == "waiting" or conclusion == "action_required":
            action_required_workflows.append(
                f"{name} (status={status}, conclusion={conclusion})"
            )
        elif status != "completed":
            pending_workflows.append(f"{name} (status={status})")
        elif conclusion != "success":
            failed_workflows.append(f"{name} (conclusion={conclusion})")

    # Priority 1: Actionable human approvals / waiting
    if action_required_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="ACTION_REQUIRED",
            summary=f"CI workflows require human approval or action: {', '.join(action_required_workflows)}.",
            details={"action_required": action_required_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 2: Hard failures / non-success conclusion
    if failed_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="NON_SUCCESS_CONCLUSION",
            summary=f"CI workflows finished with non-success conclusion: {', '.join(failed_workflows)}.",
            details={"failed": failed_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 3: Missing applicable workflows
    missing_workflows = sorted(A - set(active_O.keys()))
    if missing_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="MISSING_APPLICABLE_RUNS",
            summary=f"Missing required CI workflow runs: {', '.join(missing_workflows)}.",
            details={"missing": missing_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 4: In-progress runs
    if pending_workflows:
        return AggregateResult(
            status="PENDING",
            reason="RUN_IN_PROGRESS",
            summary=f"CI workflows currently in progress: {', '.join(pending_workflows)}.",
            details={"pending": pending_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 5: All observed green and all applicable present
    return AggregateResult(
        status="SUCCESS",
        reason="ALL_GREEN",
        summary=f"All relevant CI workflows succeeded: {', '.join(sorted(A))}.",
        details={"applicable": sorted(A), "observed": sorted(active_O.keys())},
    )


def sweep_and_evaluate_with_polling(
    repo: str,
    head_sha: str,
    token: str,
    applicable_workflow_names: set[str],
    label_not_present_workflow_names: set[str] | None = None,
    all_known_workflow_names: set[str] | None = None,
    poll_missing_timeout_s: int = 90,
    poll_interval_s: int = 15,
    settle_sleep_s: int = 20,
) -> AggregateResult:
    """Perform run sweep with missing-run polling and pre-success re-sweep settle."""
    A = set(applicable_workflow_names)
    L_absent = set(label_not_present_workflow_names or [])
    K = set(all_known_workflow_names or [])
    start_time = time.monotonic()

    # Step 1: Initial sweep and poll loop for missing runs
    while True:
        raw_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
        observed_runs = group_latest_runs(raw_runs)
        active_O = {k: v for k, v in observed_runs.items() if k not in L_absent}

        missing = A - set(active_O.keys())
        elapsed = time.monotonic() - start_time

        if missing and elapsed < poll_missing_timeout_s:
            time.sleep(poll_interval_s)
            continue
        break

    eval_result = evaluate_ci_runs(
        A,
        observed_runs,
        label_not_present_workflow_names=L_absent,
        all_known_workflow_names=K,
    )
    if eval_result.status != "SUCCESS":
        return eval_result

    # If eval_result is SUCCESS and not zero-runs case, perform settle sleep & re-sweep
    if len(active_O) > 0 and settle_sleep_s > 0:
        time.sleep(settle_sleep_s)
        recheck_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
        O_recheck = group_latest_runs(recheck_runs)
        active_O_recheck = {k: v for k, v in O_recheck.items() if k not in L_absent}

        # Require workflow set unchanged during settle window (Finding 8)
        if set(active_O.keys()) != set(active_O_recheck.keys()):
            return AggregateResult(
                status="PENDING",
                reason="WORKFLOW_SET_DRIFT",
                summary="Workflow set changed during settle window. Requiring re-sweep.",
                details={
                    "initial": sorted(active_O.keys()),
                    "recheck": sorted(active_O_recheck.keys()),
                },
            )

        return evaluate_ci_runs(
            A,
            O_recheck,
            label_not_present_workflow_names=L_absent,
            all_known_workflow_names=K,
        )

    return eval_result


def main() -> None:
    parser = argparse.ArgumentParser(description="Sweep and aggregate PR CI workflow runs")
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument("--sha", required=True, help="Commit head SHA")
    parser.add_argument(
        "--applicable",
        default="",
        help="Comma-separated list of applicable workflow names",
    )
    parser.add_argument(
        "--label-absent",
        default="",
        help="Comma-separated list of label-not-present workflow names",
    )
    parser.add_argument(
        "--all-known",
        default="",
        help="Comma-separated list of all known repository workflow names",
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
    label_absent_set = {s.strip() for s in args.label_absent.split(",") if s.strip()}
    all_known_set = {s.strip() for s in args.all_known.split(",") if s.strip()}

    result = sweep_and_evaluate_with_polling(
        repo=args.repo,
        head_sha=args.sha,
        token=token,
        applicable_workflow_names=applicable_set,
        label_not_present_workflow_names=label_absent_set,
        all_known_workflow_names=all_known_set,
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
