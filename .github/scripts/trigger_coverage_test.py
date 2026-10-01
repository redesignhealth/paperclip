#!/usr/bin/env python3
"""Drift test: verifies that Merge Gate triggers cover every PR workflow (TECH-7014).

Parses default-branch workflows declaring pull_request triggers and requires an
exact match to the workflow_run list in merge-gate.yml (minus the anchor/gate).
Includes synthetic tests verifying that unregistered or missing workflows fail.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import yaml

from gate_constants import (
    ANCHOR_WORKFLOW_NAME,
    GATE_EXCLUDED_WORKFLOW_FILES,
    GATE_EXCLUDED_WORKFLOW_NAMES,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
MERGE_GATE_YML = WORKFLOWS_DIR / "merge-gate.yml"

# In paperclip, all pull_request workflows (PR, Docker Runner check, and label-gated
# Storybook Visual) are registered in merge-gate.yml. No default workflow omissions.
DEFAULT_IGNORED_WORKFLOWS: set[str] = set()


def get_gated_workflows_from_merge_gate(merge_gate_path: Path) -> set[str]:
    """Parse workflow_run.workflows from merge-gate.yml and subtract excluded anchor/gate workflows."""
    content = merge_gate_path.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    on = data.get("on")
    if on is None and True in data:
        on = data[True]

    if not isinstance(on, dict) or "workflow_run" not in on:
        raise ValueError(f"No workflow_run trigger found in {merge_gate_path}")

    wf_run = on["workflow_run"]
    workflows = wf_run.get("workflows", [])
    if not isinstance(workflows, list):
        raise ValueError(f"Expected list of workflows in workflow_run, got {type(workflows)}")

    gated = {w for w in workflows if w not in GATE_EXCLUDED_WORKFLOW_NAMES}
    return gated


def get_pull_request_workflows(
    workflows_dir: Path, ignored_workflows: set[str] | None = None
) -> set[str]:
    """Discover all workflows in directory that declare a pull_request trigger."""
    if ignored_workflows is None:
        ignored_workflows = DEFAULT_IGNORED_WORKFLOWS

    discovered: set[str] = set()

    for path in sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml")):
        if path.name in GATE_EXCLUDED_WORKFLOW_FILES:
            continue

        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as e:
            raise RuntimeError(f"Failed to parse {path}: {e}")

        if not isinstance(data, dict):
            continue

        on = data.get("on")
        if on is None and True in data:
            on = data[True]

        has_pr = False
        if isinstance(on, str) and on == "pull_request":
            has_pr = True
        elif isinstance(on, list) and "pull_request" in on:
            has_pr = True
        elif isinstance(on, dict) and "pull_request" in on:
            has_pr = True

        if has_pr:
            name = data.get("name") or path.stem
            if (
                name not in GATE_EXCLUDED_WORKFLOW_NAMES
                and name not in ignored_workflows
            ):
                discovered.add(name)

    return discovered


def verify_trigger_coverage(
    merge_gate_path: Path,
    workflows_dir: Path,
    ignored_workflows: set[str] | None = None,
) -> tuple[bool, str]:
    """Verify exact match between discovered PR workflows and gated workflows."""
    gated = get_gated_workflows_from_merge_gate(merge_gate_path)
    discovered = get_pull_request_workflows(workflows_dir, ignored_workflows)

    if gated == discovered:
        return True, f"Trigger coverage verified. Workflows: {sorted(gated)}"

    unregistered = discovered - gated
    extra_gated = gated - discovered
    msg = (
        f"Drift detected between PR workflows and merge-gate.yml!\n"
        f"Discovered PR workflows: {sorted(discovered)}\n"
        f"Gated workflows (minus anchor): {sorted(gated)}\n"
    )
    if unregistered:
        msg += f"Missing from merge-gate.yml: {sorted(unregistered)}\n"
    if extra_gated:
        msg += f"Extra in merge-gate.yml: {sorted(extra_gated)}\n"
    return False, msg


class TestTriggerCoverage(unittest.TestCase):
    def test_current_exact_set_passes(self):
        if not MERGE_GATE_YML.exists():
            self.skipTest(f"{MERGE_GATE_YML} does not exist yet.")
        ok, msg = verify_trigger_coverage(MERGE_GATE_YML, WORKFLOWS_DIR)
        self.assertTrue(ok, msg)

    def test_synthetic_unregistered_workflow_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            gate_yml = tmp_path / "merge-gate.yml"
            gate_yml.write_text(
                yaml.dump(
                    {
                        "name": "Merge Gate",
                        "on": {
                            "workflow_run": {
                                "workflows": [ANCHOR_WORKFLOW_NAME, "Real CI"],
                                "types": ["completed"],
                            }
                        },
                    }
                )
            )

            real_ci = tmp_path / "real-ci.yml"
            real_ci.write_text(
                yaml.dump({"name": "Real CI", "on": {"pull_request": None}})
            )

            ok, _ = verify_trigger_coverage(gate_yml, tmp_path, ignored_workflows=set())
            self.assertTrue(ok)

            synth_ci = tmp_path / "synthetic-ci.yml"
            synth_ci.write_text(
                yaml.dump({"name": "Synthetic Unregistered CI", "on": {"pull_request": None}})
            )

            ok, msg = verify_trigger_coverage(gate_yml, tmp_path, ignored_workflows=set())
            self.assertFalse(ok)
            self.assertIn("Synthetic Unregistered CI", msg)

    def test_synthetic_missing_workflow_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            gate_yml = tmp_path / "merge-gate.yml"
            gate_yml.write_text(
                yaml.dump(
                    {
                        "name": "Merge Gate",
                        "on": {
                            "workflow_run": {
                                "workflows": [ANCHOR_WORKFLOW_NAME, "Expected CI", "Missing CI"],
                                "types": ["completed"],
                            }
                        },
                    }
                )
            )

            expected_ci = tmp_path / "expected-ci.yml"
            expected_ci.write_text(
                yaml.dump({"name": "Expected CI", "on": {"pull_request": None}})
            )

            ok, msg = verify_trigger_coverage(gate_yml, tmp_path, ignored_workflows=set())
            self.assertFalse(ok)
            self.assertIn("Missing CI", msg)


if __name__ == "__main__":
    unittest.main()
