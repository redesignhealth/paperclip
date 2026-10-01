#!/usr/bin/env python3
"""Deterministic path-based workflow classifier for merge gates (TECH-7014).

Parses default-branch pull_request workflow definitions and determines which
workflows are applicable for a given pull request based on its changed files,
branches, and labels (e.g. Storybook Visual label gate in paperclip).
Fail-closed on any truncation, unmodeled workflow syntax, count mismatch, or
synchronize race.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from gate_constants import (
    GATE_EXCLUDED_WORKFLOW_FILES,
    GATE_EXCLUDED_WORKFLOW_NAMES,
    LABEL_GATED_WORKFLOWS,
)

PATHS_FILTER_LIMIT = 300
MAX_PAGES = 30
PER_PAGE = 100
STANDARD_OPEN_TYPES = {"opened", "synchronize", "reopened"}
UNMODELED_KEYS = {"paths-ignore", "branches-ignore", "tags", "tags-ignore"}


def github_glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Convert a GitHub-compatible path glob pattern to an anchored regex.

    GitHub Actions path filtering rules:
    - Root-anchored by default: `Dockerfile` matches `Dockerfile` at root only.
    - Leading slash and `./` are normalized away.
    - Trailing slash (e.g. `scripts/` or `scripts/**/`) normalizes to directory prefix (`scripts/**`).
    - `**` matches zero or more path segments (`(?:[^/]+/)*`).
    - `*` matches zero or more characters within a path segment (no `/`).
    - `?` matches a single character within a path segment (no `/`).
    - Negated character classes `[!...]` are converted to `[^.../]` with safe leading-hyphen escaping.
    - Exact root anchoring: pattern starts with `^` and ends with `$`.
    """
    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    pattern = pattern.lstrip("/")

    # Normalize trailing / to /** before tokenizing (Requirement 9)
    if pattern.endswith("/"):
        trimmed = pattern.rstrip("/")
        if trimmed.endswith("/**"):
            pattern = trimmed
        else:
            pattern = trimmed + "/**"

    res: list[str] = ["^"]
    i = 0
    n = len(pattern)

    while i < n:
        c = pattern[i]
        if c == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                # Double star `**`
                i += 2
                if i < n and pattern[i] == "/":
                    # `**/` -> non-greedy segment-safe zero or more path segments
                    i += 1
                    res.append("(?:[^/]+/)*")
                else:
                    # `**` at end or followed by something else
                    res.append(".*")
            else:
                # Single star `*`
                res.append("[^/]*")
                i += 1
        elif c == "?":
            res.append("[^/]")
            i += 1
        elif c == "[":
            # Character class
            end = pattern.find("]", i + 1)
            if end == -1:
                res.append(re.escape(c))
                i += 1
            else:
                class_content = pattern[i + 1 : end]
                if class_content.startswith("!") or class_content.startswith("^"):
                    inner = class_content[1:]
                    if inner.startswith("-"):
                        inner = r"\-" + inner[1:]
                    if inner.endswith("-"):
                        inner = inner[:-1] + r"\-"
                    res.append(f"[^{inner}/]")
                else:
                    res.append(f"[{class_content}]")
                i = end + 1
        elif c in r"\.+()^$|{}":
            res.append(re.escape(c))
            i += 1
        else:
            res.append(c)
            i += 1

    res.append("$")
    return re.compile("".join(res))


def evaluate_branch_patterns(patterns: list[str], default_branch: str) -> bool | None:
    """Evaluate ordered GitHub Actions branch patterns against default branch.

    Returns:
    - True if default branch matches the branch filter
    - False if default branch is excluded by the branch filter (branches_exclude_default)
    - None if filter contains only negative patterns, is invalid, or cannot be modeled
    """
    if not isinstance(patterns, list) or not patterns:
        return None

    has_positive = any(
        not p.startswith("!") for p in patterns if isinstance(p, str) and p.strip()
    )
    if not has_positive:
        # Negative-only patterns are unmodeled per Requirement 10
        return None

    matched = False
    for raw_pat in patterns:
        if not isinstance(raw_pat, str) or not raw_pat.strip():
            return None
        p = raw_pat.strip()
        is_neg = p.startswith("!")
        pat = p[1:] if is_neg else p

        if pat in {"*", "**", default_branch}:
            is_match = True
        else:
            try:
                regex = github_glob_to_regex(pat)
                is_match = bool(regex.match(default_branch))
            except Exception:
                return None

        if is_match:
            matched = not is_neg

    return matched


