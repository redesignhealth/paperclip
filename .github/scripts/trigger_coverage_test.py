#!/usr/bin/env python3
"""Drift test: verifies that Merge Gate triggers cover every PR workflow (TECH-7014).

Parses default-branch workflows declaring pull_request triggers and requires an
exact match to the workflow_run list in merge-gate.yml (minus the anchor/gate).
Validates that all configured LABEL_GATED_WORKFLOWS exist, match configured names,
and are registered in the gate workflow.
Includes synthetic tests verifying that unregistered or missing workflows fail.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from gate_constants import (  # noqa: E402
    ANCHOR_WORKFLOW_NAME,
    GATE_EXCLUDED_WORKFLOW_FILES,
    GATE_EXCLUDED_WORKFLOW_NAMES,
    LABEL_GATED_WORKFLOWS,
)

REPO_ROOT = SCRIPT_DIR.parents[1]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
MERGE_GATE_YML = WORKFLOWS_DIR / "merge-gate.yml"

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
        raise ValueError(
            f"Expected list of workflows in workflow_run, got {type(workflows)}"
        )

    gated = {w for w in workflows if w not in GATE_EXCLUDED_WORKFLOW_NAMES}
    return gated


def validate_label_gated_workflows(
    workflows_dir: Path, merge_gate_path: Path
) -> tuple[bool, str]:
    """Validate that every workflow in LABEL_GATED_WORKFLOWS exists and is registered (Requirement 12)."""
    content = merge_gate_path.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    on = data.get("on")
    if on is None and True in data:
        on = data[True]
    gated_list = (on or {}).get("workflow_run", {}).get("workflows", [])

    for expected_name, cfg in LABEL_GATED_WORKFLOWS.items():
        file_path = workflows_dir / cfg["file"]
        if not file_path.is_file():
            return (
                False,
                f"Label-gated workflow file '{cfg['file']}' not found in {workflows_dir}",
            )

        wf_data = yaml.safe_load(file_path.read_text(encoding="utf-8"))
        actual_name = wf_data.get("name") or file_path.stem
        if actual_name != expected_name:
            return (
                False,
                f"Workflow '{cfg['file']}' declares name '{actual_name}', expected '{expected_name}'",
            )

        if expected_name not in gated_list:
            return (
                False,
                f"Label-gated workflow '{expected_name}' is not registered in {merge_gate_path.name} workflow_run.workflows",
            )

    return True, "All label-gated workflows validated successfully."


def get_pull_request_workflows(
    workflows_dir: Path, ignored_workflows: set[str] | None = None
) -> set[str]:
    """Discover all workflows in directory that declare a pull_request trigger."""
    if ignored_workflows is None:
        ignored_workflows = DEFAULT_IGNORED_WORKFLOWS

    # Symmetrically resolve excluded names from excluded files (Requirement 12)
    effective_excluded_names = set(GATE_EXCLUDED_WORKFLOW_NAMES)
    effective_excluded_files = set(GATE_EXCLUDED_WORKFLOW_FILES)

    for path in sorted(workflows_dir.glob("*.yml")) + sorted(
        workflows_dir.glob("*.yaml")
    ):
        if path.name in effective_excluded_files:
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("name"):
                    effective_excluded_names.add(data["name"])
            except Exception:
                pass

    discovered: set[str] = set()

    for path in sorted(workflows_dir.glob("*.yml")) + sorted(
        workflows_dir.glob("*.yaml")
    ):
        if path.name in effective_excluded_files:
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
            if name not in effective_excluded_names and name not in ignored_workflows:
                discovered.add(name)

    return discovered


def verify_trigger_coverage(
    merge_gate_path: Path,
    workflows_dir: Path,
    ignored_workflows: set[str] | None = None,
) -> tuple[bool, str]:
    """Verify exact match between discovered PR workflows and gated workflows."""
    # 1. Validate label-gated workflows registration (Requirement 12)
    ok_label, msg_label = validate_label_gated_workflows(workflows_dir, merge_gate_path)
    if not ok_label:
        return False, msg_label

    # 2. Verify trigger coverage
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

            # Create mock storybook-visual.yml to satisfy label-gated validation if testing tmpdir
            sb = tmp_path / "storybook-visual.yml"
            sb.write_text(
                yaml.dump({"name": "Storybook Visual", "on": {"pull_request": None}})
            )
            # Add Storybook Visual to gate
            gate_yml.write_text(
                yaml.dump(
                    {
                        "name": "Merge Gate",
                        "on": {
                            "workflow_run": {
                                "workflows": [
                                    ANCHOR_WORKFLOW_NAME,
                                    "Real CI",
                                    "Storybook Visual",
                                ],
                                "types": ["completed"],
                            }
                        },
                    }
                )
            )

            ok, _ = verify_trigger_coverage(gate_yml, tmp_path, ignored_workflows=set())
            self.assertTrue(ok)

            synth_ci = tmp_path / "synthetic-ci.yml"
            synth_ci.write_text(
                yaml.dump(
                    {"name": "Synthetic Unregistered CI", "on": {"pull_request": None}}
                )
            )

            ok, msg = verify_trigger_coverage(
                gate_yml, tmp_path, ignored_workflows=set()
            )
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
                                "workflows": [
                                    ANCHOR_WORKFLOW_NAME,
                                    "Expected CI",
                                    "Missing CI",
                                    "Storybook Visual",
                                ],
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

            sb = tmp_path / "storybook-visual.yml"
            sb.write_text(
                yaml.dump({"name": "Storybook Visual", "on": {"pull_request": None}})
            )

            ok, msg = verify_trigger_coverage(
                gate_yml, tmp_path, ignored_workflows=set()
            )
            self.assertFalse(ok)
            self.assertIn("Missing CI", msg)


if __name__ == "__main__":
    unittest.main()
