#!/usr/bin/env python3
"""Drift test: verifies that Merge Gate triggers cover every PR workflow (TECH-7014).

Parses default-branch workflows declaring pull_request triggers and requires an
exact match to the workflow_run list in merge-gate.yml (minus the anchor/gate).
Validates that all configured LABEL_GATED_WORKFLOWS exist, match configured names,
and are registered in the gate workflow.
Includes synthetic tests verifying that unregistered or missing workflows fail.
Also directly exercises each of validate_label_gated_workflows' three distinct
failure branches (missing file, workflow-name mismatch, not registered in the
gate's workflow_run.workflows list) rather than only its happy path.
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
        self.assertTrue(
            MERGE_GATE_YML.is_file(),
            f"Missing required {MERGE_GATE_YML}. Fail closed.",
        )
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


class TestValidateLabelGatedWorkflows(unittest.TestCase):
    """Directly exercises each distinct failure branch of validate_label_gated_workflows."""

    def _write_gate(self, tmp_path: Path, workflows: list[str]) -> Path:
        gate_yml = tmp_path / "merge-gate.yml"
        gate_yml.write_text(
            yaml.dump(
                {
                    "name": "Merge Gate",
                    "on": {
                        "workflow_run": {
                            "workflows": workflows,
                            "types": ["completed"],
                        }
                    },
                }
            )
        )
        return gate_yml

    def test_missing_label_gated_file_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            gate_yml = self._write_gate(
                tmp_path, [ANCHOR_WORKFLOW_NAME, "Storybook Visual"]
            )
            # storybook-visual.yml is intentionally never created.
            ok, msg = validate_label_gated_workflows(tmp_path, gate_yml)
            self.assertFalse(ok)
            self.assertIn("not found in", msg)
            self.assertIn("storybook-visual.yml", msg)

    def test_label_gated_name_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            gate_yml = self._write_gate(
                tmp_path, [ANCHOR_WORKFLOW_NAME, "Storybook Visual"]
            )
            sb = tmp_path / "storybook-visual.yml"
            sb.write_text(
                yaml.dump(
                    {"name": "Totally Different Name", "on": {"pull_request": None}}
                )
            )
            ok, msg = validate_label_gated_workflows(tmp_path, gate_yml)
            self.assertFalse(ok)
            self.assertIn("declares name 'Totally Different Name'", msg)
            self.assertIn("expected 'Storybook Visual'", msg)

    def test_label_gated_not_registered_in_gate_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            # Gate workflow_run.workflows omits "Storybook Visual" entirely.
            gate_yml = self._write_gate(tmp_path, [ANCHOR_WORKFLOW_NAME, "Real CI"])
            sb = tmp_path / "storybook-visual.yml"
            sb.write_text(
                yaml.dump({"name": "Storybook Visual", "on": {"pull_request": None}})
            )
            ok, msg = validate_label_gated_workflows(tmp_path, gate_yml)
            self.assertFalse(ok)
            self.assertIn("is not registered", msg)
            self.assertIn("Storybook Visual", msg)

    def test_label_gated_valid_passes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            gate_yml = self._write_gate(
                tmp_path, [ANCHOR_WORKFLOW_NAME, "Storybook Visual"]
            )
            sb = tmp_path / "storybook-visual.yml"
            sb.write_text(
                yaml.dump({"name": "Storybook Visual", "on": {"pull_request": None}})
            )
            ok, msg = validate_label_gated_workflows(tmp_path, gate_yml)
            self.assertTrue(ok, msg)


class TestMergeGateYamlStructure(unittest.TestCase):
    """Structural assertions over the real merge-gate.yml (round-3 remediation).

    These guard specific hardening fixes that no behavioral/unit test can see,
    since they are properties of the workflow YAML itself rather than of any
    Python script: credential persistence on checkout, and sourcing check IDs
    via `env:` + `process.env.*` instead of interpolating `${{ }}` expressions
    directly into embedded github-script bodies (script-injection hardening).
    """

    CHECK_ID_SCRIPT_STEPS = (
        "Conclude CI aggregate check",
        "Conclude Argus check",
        "Conclude checks fail-closed on failure",
        "Verify final gate check conclusions",
    )

    def setUp(self):
        self.assertTrue(
            MERGE_GATE_YML.is_file(),
            f"Missing required {MERGE_GATE_YML}. Fail closed.",
        )
        data = yaml.safe_load(MERGE_GATE_YML.read_text(encoding="utf-8"))
        self.steps = data["jobs"]["gate"]["steps"]

    def _step_named(self, name: str) -> dict:
        for step in self.steps:
            if step.get("name") == name:
                return step
        raise AssertionError(f"No step named {name!r} found in {MERGE_GATE_YML}")

    def test_checkout_persist_credentials_false(self):
        step = self._step_named("Sparse checkout trusted scripts & workflows")
        self.assertTrue(str(step.get("uses", "")).startswith("actions/checkout@"))
        self.assertIs(step["with"]["persist-credentials"], False)

    def test_sparse_checkout_covers_test_inputs(self):
        step = self._step_named("Sparse checkout trusted scripts & workflows")
        sparse_paths = step["with"]["sparse-checkout"].strip().split()
        for req in [".github/scripts", ".github/workflows", ".github/CODEOWNERS"]:
            self.assertIn(
                req,
                sparse_paths,
                f"Sparse checkout missing required test input: {req}",
            )

    def test_pr_trusted_merge_gate_scripts_job(self):
        pr_trusted_path = WORKFLOWS_DIR / "pr-trusted.yml"
        self.assertTrue(pr_trusted_path.is_file(), f"{pr_trusted_path} does not exist.")
        data = yaml.safe_load(pr_trusted_path.read_text(encoding="utf-8"))

        # No pull_request trigger on reusable workflow (classifier invisible)
        on = data.get("on")
        if on is None and True in data:
            on = data[True]
        self.assertNotIn(
            "pull_request",
            on if isinstance(on, (dict, list)) else [on],
            "pr-trusted.yml must not declare a pull_request trigger (reusable workflow only)",
        )

        # Job exists
        jobs = data.get("jobs", {})
        self.assertIn(
            "merge_gate_scripts", jobs, "pr-trusted.yml missing merge_gate_scripts job"
        )
        job = jobs["merge_gate_scripts"]

        # Needs gate
        needs = job.get("needs")
        self.assertTrue(
            needs == "gate" or (isinstance(needs, list) and "gate" in needs),
            f"merge_gate_scripts must depend on gate, got needs={needs!r}",
        )

        # No full_ci guard
        if_cond = str(job.get("if", ""))
        self.assertNotIn(
            "full_ci",
            if_cond,
            f"merge_gate_scripts must not have full_ci guard, got if={if_cond!r}",
        )

        # Runs all five scripts
        steps = job.get("steps", [])
        step_runs = "\n".join(str(s.get("run", "")) for s in steps)
        for script in [
            "pr_resolve_test.py",
            "path_filter_test.py",
            "ci_aggregate_test.py",
            "argus_verdict_test.py",
            "trigger_coverage_test.py",
        ]:
            self.assertIn(
                script, step_runs, f"merge_gate_scripts does not execute {script}"
            )

    def test_sha_preserving_anchor_type_invariant(self):
        """Anchor must handle SHA-preserving PR event types without requiring them on Storybook Visual."""
        anchor_path = WORKFLOWS_DIR / "merge-gate-trigger.yml"
        self.assertTrue(
            anchor_path.is_file(), f"{anchor_path} does not exist. Fail closed."
        )
        anchor_data = yaml.safe_load(anchor_path.read_text(encoding="utf-8"))
        anchor_on = anchor_data.get("on")
        if anchor_on is None and True in anchor_data:
            anchor_on = anchor_data[True]
        anchor_pr_types = set((anchor_on.get("pull_request") or {}).get("types", []))

        # Anchor MUST cover SHA-preserving events
        for evt in {"ready_for_review", "labeled", "unlabeled"}:
            self.assertIn(
                evt,
                anchor_pr_types,
                f"Anchor trigger missing SHA-preserving event {evt!r}",
            )

        # Storybook Visual triggers on code-modifying events (opened, synchronize, reopened)
        # and does NOT require ready_for_review because anchor re-evaluates the SHA's existing runs.
        sb_path = WORKFLOWS_DIR / "storybook-visual.yml"
        self.assertTrue(sb_path.is_file(), f"{sb_path} does not exist. Fail closed.")
        sb_data = yaml.safe_load(sb_path.read_text(encoding="utf-8"))
        sb_on = sb_data.get("on")
        if sb_on is None and True in sb_data:
            sb_on = sb_data[True]
        sb_pr_types = set((sb_on.get("pull_request") or {}).get("types", []))
        self.assertTrue({"opened", "synchronize", "reopened"}.issubset(sb_pr_types))
        self.assertNotIn(
            "ready_for_review",
            sb_pr_types,
            "Storybook Visual should not add ready_for_review; anchor guarantees gate invocation on ready_for_review.",
        )

    def test_check_id_steps_source_ids_via_env_not_inline_expression(self):
        for name in self.CHECK_ID_SCRIPT_STEPS:
            with self.subTest(step=name):
                step = self._step_named(name)
                script = step["with"]["script"]
                env = step.get("env") or {}

                # Every *_CHECK_ID referenced by the script must be declared
                # in the step's env block (sourced from the step output there).
                check_id_env_keys = [k for k in env if k.endswith("CHECK_ID")]
                self.assertTrue(
                    check_id_env_keys,
                    f"Step {name!r} has no *_CHECK_ID env entry: {env!r}",
                )
                for key in check_id_env_keys:
                    self.assertIn(
                        "steps.init.outputs.",
                        str(env[key]),
                        f"Step {name!r} env[{key!r}] does not source steps.init.outputs",
                    )
                    # Script must read it back via process.env, never by
                    # re-embedding the raw step-output expression inline.
                    self.assertIn(f"process.env.{key}", script)

                # The raw expression must never be interpolated directly into
                # the script body itself (only ever live in the env: block).
                self.assertNotIn("steps.init.outputs.ci_check_id", script)
                self.assertNotIn("steps.init.outputs.argus_check_id", script)

    def test_codeowners_covers_argus_directory(self):
        codeowners_path = REPO_ROOT / ".github" / "CODEOWNERS"
        self.assertTrue(codeowners_path.is_file(), f"{codeowners_path} not found")
        argus_lines = [
            line
            for line in codeowners_path.read_text(encoding="utf-8").splitlines()
            if line.split("#", 1)[0].split()
            and line.split("#", 1)[0].split()[0] == ".argus/**"
        ]
        self.assertTrue(
            argus_lines, "CODEOWNERS has no ownership entry for '.argus/**'"
        )
        expected_owners = {
            "@cryppadotta",
            "@devinfoley",
            "@nickyleach",
            "@forgottendev",
        }
        for line in argus_lines:
            owners = set(line.split("#", 1)[0].split()[1:])
            self.assertEqual(
                owners,
                expected_owners,
                f"CODEOWNERS '.argus/**' owners mismatch: got {owners}, expected {expected_owners}",
            )


if __name__ == "__main__":
    unittest.main()
