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


def _require_int(val: Any, field_name: str) -> int:
    """Strictly validate and extract integer from run metadata (rejects bool, None, unparseable)."""
    if val is None or isinstance(val, bool):
        raise ValueError(f"Invalid {field_name}: expected integer, got {val!r}")
    try:
        return int(val)
    except (ValueError, TypeError):
        raise ValueError(f"Invalid {field_name}: expected integer, got {val!r}")


def _run_key(run: dict[str, Any]) -> tuple[int, int]:
    """Extract deterministic sort key for a workflow run: (run_number, run_attempt)."""
    run_num = _require_int(run.get("run_number"), "run_number")
    run_attempt = _require_int(run.get("run_attempt", 1), "run_attempt")
    return (run_num, run_attempt)


def fetch_workflow_runs_for_sha(
    repo: str, head_sha: str, token: str
) -> list[dict[str, Any]]:
    """Fetch all pull_request workflow runs for the head SHA, up to MAX_PAGES.

    Fails closed if total_count is missing/non-integer or if pages exceed MAX_PAGES.
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
            raise RuntimeError(
                f"Failed to fetch workflow runs for {head_sha} on page {page}: {e}"
            )

        if not isinstance(data, dict):
            raise RuntimeError(
                f"Invalid workflow-run API response on page {page}: expected JSON object. Fail closed."
            )

        raw_total = data.get("total_count")
        if (
            raw_total is None
            or isinstance(raw_total, bool)
            or not isinstance(raw_total, int)
        ):
            raise RuntimeError(
                f"Invalid workflow-run API response on page {page}: missing or non-integer total_count ({raw_total!r}). Fail closed."
            )
        total_count = raw_total

        runs = data.get("workflow_runs", [])
        if not isinstance(runs, list):
            raise RuntimeError(
                f"Invalid workflow-run API response on page {page}: workflow_runs must be a list. Fail closed."
            )
        collected_runs.extend(runs)

        if len(runs) < PER_PAGE or len(collected_runs) >= total_count:
            break

        page += 1

    if page > MAX_PAGES and len(collected_runs) < total_count:
        raise RuntimeError(
            f"Workflow runs for {head_sha} exceeded maximum pagination cap of {MAX_PAGES} pages. Fail closed."
        )

    return collected_runs


def group_latest_runs(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Group runs by workflow and return the latest run per workflow by (run_number, run_attempt).

    Unconditionally excludes anchor/gate workflows by name or file path first.
    Strictly validates workflow_id, run_number, run_attempt, and run name.
    Resolves name collisions using latest (run_number, run_attempt).
    """
    latest_by_id: dict[int, dict[str, Any]] = {}

    for run in runs:
        if not isinstance(run, dict):
            raise ValueError(
                f"Expected workflow run dictionary, got {type(run).__name__}"
            )

        name = run.get("name")
        path = run.get("path") or ""
        file_name = Path(path).name if path else ""

        # Unconditional invariant exclusion before strict validation
        if (
            name in GATE_EXCLUDED_WORKFLOW_NAMES
            or file_name in GATE_EXCLUDED_WORKFLOW_FILES
        ):
            continue

        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"Workflow run missing non-blank name: {run}")
        clean_name = name.strip()

        wf_id = run.get("workflow_id")
        if wf_id is None or isinstance(wf_id, bool) or not isinstance(wf_id, int):
            raise ValueError(
                f"Workflow run '{clean_name}' missing integer workflow_id: {run}"
            )

        run_key = _run_key(run)
        existing = latest_by_id.get(wf_id)
        if existing is None:
            latest_by_id[wf_id] = run
        else:
            existing_key = _run_key(existing)
            if run_key > existing_key:
                latest_by_id[wf_id] = run

    # Map by name, resolving any name collisions using (run_number, run_attempt)
    latest_by_name: dict[str, dict[str, Any]] = {}
    for run in latest_by_id.values():
        clean_name = str(run["name"]).strip()
        run_key = _run_key(run)

        if clean_name not in latest_by_name:
            latest_by_name[clean_name] = run
        else:
            cur = latest_by_name[clean_name]
            cur_key = _run_key(cur)
            if run_key > cur_key:
                latest_by_name[clean_name] = run

    return latest_by_name


