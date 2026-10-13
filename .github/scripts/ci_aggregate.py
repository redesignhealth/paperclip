"""CI aggregation for the auto-approval gate in redesignhealth/paperclip (TECH-7014).

Evidence is the GitHub Actions run list of the exact head SHA H in the base repository:
- Run repository.id must be REPO_ID (1326789272).
- Run head_repository.id must match the PR's live head repo ID.
- Run head_sha must match exactly H.

Generic provenance for .github/workflows/pr.yml (TRUSTED_CI):
- The workflow file definition at head_sha must call the outer upstream workflow:
  paperclipai/paperclip/.github/workflows/pr-trusted.yml
  at ref master or refs/heads/master.
- Wrong local, extra/missing jobs, ci-routing replacement outer, or arbitrary SHA refs => UNTRUSTED_CI_DEFINITION.
- The API run.referenced_workflows must contain EXACTLY the 2 upstream entries:
  paperclipai/paperclip/.github/workflows/pr-trusted.yml
  paperclipai/paperclip/.github/workflows/ci-routing.yml
  at ref refs/heads/master (or master), recording their SHAs for audit. Missing or extra entries => fail closed.

Jobs evaluation:
- For .github/workflows/pr.yml, all jobs must carry the `ci / ` prefix.
- Anchors: `ci / gate / Select trusted runner`, `ci / policy`, `ci / verify`, `ci / e2e` are required success.
- Missing anchors or incomplete jobs => PENDING (fail closed).
- All present jobs in latest attempt must be `success`.
- Allowed skips is empty for pr.yml (upstream full_ci=false is only for stacked PRs whose base is not master, which are ineligible).
- `action_required` is a FAILURE.
- For .github/workflows/storybook-visual.yml, the workflow is only required when the PR holds the 'storybook-visual' label;
  when applicable, 'Storybook visual regression' must be success, and the dispatch-only preview job
  'Deploy selected branch Storybook' is legitimately allowed to be skipped on PR runs.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Callable

import yaml

import gate_lib
from gate_lib import GateError

OUTER_PR_TRUSTED_PATH = "paperclipai/paperclip/.github/workflows/pr-trusted.yml"
OUTER_ALLOWED_REFS = frozenset({"master", "refs/heads/master"})

EXPECTED_REFERENCED_PATHS = frozenset({
    "paperclipai/paperclip/.github/workflows/pr-trusted.yml",
    "paperclipai/paperclip/.github/workflows/ci-routing.yml",
})
APPROVED_REFERENCED_REFS = frozenset({"master", "refs/heads/master"})

PR_ANCHOR_JOBS = frozenset({
    "ci / gate / Select trusted runner",
    "ci / policy",
    "ci / verify",
    "ci / e2e",
})

OPTIONAL_SKIPPED_JOBS: dict[str, frozenset[str]] = {
    ".github/workflows/storybook-visual.yml": frozenset({"Deploy selected branch Storybook"}),
}

WAITING_CONCLUSIONS = frozenset({"action_required"})


@dataclass(frozen=True)
class CiResult:
    state: str  # SUCCESS | PENDING | FAILURE
    code: str
    summary: str


def validate_ci_definition(content: str) -> None:
    """Validate that .github/workflows/pr.yml matches TRUSTED_CI generic provenance rules.

    Outer call must be paperclipai/paperclip/.github/workflows/pr-trusted.yml at master or refs/heads/master.
    Raises GateError("UNTRUSTED_CI_DEFINITION") otherwise.
    """
    try:
        data = yaml.safe_load(content)
    except Exception:
        raise GateError("UNTRUSTED_CI_DEFINITION") from None
    if not isinstance(data, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    jobs = data.get("jobs")
    if not isinstance(jobs, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    if set(jobs) != {"ci"}:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    ci_job = jobs.get("ci")
    if not isinstance(ci_job, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    uses = ci_job.get("uses")
    if not isinstance(uses, str) or "@" not in uses:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    path, ref = uses.split("@", 1)
    if path != OUTER_PR_TRUSTED_PATH:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    if ref not in OUTER_ALLOWED_REFS:
        raise GateError("UNTRUSTED_CI_DEFINITION")


def validate_storybook_definition(content: str) -> None:
    """Validate that .github/workflows/storybook-visual.yml matches the canonical data contract.

    Raises GateError("UNTRUSTED_CI_DEFINITION") if the trigger, job names, or conditions deviate.
    """
    try:
        data = yaml.safe_load(content)
    except Exception:
        raise GateError("UNTRUSTED_CI_DEFINITION") from None
    if not isinstance(data, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    on = data.get("on") if "on" in data else data.get(True)
    if not isinstance(on, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    pr_cfg = on.get("pull_request")
    if not isinstance(pr_cfg, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    if pr_cfg.get("branches") != ["master"]:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    types = pr_cfg.get("types")
    if not isinstance(types, list) or "labeled" not in types:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    jobs = data.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != {"visual", "preview"}:
        raise GateError("UNTRUSTED_CI_DEFINITION")
    visual = jobs.get("visual")
    preview = jobs.get("preview")
    if not isinstance(visual, dict) or not isinstance(preview, dict):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    if visual.get("name") != "Storybook visual regression" or preview.get("name") != "Deploy selected branch Storybook":
        raise GateError("UNTRUSTED_CI_DEFINITION")
    raw_vis_if = visual.get("if")
    raw_prev_if = preview.get("if")
    if not isinstance(raw_vis_if, str) or not isinstance(raw_prev_if, str):
        raise GateError("UNTRUSTED_CI_DEFINITION")
    vis_if = " ".join(raw_vis_if.strip().split())
    prev_if = " ".join(raw_prev_if.strip().split())
    expected_vis_if = "(github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))"
    expected_prev_if = "github.event_name == 'workflow_dispatch' && inputs.deploy_preview"
    if vis_if != expected_vis_if or prev_if != expected_prev_if:
        raise GateError("UNTRUSTED_CI_DEFINITION")


def validate_run_referenced_workflows(run: dict[str, Any]) -> tuple[bool, str | None, dict[str, str]]:
    """Validate that run.referenced_workflows contains EXACTLY the 2 upstream entries:
    pr-trusted.yml and ci-routing.yml at refs/heads/master (or master), recording their SHAs for audit.
    """
    ref_wfs = run.get("referenced_workflows")
    if not isinstance(ref_wfs, list) or len(ref_wfs) == 0:
        return False, "missing referenced_workflows", {}

    if len(ref_wfs) != 2:
        return False, f"expected exactly 2 referenced_workflows, found {len(ref_wfs)}", {}

    sha_by_path: dict[str, str] = {}
    for entry in ref_wfs:
        if not isinstance(entry, dict):
            return False, "malformed referenced_workflow entry", {}
        raw_path = entry.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            return False, "missing path in referenced_workflow", {}
        if "@" in raw_path:
            path_part, at_ref = raw_path.split("@", 1)
        else:
            path_part = raw_path
            at_ref = None

        ref_part = entry.get("ref") or at_ref
        if path_part not in EXPECTED_REFERENCED_PATHS:
            return False, f"untrusted referenced workflow path '{path_part}'", {}

        if ref_part not in APPROVED_REFERENCED_REFS:
            return False, f"untrusted referenced workflow ref '{ref_part}'", {}

        sha_part = entry.get("sha")
        if not gate_lib.is_full_sha(sha_part):
            return False, f"invalid or missing commit SHA for '{path_part}'", {}

        if path_part in sha_by_path:
            return False, f"duplicate referenced workflow '{path_part}'", {}

        sha_by_path[path_part] = sha_part

    if set(sha_by_path.keys()) != EXPECTED_REFERENCED_PATHS:
        return False, "referenced_workflows does not contain exact required set", {}

    return True, None, sha_by_path


def latest_runs(runs: list[Any], head_sha: str, pr_head_repo_id: int) -> dict[str, dict[str, Any]]:
    """Latest pull_request run per workflow file path at exactly `head_sha` in this repository."""
    latest: dict[str, dict[str, Any]] = {}
    for run in runs:
        if not isinstance(run, dict):
            continue
        if run.get("head_sha") != head_sha or run.get("event") != "pull_request":
            continue
        if (run.get("repository") or {}).get("id") != gate_lib.REPO_ID:
            continue
        if (run.get("head_repository") or {}).get("id") != pr_head_repo_id:
            continue
        path = gate_lib.workflow_path(run)
        if path is None:
            continue
        key = (run.get("run_number") or 0, run.get("run_attempt") or 1)
        held = latest.get(path)
        if held is None or key > ((held.get("run_number") or 0), (held.get("run_attempt") or 1)):
            latest[path] = run
    return latest


def _job_problems(path: str, run: dict[str, Any], jobs: list[Any]) -> tuple[list[str], list[str]]:
    """Return (failed, pending) descriptions for the jobs of one successful run."""
    failed: list[str] = []
    pending: list[str] = []
    if not jobs:
        return [f"{path}: no jobs"], []

    is_pr_workflow = (path == ".github/workflows/pr.yml")
    is_storybook = (path == ".github/workflows/storybook-visual.yml")
    present_job_names = set()

    if is_pr_workflow:
        valid_refs, ref_err, recorded_shas = validate_run_referenced_workflows(run)
        if not valid_refs:
            failed.append(f"{path}: untrusted referenced_workflows ({ref_err})")

    optional = OPTIONAL_SKIPPED_JOBS.get(path, frozenset())

    for job in jobs:
        if not isinstance(job, dict):
            failed.append(f"{path}: malformed job")
            continue
        name = job.get("name")
        status = job.get("status")
        conclusion = job.get("conclusion")
        label = f"{path}: job {gate_lib.safe_token(name, 'unnamed')}"
        if isinstance(name, str):
            present_job_names.add(name)

        if is_pr_workflow and (not isinstance(name, str) or not name.startswith("ci / ")):
            failed.append(f"{label} lacks required 'ci / ' prefix")
            continue

        if status != "completed":
            pending.append(label)
        elif conclusion == "success":
            continue
        elif conclusion == "skipped" and name in optional:
            continue
        else:
            failed.append(f"{label} concluded {gate_lib.safe_token(conclusion, 'unknown')}")

    if is_pr_workflow:
        for anchor in sorted(PR_ANCHOR_JOBS):
            if anchor not in present_job_names:
                pending.append(f"{path}: missing anchor job '{anchor}'")

    if is_storybook:
        if "Storybook visual regression" not in present_job_names:
            pending.append(f"{path}: missing required job 'Storybook visual regression'")

    return failed, pending


def evaluate(
    required: set[str] | frozenset[str],
    latest: dict[str, dict[str, Any]],
    jobs_for_run: Callable[[int], list[Any]],
    pr_labels: list[str] | set[str] | None = None,
) -> CiResult:
    required = set(required)
    labels_set = set(pr_labels or [])

    if not required and not latest:
        return CiResult("SUCCESS", "ZERO_APPLICABLE_RUNS", "No CI workflow applies to this change and none ran.")

    failed: list[str] = []
    pending: list[str] = []

    for path in sorted(set(latest) | required):
        # Storybook Visual applicability check:
        if path == ".github/workflows/storybook-visual.yml":
            if "storybook-visual" not in labels_set and path not in required:
                # Unlabeled PR: Storybook Visual is not applicable and not required.
                continue

        run = latest.get(path)
        if run is None:
            pending.append(f"{path}: no run yet")
            continue
        status, conclusion = run.get("status"), run.get("conclusion")
        if status == "waiting" or conclusion in WAITING_CONCLUSIONS:
            failed.append(f"{path}: needs approval to run")
        elif status != "completed":
            pending.append(f"{path}: {gate_lib.safe_token(status, 'unknown')}")
        elif conclusion != "success":
            failed.append(f"{path}: concluded {gate_lib.safe_token(conclusion, 'unknown')}")
        else:
            run_id = run.get("id")
            if isinstance(run_id, bool) or not isinstance(run_id, int):
                failed.append(f"{path}: malformed run")
                continue
            job_failed, job_pending = _job_problems(path, run, jobs_for_run(run_id))
            failed.extend(job_failed)
            pending.extend(job_pending)

    if failed:
        return CiResult("FAILURE", "CI_NOT_GREEN", "Required CI did not succeed:\n" + "\n".join(f"- {x}" for x in failed))
    if pending:
        return CiResult("PENDING", "CI_PENDING", "Required CI has not finished:\n" + "\n".join(f"- {x}" for x in pending))
    return CiResult("SUCCESS", "ALL_GREEN", "Every required CI workflow succeeded at this head.")


def aggregate(
    gh: Any,
    head_sha: str,
    required: set[str] | frozenset[str],
    pr_head_repo_id: int | None = None,
    pr_labels: list[str] | set[str] | None = None,
) -> CiResult:
    """Fetch the runs and verify CI provenance and jobs at `head_sha`."""
    gate_lib.require_full_sha(head_sha)
    for path in required:
        if not gate_lib.WORKFLOW_PATH_RE.fullmatch(path):
            raise GateError("INVALID_REQUIRED_WORKFLOW")

    effective_head_repo_id = pr_head_repo_id if pr_head_repo_id is not None else gate_lib.REPO_ID

    # Validate CI provenance if pr.yml is in required or active
    if ".github/workflows/pr.yml" in required or not required:
        try:
            content_resp = gh.get(f"/repos/{gate_lib.REPO}/contents/.github/workflows/pr.yml?ref={head_sha}")
            if isinstance(content_resp, dict) and "content" in content_resp:
                raw_b64 = content_resp["content"]
                yaml_text = base64.b64decode(raw_b64).decode("utf-8")
                validate_ci_definition(yaml_text)
            elif isinstance(content_resp, str):
                validate_ci_definition(content_resp)
            else:
                return CiResult("FAILURE", "UNTRUSTED_CI_DEFINITION", "Could not read .github/workflows/pr.yml at head.")
        except GateError as exc:
            if exc.code == "UNTRUSTED_CI_DEFINITION":
                return CiResult("FAILURE", "UNTRUSTED_CI_DEFINITION", "The PR CI definition in .github/workflows/pr.yml is untrusted.")
            raise

    # Validate Storybook definition at head SHA
    try:
        content_sb = gh.get(f"/repos/{gate_lib.REPO}/contents/.github/workflows/storybook-visual.yml?ref={head_sha}")
        if isinstance(content_sb, dict) and "content" in content_sb:
            raw_b64 = content_sb["content"]
            yaml_text_sb = base64.b64decode(raw_b64).decode("utf-8")
            validate_storybook_definition(yaml_text_sb)
        elif isinstance(content_sb, str):
            validate_storybook_definition(content_sb)
        else:
            return CiResult("FAILURE", "UNTRUSTED_CI_DEFINITION", "Could not read .github/workflows/storybook-visual.yml at head.")
    except GateError as exc:
        if exc.code == "UNTRUSTED_CI_DEFINITION":
            return CiResult("FAILURE", "UNTRUSTED_CI_DEFINITION", "The PR CI definition in .github/workflows/storybook-visual.yml is untrusted.")
        raise

    runs = gh.paginate(
        f"/repos/{gate_lib.REPO}/actions/runs?head_sha={head_sha}&event=pull_request",
        "workflow_runs",
    )
    latest = latest_runs(runs, head_sha, effective_head_repo_id)

    def jobs_for_run(run_id: int) -> list[Any]:
        return gh.paginate(f"/repos/{gate_lib.REPO}/actions/runs/{run_id}/jobs?filter=latest", "jobs")

    return evaluate(required, latest, jobs_for_run, pr_labels=pr_labels)