@dataclass
class WorkflowRule:
    name: str
    file_path: Path
    unfiltered: bool = False
    unmodeled: bool = False
    unmodeled_reason: str = ""
    not_applicable_types: bool = False
    types: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    label_required: str | None = None
    branch_excluded: bool = False


@dataclass
class ClassificationResult:
    workflow_name: str
    applicable: bool
    reason: str
    details: str = ""


def parse_workflow_file(
    workflow_path: Path, default_branch: str = "master"
) -> WorkflowRule | None:
    """Parse a workflow YAML file and extract its pull_request filter rule."""
    try:
        import yaml
    except ImportError:
        raise RuntimeError("PyYAML 6.0.2 is required to parse workflow files.")

    content = workflow_path.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    if not isinstance(data, dict):
        return None

    # In YAML 1.1, bare `on:` key parses as boolean True
    on = data.get("on")
    if on is None and True in data:
        on = data[True]

    if on is None:
        return None

    name = data.get("name") or workflow_path.stem

    # Exclude anchor trigger and gate workflows symmetrically by file or name
    if (
        name in GATE_EXCLUDED_WORKFLOW_NAMES
        or workflow_path.name in GATE_EXCLUDED_WORKFLOW_FILES
    ):
        return None

    # Key label-gated workflows by configuration and filename
    for wf_name, cfg in LABEL_GATED_WORKFLOWS.items():
        if name == wf_name or workflow_path.name == cfg["file"]:
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                label_required=cfg["label"],
            )

    # Normalize on definition
    if isinstance(on, str):
        if on == "pull_request":
            return WorkflowRule(name=name, file_path=workflow_path, unfiltered=True)
        return None

    if isinstance(on, list):
        if "pull_request" in on:
            return WorkflowRule(name=name, file_path=workflow_path, unfiltered=True)
        return None

    if not isinstance(on, dict):
        return None

    if "pull_request" not in on:
        return None

    pr_config = on["pull_request"]
    if pr_config is None or not isinstance(pr_config, dict):
        return WorkflowRule(name=name, file_path=workflow_path, unfiltered=True)

    # Check for unmodeled keys
    for k in UNMODELED_KEYS:
        if k in pr_config:
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                unmodeled=True,
                unmodeled_reason=f"unmodeled trigger key: {k}",
            )

    # Ordered branch pattern evaluation against default branch (Requirement 10)
    branches = pr_config.get("branches")
    if branches is not None:
        branch_status = evaluate_branch_patterns(branches, default_branch)
        if branch_status is None:
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                unmodeled=True,
                unmodeled_reason=f"unmodeled branches filter: {branches}",
            )
        if branch_status is False:
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                branch_excluded=True,
            )

    # Check types
    types = pr_config.get("types")
    if types is not None:
        if isinstance(types, list):
            if not any(t in STANDARD_OPEN_TYPES for t in types):
                return WorkflowRule(
                    name=name,
                    file_path=workflow_path,
                    not_applicable_types=True,
                    types=types,
                )
        else:
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                unmodeled=True,
                unmodeled_reason="types is not a list",
            )

    # Check paths
    paths = pr_config.get("paths")
    if paths is None:
        return WorkflowRule(name=name, file_path=workflow_path, unfiltered=True)

    if not isinstance(paths, list):
        return WorkflowRule(
            name=name,
            file_path=workflow_path,
            unmodeled=True,
            unmodeled_reason="paths is not a list",
        )

    for p in paths:
        if not isinstance(p, str):
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                unmodeled=True,
                unmodeled_reason="non-string path pattern",
            )
        if p.startswith("!"):
            return WorkflowRule(
                name=name,
                file_path=workflow_path,
                unmodeled=True,
                unmodeled_reason=f"leading '!' in path: {p}",
            )

    return WorkflowRule(name=name, file_path=workflow_path, paths=paths)


