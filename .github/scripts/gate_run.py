#!/usr/bin/env python3
"""Privileged gate runner: publish the `argus-gate` and `ci-aggregate` App checks for one PR (TECH-7014).

Runs only in the `gate` job of the reusable workflow, from the default branch, after the role was
assumed and the RH PR Approval Gate App (id 5166579) installation token was minted. Two clients:

- `read`: the workflow GITHUB_TOKEN, read-only (PR metadata, Actions runs). It never writes.
- `app`: the App installation token (check runs, and the optional UI approval review).

Sequence for the PR head H read live from the API:
  1. eligibility (open, base master, valid head repo, not authored by the gate App, head still
     the one classified);
  2. IN_PROGRESS `argus-gate` and `ci-aggregate` check runs on exactly H (adopting a run that is
     already in progress) BEFORE any backend is queried;
  3. evaluate Argus + CI; unless both pass, publish the outcomes (a pass is the only success, a
     definitive failure concludes `failure`, anything unfinished or unreadable stays in progress);
  4. when both pass, evaluate everything AGAIN against a fresh read of the head, and only then
     conclude success, explicitly on H (never on whatever the head is by then). If the head moved,
     the checks on the old head are concluded `cancelled` and the new head needs its own approval;
  5. optional App APPROVE review at commit H, de-duplicated against reviews the App itself already
     approved at H. The checks, not the review, are the authority: other bots or humans can also
     approve, and GitHub may refuse the App's review on some PRs.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import argus_verdict
import ci_aggregate
import gate_lib
from gate_lib import GateError


class Superseded(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Outcome:
    kind: str  # success | failure | pending | cancelled
    title: str
    summary: str


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def argus_outcome(res: argus_verdict.ArgusResult) -> Outcome:
    kind = {"approve": "success", "blocking": "failure"}.get(res.state, "pending")
    return Outcome(kind, f"Argus: {res.code}", res.summary)


def ci_outcome(res: ci_aggregate.CiResult) -> Outcome:
    kind = {"SUCCESS": "success", "FAILURE": "failure"}.get(res.state, "pending")
    return Outcome(kind, f"CI: {res.code}", res.summary)


def latest_app_check(app: Any, name: str, sha: str) -> dict[str, Any] | None:
    data = app.get(
        f"/repos/{gate_lib.REPO}/commits/{sha}/check-runs?check_name={name}&app_id={gate_lib.APP_ID}&filter=latest&per_page=100"
    )
    runs = data.get("check_runs") if isinstance(data, dict) else None
    if not isinstance(runs, list):
        raise GateError("MALFORMED_RESPONSE")
    mine = [
        r for r in runs
        if isinstance(r, dict) and r.get("name") == name and (r.get("app") or {}).get("id") == gate_lib.APP_ID
        and isinstance(r.get("id"), int)
    ]
    return max(mine, key=lambda r: r["id"]) if mine else None


def start_check(app: Any, name: str, sha: str) -> int:
    latest = latest_app_check(app, name, sha)
    if latest and latest.get("status") in ("queued", "in_progress") and latest.get("head_sha") == sha:
        return latest["id"]
    created = app.post(
        f"/repos/{gate_lib.REPO}/check-runs",
        {
            "name": name,
            "head_sha": sha,
            "status": "in_progress",
            "started_at": _now(),
            "output": {"title": "Evaluating", "summary": f"Evaluating {name} for {sha[:7]}."},
        },
    )
    if (
        not isinstance(created, dict)
        or not isinstance(created.get("id"), int)
        or created.get("head_sha") != sha
        or (created.get("app") or {}).get("id") != gate_lib.APP_ID
    ):
        raise GateError("CHECK_CREATE_MISMATCH")
    return created["id"]


def publish(app: Any, name: str, sha: str, check_id: int, outcome: Outcome) -> None:
    out = {"title": outcome.title, "summary": outcome.summary}
    path = f"/repos/{gate_lib.REPO}/check-runs/{check_id}"
    if outcome.kind == "pending":
        app.patch(path, {"status": "in_progress", "output": out})
        return
    if outcome.kind == "success":
        # Re-read the latest App record for this name at H right before concluding: if another
        # evaluation wrote a newer record meanwhile, this one must not overwrite it with success.
        latest = latest_app_check(app, name, sha)
        if not latest or latest["id"] != check_id or latest.get("status") == "completed":
            raise GateError("CHECK_SUPERSEDED")
    app.patch(path, {"status": "completed", "conclusion": outcome.kind, "completed_at": _now(), "output": out})


def submit_review(read: Any, app: Any, pr_number: int, sha: str) -> str:
    """Optional UI approval by the App at commit `sha`. Never raises; returns a fixed status."""
    try:
        live = read.get(f"/repos/{gate_lib.REPO}/pulls/{pr_number}")
        if gate_lib.pr_ineligibility(live, expected_head=sha) is not None:
            return "SKIPPED_HEAD_CHANGED"
        reviews = app.paginate(f"/repos/{gate_lib.REPO}/pulls/{pr_number}/reviews")
        for rev in reviews:
            if (
                isinstance(rev, dict)
                and (rev.get("user") or {}).get("login") == gate_lib.APP_BOT_LOGIN
                and rev.get("state") == "APPROVED"
                and rev.get("commit_id") == sha
                and gate_lib.REVIEW_MARKER in (rev.get("body") or "")
            ):
                return "ALREADY_APPROVED"
        app.post(
            f"/repos/{gate_lib.REPO}/pulls/{pr_number}/reviews",
            {
                "commit_id": sha,
                "event": "APPROVE",
                "body": f"{gate_lib.REVIEW_MARKER}\nArgus approved this PR at `{sha[:7]}` and the required CI succeeded at that commit.",
            },
        )
        return "APPROVED"
    except GateError as exc:
        return f"REVIEW_UNAVAILABLE_{exc.code}"


def recompute_required(base_required: list[str], labels: list[str]) -> list[str]:
    """Recompute required workflows taking into account label-dependent workflows."""
    req = set(base_required)
    if "storybook-visual" in labels:
        req.add(".github/workflows/storybook-visual.yml")
    else:
        req.discard(".github/workflows/storybook-visual.yml")
    return sorted(req)


def run(
    pr_number: int,
    expected_head: str,
    required: list[str],
    *,
    read: Any,
    app: Any,
    fetch_key: Callable[[], str] = argus_verdict.fetch_api_key,
    argus_check: Callable[[int, str, str], argus_verdict.ArgusResult] = argus_verdict.check,
    ci_check: Callable[..., ci_aggregate.CiResult] = ci_aggregate.aggregate,
) -> int:
    """Return 0 when every outcome was published as intended, 1 on an infrastructure/data error."""
    pr_path = f"/repos/{gate_lib.REPO}/pulls/{pr_number}"
    live = read.get(pr_path)
    reason = gate_lib.pr_ineligibility(live, expected_head=expected_head)
    if reason is not None:
        print(f"::notice::PR {pr_number} is not approved by the gate: {reason}")
        return 0
    sha = live["head"]["sha"]
    pr_head_repo_id = (live.get("head") or {}).get("repo", {}).get("id")
    initial_labels = [l.get("name") for l in (live.get("labels") or []) if isinstance(l, dict) and isinstance(l.get("name"), str)]

    try:
        ids = {name: start_check(app, name, sha) for name in (gate_lib.CHECK_ARGUS, gate_lib.CHECK_CI)}
    except GateError as exc:
        print(f"::error::gate evaluation error: {exc.code}")
        return 1

    def publish_pair(argus: Outcome, ci: Outcome) -> None:
        publish(app, gate_lib.CHECK_ARGUS, sha, ids[gate_lib.CHECK_ARGUS], argus)
        publish(app, gate_lib.CHECK_CI, sha, ids[gate_lib.CHECK_CI], ci)

    def park(code: str) -> int:
        note = f"Evaluation could not complete ({code}); it will be retried by the next trigger."
        out = Outcome("pending", f"Not evaluated: {code}", note)
        try:
            publish_pair(out, out)
        except GateError:
            pass  # best effort: never turn a failed evaluation into anything but non-success
        print(f"::error::gate evaluation error: {code}")
        return 1

    def hold(out: Outcome) -> Outcome:
        if out.kind != "success":
            return out
        return Outcome("pending", out.title, out.summary + "\nPassed; waiting for the other gate before concluding success.")

    def evaluate(key: str) -> tuple[argus_verdict.ArgusResult, ci_aggregate.CiResult]:
        fresh = read.get(pr_path)
        why = gate_lib.pr_ineligibility(fresh, expected_head=sha)
        if why is not None:
            raise Superseded(why)
        fresh_head_repo_id = (fresh.get("head") or {}).get("repo", {}).get("id")
        fresh_labels = [l.get("name") for l in (fresh.get("labels") or []) if isinstance(l, dict) and isinstance(l.get("name"), str)]
        if set(fresh_labels) != set(initial_labels):
            raise Superseded("LABELS_CHANGED")
        current_required = recompute_required(required, fresh_labels)
        return (
            argus_check(pr_number, sha, key),
            ci_check(read, sha, current_required, pr_head_repo_id=fresh_head_repo_id, pr_labels=fresh_labels),
        )

    try:
        key = fetch_key()
        argus, ci = evaluate(key)
        if not (argus.passed and ci.state == "SUCCESS"):
            # A success is concluded only after the second, fresh evaluation below: a half-passing
            # first read stays in progress (with a note) instead of publishing an early success.
            publish_pair(hold(argus_outcome(argus)), hold(ci_outcome(ci)))
            print(f"gate not satisfied for {sha[:7]}: argus={argus.code} ci={ci.code}")
            return 1 if argus.state == "error" else 0
        # Fresh read of head + Argus + CI immediately before concluding success.
        argus, ci = evaluate(key)
        publish_pair(argus_outcome(argus), ci_outcome(ci))
    except Superseded as exc:
        cancelled = Outcome("cancelled", "Superseded", f"The head changed or the PR is no longer eligible ({exc.code}).")
        publish_pair(cancelled, cancelled)
        print(f"::notice::{sha[:7]} superseded: {exc.code}")
        return 0
    except GateError as exc:
        return park(exc.code)

    if argus.passed and ci.state == "SUCCESS":
        print(f"gate satisfied for {sha[:7]}; review: {submit_review(read, app, pr_number, sha)}")
        return 0
    print(f"gate no longer satisfied for {sha[:7]} on re-read: argus={argus.code} ci={ci.code}")
    return 1 if argus.state == "error" else 0


def main() -> int:
    try:
        pr_number = gate_lib.parse_pr_number(os.environ.get("PR_NUMBER", ""))
        expected = gate_lib.require_full_sha(os.environ.get("EXPECTED_HEAD_SHA", ""))
        required = json.loads(os.environ.get("REQUIRED_WORKFLOWS", ""))
        if not isinstance(required, list) or not all(
            isinstance(p, str) and gate_lib.WORKFLOW_PATH_RE.fullmatch(p) for p in required
        ):
            raise GateError("INVALID_REQUIRED_WORKFLOWS")
        read = gate_lib.GitHub(os.environ.get("GITHUB_TOKEN", ""))
        app = gate_lib.GitHub(os.environ.get("APP_TOKEN", ""))
        return run(pr_number, expected, required, read=read, app=app)
    except GateError as exc:
        print(f"::error::gate failed: {exc.code}")
        return 1
    except ValueError:
        print("::error::gate failed: INVALID_REQUIRED_WORKFLOWS")
        return 1


if __name__ == "__main__":
    sys.exit(main())