def evaluate_ci_runs(
    applicable_workflow_names: set[str],
    latest_runs_by_name: dict[str, dict[str, Any]],
    label_not_present_workflow_names: set[str] | None = None,
    all_known_workflow_names: set[str] | None = None,
) -> AggregateResult:
    """Evaluate observed runs against applicable workflows according to classifier-aware priority:

    Priority Order:
    ACTION_REQUIRED > NON_SUCCESS_CONCLUSION > CLASSIFIER_DRIFT > MISSING_APPLICABLE_RUNS > RUN_IN_PROGRESS(PENDING) > ALL_GREEN

    - Applicable workflows must succeed.
    - Label-not-present workflows are ignored entirely (including stale prior runs).
    - Other non-applicable skipped runs are ignored.
    - Other non-applicable in-progress runs become PENDING.
    - Other non-applicable waiting/action_required routes immediately to ACTION_REQUIRED.
    - Other non-applicable completed non-skipped runs become CLASSIFIER_DRIFT.
    - Unknown workflows outside all_known_workflow_names remain fail-closed.
    - Zero applicable and zero active observed => SUCCESS with explicit summary.
    """
    A = set(applicable_workflow_names)
    L_absent = set(label_not_present_workflow_names or [])
    K = set(all_known_workflow_names or [])

    # Filter out label-not-present workflows entirely
    active_O = {
        name: run for name, run in latest_runs_by_name.items() if name not in L_absent
    }

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

    action_required_workflows: list[str] = []
    failed_workflows: list[str] = []
    drift_workflows: list[str] = []
    pending_workflows: list[str] = []

    for name, run in sorted(active_O.items()):
        status = run.get("status")
        conclusion = run.get("conclusion")

        # 1. Observed run for workflow NOT classified as applicable
        if name not in A:
            if name in K:
                # Known repository workflow (e.g. path-filtered workflow whose paths didn't match)
                if conclusion == "skipped":
                    continue
                # Route waiting/action_required immediately to ACTION_REQUIRED before generic pending/drift
                if status == "waiting" or conclusion == "action_required":
                    action_required_workflows.append(
                        f"{name} (non-applicable, status={status}, conclusion={conclusion})"
                    )
                elif status != "completed":
                    pending_workflows.append(
                        f"{name} (non-applicable in-progress, status={status})"
                    )
                else:
                    drift_workflows.append(
                        f"{name} (status={status}, conclusion={conclusion})"
                    )
            else:
                # Completely unknown workflow run (accumulate without short-circuiting)
                if status == "waiting" or conclusion == "action_required":
                    action_required_workflows.append(
                        f"{name} (unknown, status={status}, conclusion={conclusion})"
                    )
                elif status != "completed":
                    pending_workflows.append(f"{name} (unknown, status={status})")
                elif conclusion != "success":
                    failed_workflows.append(
                        f"{name} (unknown, conclusion={conclusion})"
                    )
                else:
                    # Completed successful unknown workflow: treat as classifier/workflow-set drift (fail-closed)
                    drift_workflows.append(
                        f"{name} (unknown completed, status={status}, conclusion={conclusion})"
                    )
            continue

        # 2. Applicable workflow evaluation
        if status == "waiting" or conclusion == "action_required":
            action_required_workflows.append(
                f"{name} (status={status}, conclusion={conclusion})"
            )
        elif status != "completed":
            pending_workflows.append(f"{name} (status={status})")
        elif conclusion != "success":
            failed_workflows.append(f"{name} (conclusion={conclusion})")

    missing_workflows = sorted(A - set(active_O.keys()))

    # Apply strict priority order:
    # Priority 1: Actionable human approvals / waiting
    if action_required_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="ACTION_REQUIRED",
            summary=f"CI workflows require human approval or action: {', '.join(action_required_workflows)}.",
            details={
                "action_required": action_required_workflows,
                "observed": sorted(active_O.keys()),
            },
        )

    # Priority 2: Hard failures / non-success conclusion
    if failed_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="NON_SUCCESS_CONCLUSION",
            summary=f"CI workflows finished with non-success conclusion: {', '.join(failed_workflows)}.",
            details={"failed": failed_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 3: Classifier drift (outranks missing applicable runs)
    if drift_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="CLASSIFIER_DRIFT",
            summary=(
                f"Workflows were unclassified or non-applicable but executed with non-skipped conclusions: "
                f"{', '.join(drift_workflows)}. Classifier drift detected."
            ),
            details={"drift": drift_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 4: Missing applicable workflows
    if missing_workflows:
        return AggregateResult(
            status="FAILURE",
            reason="MISSING_APPLICABLE_RUNS",
            summary=f"Missing required CI workflow runs: {', '.join(missing_workflows)}.",
            details={"missing": missing_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 5: In-progress runs (PENDING)
    if pending_workflows:
        return AggregateResult(
            status="PENDING",
            reason="RUN_IN_PROGRESS",
            summary=f"CI workflows currently in progress: {', '.join(pending_workflows)}.",
            details={"pending": pending_workflows, "observed": sorted(active_O.keys())},
        )

    # Priority 6: All observed green and all applicable present
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
    pending_timeout_s: int = 300,
    poll_interval_s: int = 15,
    settle_sleep_s: int = 20,
    max_settle_resweeps: int = 3,
) -> AggregateResult:
    """Perform run sweep with monotonic deadline and bounded settle re-sweeps.

    - Bounded by single monotonic deadline: pending_timeout_s.
    - Missing runs polled up to earlier of poll_missing_timeout_s and pending_timeout_s.
    - Settle re-sweeps bounded by max_settle_resweeps.
    - Returns terminal FAILURE on timeout (PENDING_TIMEOUT or WORKFLOW_SET_DRIFT_TIMEOUT).
    """
    A = set(applicable_workflow_names)
    L_absent = set(label_not_present_workflow_names or [])
    K = set(all_known_workflow_names or [])
    start_time = time.monotonic()
    deadline = start_time + pending_timeout_s
    missing_deadline = start_time + poll_missing_timeout_s

    settle_count = 0
    observed_runs: dict[str, dict[str, Any]] | None = None

    while True:
        if observed_runs is None:
            raw_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
            observed_runs = group_latest_runs(raw_runs)

        eval_result = evaluate_ci_runs(
            A,
            observed_runs,
            label_not_present_workflow_names=L_absent,
            all_known_workflow_names=K,
        )

        # Immediate terminal failures:
        if eval_result.status == "FAILURE":
            if eval_result.reason != "MISSING_APPLICABLE_RUNS":
                return eval_result

            # If missing applicable runs, stop at earlier of missing deadline or overall deadline
            if time.monotonic() >= missing_deadline or time.monotonic() >= deadline:
                return eval_result
            observed_runs = None
            time.sleep(poll_interval_s)
            continue

        # In-progress / PENDING:
        if eval_result.status == "PENDING":
            if time.monotonic() >= deadline:
                return AggregateResult(
                    status="FAILURE",
                    reason="PENDING_TIMEOUT",
                    summary=f"Timed out waiting for in-progress CI workflows to complete ({pending_timeout_s}s limit exceeded).",
                    details=eval_result.details,
                )
            observed_runs = None
            time.sleep(poll_interval_s)
            continue

        # SUCCESS:
        if eval_result.status == "SUCCESS":
            active_O = {k: v for k, v in observed_runs.items() if k not in L_absent}
            if len(active_O) == 0 or settle_sleep_s <= 0:
                return eval_result

            if settle_count >= max_settle_resweeps:
                return AggregateResult(
                    status="FAILURE",
                    reason="WORKFLOW_SET_DRIFT_TIMEOUT",
                    summary=f"Workflow set repeatedly drifted during settle window without stabilizing ({max_settle_resweeps} attempts exceeded).",
                    details=eval_result.details,
                )

            time.sleep(settle_sleep_s)
            settle_count += 1

            recheck_runs = fetch_workflow_runs_for_sha(repo, head_sha, token)
            recheck_O = group_latest_runs(recheck_runs)
            active_recheck_O = {k: v for k, v in recheck_O.items() if k not in L_absent}

            if set(active_O.keys()) != set(active_recheck_O.keys()):
                # Drift detected during settle window
                if time.monotonic() >= deadline:
                    return AggregateResult(
                        status="FAILURE",
                        reason="WORKFLOW_SET_DRIFT_TIMEOUT",
                        summary="Workflow set changed during settle window and overall deadline expired.",
                        details={
                            "initial": sorted(active_O.keys()),
                            "recheck": sorted(active_recheck_O.keys()),
                        },
                    )
                # Re-loop to evaluate recheck_O without redundant fetch
                observed_runs = recheck_O
                continue

            # Stable! Re-evaluate with recheck_O
            return evaluate_ci_runs(
                A,
                recheck_O,
                label_not_present_workflow_names=L_absent,
                all_known_workflow_names=K,
            )


def load_classification_file(
    path: str | Path,
) -> tuple[set[str], set[str], set[str]]:
    """Load and strictly validate path filter classification JSON file (Requirement A-1).

    Requires:
    - Root must be a JSON object (dict).
    - Keys applicable_workflows, label_not_present_workflows, all_known_workflows must all exist.
    - Each value must be a list of non-blank strings.
    - all_known_workflows must be non-empty.
    - applicable_workflows and label_not_present_workflows must be subsets of all_known_workflows.

    Raises ValueError loudly on any violation (fails closed, never ZERO_RUNS success).
    """
    p = Path(path)
    if not p.is_file():
        raise ValueError(
            f"Classification file '{path}' does not exist or is not a file."
        )

    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise ValueError(f"Classification file '{path}' is not valid JSON: {e}")

    if not isinstance(data, dict):
        raise ValueError(
            f"Classification file '{path}' must be a JSON object, got {type(data).__name__}."
        )

    required_keys = (
        "applicable_workflows",
        "label_not_present_workflows",
        "all_known_workflows",
    )
    for key in required_keys:
        if key not in data:
            raise ValueError(
                f"Classification file '{path}' missing required key '{key}'."
            )
        val = data[key]
        if not isinstance(val, list):
            raise ValueError(
                f"Classification file '{path}' key '{key}' must be a list, got {type(val).__name__}."
            )
        for item in val:
            if not isinstance(item, str) or not item.strip():
                raise ValueError(
                    f"Classification file '{path}' key '{key}' contains non-string or blank element: {item!r}."
                )

    all_known_set = {s.strip() for s in data["all_known_workflows"]}
    applicable_set = {s.strip() for s in data["applicable_workflows"]}
    label_absent_set = {s.strip() for s in data["label_not_present_workflows"]}

    if not all_known_set:
        raise ValueError(
            f"Classification file '{path}' has empty 'all_known_workflows' set. Fail closed."
        )

    if not applicable_set.issubset(all_known_set):
        diff = applicable_set - all_known_set
        raise ValueError(
            f"Classification file '{path}' applicable_workflows contains workflows not in all_known_workflows: {sorted(diff)}."
        )

    if not label_absent_set.issubset(all_known_set):
        diff = label_absent_set - all_known_set
        raise ValueError(
            f"Classification file '{path}' label_not_present_workflows contains workflows not in all_known_workflows: {sorted(diff)}."
        )

    return applicable_set, label_absent_set, all_known_set


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sweep and aggregate PR CI workflow runs"
    )
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument("--sha", required=True, help="Commit head SHA")
    parser.add_argument(
        "--classification-file",
        required=True,
        help="Path to JSON file output by path_filter.py (required production transport)",
    )
    parser.add_argument(
        "--poll-timeout",
        type=int,
        default=90,
        help="Polling timeout for missing runs (seconds)",
    )
    parser.add_argument(
        "--pending-timeout",
        type=int,
        default=300,
        help="Overall monotonic timeout for pending/in-progress runs (seconds)",
    )
    parser.add_argument(
        "--settle-sleep",
        type=int,
        default=20,
        help="Settle sleep before declaring success (seconds)",
    )
    parser.add_argument(
        "--max-settle-resweeps",
        type=int,
        default=3,
        help="Maximum settle re-sweeps before drift timeout",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")

    applicable_set, label_absent_set, all_known_set = load_classification_file(
        args.classification_file
    )

    result = sweep_and_evaluate_with_polling(
        repo=args.repo,
        head_sha=args.sha,
        token=token,
        applicable_workflow_names=applicable_set,
        label_not_present_workflow_names=label_absent_set,
        all_known_workflow_names=all_known_set,
        poll_missing_timeout_s=args.poll_timeout,
        pending_timeout_s=args.pending_timeout,
        poll_interval_s=15,
        settle_sleep_s=args.settle_sleep,
        max_settle_resweeps=args.max_settle_resweeps,
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