def classify_workflow(
    rule: WorkflowRule,
    changed_files: list[str],
    total_changed_files_count: int,
    labels: list[str] | None = None,
    default_branch: str = "master",
) -> ClassificationResult:
    """Classify a workflow as applicable or not applicable."""
    # Branch exclusion check (Requirement 10)
    if rule.branch_excluded:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=False,
            reason="branches_exclude_default",
            details=f"Workflow branches filter excludes default branch '{default_branch}'",
        )

    # Label-gated workflows (e.g. Storybook Visual)
    if rule.label_required:
        active_labels = labels or []
        if rule.label_required in active_labels:
            return ClassificationResult(
                workflow_name=rule.name,
                applicable=True,
                reason="label_present",
                details=f"PR carries required '{rule.label_required}' label",
            )
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=False,
            reason="label_not_present",
            details=f"PR lacks required '{rule.label_required}' label",
        )

    if rule.not_applicable_types:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=False,
            reason="types_excluding_open_sync_reopen",
            details=f"types {rule.types} does not intersect {sorted(STANDARD_OPEN_TYPES)}",
        )

    if rule.unmodeled:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=True,
            reason="unmodeled",
            details=rule.unmodeled_reason,
        )

    if rule.unfiltered:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=True,
            reason="unfiltered",
            details="no paths filter defined on pull_request trigger",
        )

    # Filtered workflow check
    if total_changed_files_count > PATHS_FILTER_LIMIT:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=True,
            reason="indeterminate_limit",
            details=f"changed files count {total_changed_files_count} exceeds limit {PATHS_FILTER_LIMIT}",
        )

    if total_changed_files_count == 0:
        return ClassificationResult(
            workflow_name=rule.name,
            applicable=False,
            reason="paths_no_match",
            details="zero changed files",
        )

    compiled_patterns = [github_glob_to_regex(p) for p in rule.paths]
    for file in changed_files:
        norm_file = file.lstrip("/")
        for pattern in compiled_patterns:
            if pattern.match(norm_file):
                return ClassificationResult(
                    workflow_name=rule.name,
                    applicable=True,
                    reason="paths_match",
                    details=f"matched file '{norm_file}' with pattern '{pattern.pattern}'",
                )

    return ClassificationResult(
        workflow_name=rule.name,
        applicable=False,
        reason="paths_no_match",
        details="no changed files matched configured path patterns",
    )


