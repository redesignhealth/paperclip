#!/usr/bin/env python3
"""Decide which default-branch `pull_request` workflows are required for a PR (TECH-7014).

It parses the workflow definitions of the TRUSTED default-branch checkout
(never the PR's), compares their `pull_request.paths` filters with the PR's changed files, and
prints/writes the canonical workflow file paths that must have succeeded.

Fail closed: unmodeled trigger syntax, a truncated or non-reconciling file list, or more changed
files than GitHub's path filter evaluates (300) all make every such workflow required.

Runs in the unprivileged `classify` job (PyYAML is installed there, never in the job that holds
credentials). It also performs the first PR eligibility check and writes the job outputs.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import gate_lib
from gate_lib import GateError

PATHS_FILTER_LIMIT = 300
MAX_FILE_PAGES = 30
STANDARD_OPEN_TYPES = {"opened", "synchronize", "reopened"}
UNMODELED_KEYS = {"paths-ignore", "branches", "branches-ignore", "tags", "tags-ignore"}


def github_glob_to_regex(pattern: str) -> re.Pattern[str]:
    """GitHub path-filter glob -> anchored regex (`**` crosses `/`, `*` and `?` do not)."""
    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    res: list[str] = ["^"]
    i, n = 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                i += 2
                if i < n and pattern[i] == "/":
                    i += 1
                    res.append("(?:.+/)?")
                else:
                    res.append(".*")
            else:
                res.append("[^/]*")
                i += 1
        elif c == "?":
            res.append("[^/]")
            i += 1
        elif c == "[":
            end = pattern.find("]", i + 1)
            if end == -1:
                res.append(re.escape(c))
                i += 1
            else:
                content = pattern[i + 1 : end]
                if content.startswith("!"):
                    content = "^" + content[1:]
                res.append("[" + content + "]")
                i = end + 1
        elif c in r"\.+()^$|{}":
            res.append(re.escape(c))
            i += 1
        else:
            res.append(c)
            i += 1
    res.append("$")
    return re.compile("".join(res))


@dataclass
class WorkflowRule:
    path: str  # canonical `.github/workflows/<file>`
    unfiltered: bool = False
    unmodeled: bool = False
    not_applicable_types: bool = False
    paths: list[str] = field(default_factory=list)
    required_label: str | None = None


def is_canonical_storybook_contract(content: str) -> bool:
    """Validate the exact canonical contract of .github/workflows/storybook-visual.yml as data."""
    try:
        import yaml
        data = yaml.safe_load(content)
        if not isinstance(data, dict):
            return False
        on = data.get("on") if "on" in data else data.get(True)
        if not isinstance(on, dict):
            return False
        pr_cfg = on.get("pull_request")
        if not isinstance(pr_cfg, dict):
            return False
        if pr_cfg.get("branches") != ["master"]:
            return False
        types = pr_cfg.get("types")
        if not isinstance(types, list) or "labeled" not in types:
            return False
        jobs = data.get("jobs")
        if not isinstance(jobs, dict) or set(jobs) != {"visual", "preview"}:
            return False
        visual = jobs.get("visual")
        preview = jobs.get("preview")
        if not isinstance(visual, dict) or not isinstance(preview, dict):
            return False
        if visual.get("name") != "Storybook visual regression" or preview.get("name") != "Deploy selected branch Storybook":
            return False
        raw_vis_if = visual.get("if")
        raw_prev_if = preview.get("if")
        if not isinstance(raw_vis_if, str) or not isinstance(raw_prev_if, str):
            return False
        vis_if = " ".join(raw_vis_if.strip().split())
        prev_if = " ".join(raw_prev_if.strip().split())
        expected_vis_if = "(github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))"
        expected_prev_if = "github.event_name == 'workflow_dispatch' && inputs.deploy_preview"
        return vis_if == expected_vis_if and prev_if == expected_prev_if
    except Exception:
        return False


def parse_workflow(workflow_file: Path) -> WorkflowRule | None:
    """Return the pull_request rule of one workflow file, or None if it has no pull_request trigger."""
    try:
        import yaml
    except ImportError:
        raise RuntimeError("PyYAML 6.0.2 is required to parse workflow files.") from None

    content = workflow_file.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    if not isinstance(data, dict):
        return None
    on = data.get("on")
    if on is None and True in data:  # YAML 1.1 parses a bare `on:` key as boolean True
        on = data[True]
    path = f".github/workflows/{workflow_file.name}"

    if isinstance(on, str):
        return WorkflowRule(path, unfiltered=True) if on == "pull_request" else None
    if isinstance(on, list):
        return WorkflowRule(path, unfiltered=True) if "pull_request" in on else None
    if not isinstance(on, dict) or "pull_request" not in on:
        return None

    # Handle known label-gated optional workflows: only when matching canonical data contract
    if workflow_file.name == "storybook-visual.yml":
        if is_canonical_storybook_contract(content):
            return WorkflowRule(path, required_label="storybook-visual")
        return WorkflowRule(path, unmodeled=True)

    cfg = on["pull_request"]
    if not isinstance(cfg, dict):
        return WorkflowRule(path, unfiltered=True)
    if any(k in cfg for k in UNMODELED_KEYS):
        return WorkflowRule(path, unmodeled=True)
    types = cfg.get("types")
    if types is not None:
        if not isinstance(types, list):
            return WorkflowRule(path, unmodeled=True)
        if not any(t in STANDARD_OPEN_TYPES for t in types):
            return WorkflowRule(path, not_applicable_types=True)
    paths = cfg.get("paths")
    if paths is None:
        return WorkflowRule(path, unfiltered=True)
    if not isinstance(paths, list) or any(not isinstance(p, str) or p.startswith("!") for p in paths):
        return WorkflowRule(path, unmodeled=True)
    return WorkflowRule(path, paths=paths)


def is_required(
    rule: WorkflowRule,
    changed_files: list[str],
    total_count: int,
    labels: list[str] | set[str] | None = None,
) -> bool:
    if rule.required_label is not None:
        return rule.required_label in (labels or [])
    if rule.not_applicable_types:
        return False
    if rule.unmodeled or rule.unfiltered:
        return True
    if total_count > PATHS_FILTER_LIMIT:
        return True
    if total_count == 0:
        return False
    compiled = [github_glob_to_regex(p) for p in rule.paths]
    return any(rx.match(f.lstrip("/")) for f in changed_files for rx in compiled)


def required_workflows(
    workflows_dir: Path,
    changed_files: list[str],
    total_count: int,
    labels: list[str] | set[str] | None = None,
) -> list[str]:
    out: list[str] = []
    for wf in sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml")):
        rule = parse_workflow(wf)
        if rule is not None:
            if rule.path in changed_files:
                out.append(rule.path)
            elif is_required(rule, changed_files, total_count, labels=labels):
                out.append(rule.path)
    return out


def fetch_changed_files(gh: Any, pr_number: int, expected_count: int) -> list[str]:
    """All changed file names; fails closed if the list does not reconcile with the PR metadata."""
    if expected_count == 0:
        return []
    items = gh.paginate(f"/repos/{gate_lib.REPO}/pulls/{pr_number}/files", max_pages=MAX_FILE_PAGES)
    names = [i.get("filename") for i in items if isinstance(i, dict) and isinstance(i.get("filename"), str)]
    if len(names) != expected_count:
        raise GateError("CHANGED_FILES_MISMATCH")
    return names


def main() -> int:
    out_path = os.environ.get("GITHUB_OUTPUT")
    try:
        pr_number = gate_lib.parse_pr_number(os.environ.get("PR_NUMBER", ""))
        gh = gate_lib.GitHub(os.environ.get("GITHUB_TOKEN", ""))
        pr = gh.get(f"/repos/{gate_lib.REPO}/pulls/{pr_number}")
        reason = gate_lib.pr_ineligibility(pr)
        if reason is not None:
            print(f"::notice::PR {pr_number} is not gated: {reason}")
            gate_lib.write_output("eligible", "false", out_path)
            return 0
        head_sha = pr["head"]["sha"]
        count = pr.get("changed_files")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise GateError("MALFORMED_PR")
        labels = [l.get("name") for l in (pr.get("labels") or []) if isinstance(l, dict) and isinstance(l.get("name"), str)]
        files = fetch_changed_files(gh, pr_number, count)
        required = required_workflows(Path(".github/workflows"), files, count, labels=labels)
    except GateError as exc:
        print(f"::error::classify failed: {exc.code}")
        return 1
    print(f"PR {pr_number} head {head_sha[:7]}: {len(required)} required workflow(s)")
    gate_lib.write_output("eligible", "true", out_path)
    gate_lib.write_output("head_sha", head_sha, out_path)
    gate_lib.write_output("required", json.dumps(required, separators=(",", ":")), out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