def fetch_pr_data(
    repo: str, pr_number: int, token: str
) -> tuple[str, int, list[str], list[str]]:
    """Fetch PR head SHA, total changed files count, files list, and labels.

    Reconciles API file entry count against PR changed_files count, while
    including both `filename` and `previous_filename` (for renamed files).
    Fails closed if pagination exceeds MAX_PAGES or if the count mismatches.
    """
    base_url = f"https://api.github.com/repos/{repo}/pulls/{pr_number}"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "merge-gate-path-filter",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(base_url, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(
            f"Failed to fetch PR #{pr_number} metadata from {base_url}: {e}"
        )

    head_sha = data["head"]["sha"]
    changed_files_count = int(data.get("changed_files", 0))
    raw_labels = data.get("labels", [])
    labels = [
        lbl.get("name")
        for lbl in raw_labels
        if isinstance(lbl, dict) and lbl.get("name")
    ]

    if changed_files_count == 0:
        return head_sha, 0, [], labels

    collected_files: list[str] = []
    total_file_entries = 0
    page = 1

    while page <= MAX_PAGES:
        files_url = f"{base_url}/files?per_page={PER_PAGE}&page={page}"
        req_page = urllib.request.Request(files_url, headers=headers)
        try:
            with urllib.request.urlopen(req_page) as resp:
                page_data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            raise RuntimeError(
                f"Failed to fetch page {page} of PR #{pr_number} files: {e}"
            )

        if not isinstance(page_data, list):
            raise RuntimeError(
                f"Unexpected non-list response for PR #{pr_number} files on page {page}"
            )

        if not page_data:
            break

        for item in page_data:
            total_file_entries += 1
            filename = item.get("filename")
            if filename:
                collected_files.append(filename)
            prev = item.get("previous_filename")
            if prev:
                collected_files.append(prev)

        if len(page_data) < PER_PAGE:
            break

        page += 1

    if page > MAX_PAGES and total_file_entries < changed_files_count:
        raise RuntimeError(
            f"PR #{pr_number} files exceeded maximum pagination limit of {MAX_PAGES} pages ({changed_files_count} files). Fail closed."
        )

    if total_file_entries != changed_files_count:
        raise RuntimeError(
            f"Collected API file entries ({total_file_entries}) does not match PR changed_files ({changed_files_count}). Fail closed."
        )

    return head_sha, changed_files_count, collected_files, labels


def classify_all_workflows(
    workflows_dir: Path,
    changed_files: list[str],
    total_count: int,
    labels: list[str] | None = None,
    default_branch: str = "master",
) -> list[ClassificationResult]:
    """Parse and classify all pull_request workflows in the directory.

    Fails closed with RuntimeError if workflows_dir does not exist or is not a directory.
    """
    if not workflows_dir.is_dir():
        raise RuntimeError(
            f"Workflows directory '{workflows_dir}' does not exist or is not a directory. Fail closed."
        )

    results: list[ClassificationResult] = []
    for yml in sorted(workflows_dir.glob("*.yml")) + sorted(
        workflows_dir.glob("*.yaml")
    ):
        rule = parse_workflow_file(yml, default_branch=default_branch)
        if rule is not None:
            res = classify_workflow(
                rule,
                changed_files,
                total_count,
                labels=labels,
                default_branch=default_branch,
            )
            results.append(res)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deterministic path classifier for PR CI workflows"
    )
    parser.add_argument("--repo", required=True, help="GitHub repository (owner/repo)")
    parser.add_argument(
        "--pr-number", type=int, required=True, help="Pull request number"
    )
    parser.add_argument(
        "--workflows-dir",
        default=".github/workflows",
        help="Path to workflows directory",
    )
    parser.add_argument(
        "--default-branch", default="master", help="Repository default branch"
    )
    parser.add_argument(
        "--expected-sha", help="Expected PR head SHA (checks for synchronize race)"
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    head_sha, total_count, changed_files, labels = fetch_pr_data(
        args.repo, args.pr_number, token
    )

    if args.expected_sha and args.expected_sha.strip() != head_sha:
        raise RuntimeError(
            f"Synchronize race detected: PR live head SHA ({head_sha}) does not match expected SHA ({args.expected_sha}). Stale run."
        )

    results = classify_all_workflows(
        Path(args.workflows_dir),
        changed_files,
        total_count,
        labels=labels,
        default_branch=args.default_branch,
    )
    applicable = [r.workflow_name for r in results if r.applicable]
    label_not_present = [
        r.workflow_name for r in results if r.reason == "label_not_present"
    ]
    all_known = [r.workflow_name for r in results]

    output = {
        "head_sha": head_sha,
        "total_changed_files": total_count,
        "changed_files_sample": changed_files[:20],
        "labels": labels,
        "applicable_workflows": applicable,
        "label_not_present_workflows": label_not_present,
        "all_known_workflows": all_known,
        "classifications": [
            {
                "workflow": r.workflow_name,
                "applicable": r.applicable,
                "reason": r.reason,
                "details": r.details,
            }
            for r in results
        ],
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
