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

    def test_scoped_tests_step_runs_after_init_and_gated_on_skip(self):
        # Round-4 regression guard: the scoped unit/drift test step must run
        # AFTER "Initialize check runs" (id: init) completes -- not before PR
        # resolution -- and must be gated on steps.init.outputs.skip so it is
        # never executed (and never wastes runner time or risks acting on an
        # unresolved event) when the resolver legitimately skipped evaluation.
        names = [s.get("name") for s in self.steps]
        init_idx = names.index("Initialize check runs")
        tests_idx = names.index("Run scoped merge-gate unit and drift tests")
        self.assertGreater(
            tests_idx,
            init_idx,
            "'Run scoped merge-gate unit and drift tests' must run after "
            "'Initialize check runs', not before PR resolution.",
        )
        tests_step = self.steps[tests_idx]
        self.assertEqual(tests_step.get("if"), "steps.init.outputs.skip != 'true'")

    def test_bootstrap_check_run_failure_guard_structure(self):
        # Round-4 guard: when the job fails before either check run was ever
        # created (e.g. resolver/init itself failed), the fail-closed
        # concluder must bootstrap terminal FAILURE check runs instead of
        # silently leaving the PR with no gate checks at all (a fail-open
        # hole). This must never fire on a legitimate skip, and must only
        # ever post against a strictly-validated 40-hex commit SHA.
        step = self._step_named("Conclude checks fail-closed on failure")
        self.assertEqual(step.get("if"), "always()")

        env = step.get("env") or {}
        self.assertEqual(env.get("RESOLVE_OUTCOME"), "${{ steps.resolve.outcome }}")
        self.assertEqual(env.get("INIT_OUTCOME"), "${{ steps.init.outcome }}")
        self.assertEqual(env.get("INIT_SKIP"), "${{ steps.init.outputs.skip }}")
        self.assertEqual(env.get("EVENT_NAME"), "${{ github.event_name }}")
        self.assertIn("workflow_run", str(env.get("EVENT_HEAD_SHA")))

        script = step["with"]["script"]
        for marker in (
            "process.env.RESOLVE_OUTCOME",
            "process.env.INIT_OUTCOME",
            "process.env.INIT_SKIP",
            "process.env.EVENT_NAME",
            "process.env.EVENT_HEAD_SHA",
        ):
            self.assertIn(marker, script, f"Missing {marker!r} in bootstrap script")

        # Only attempts bootstrap when EITHER check ID is absent (independent creation).
        self.assertIn("!ciCheckId || !argusCheckId", script)
        # Treats init failure or cancelled as eligible bootstrap outcome
        self.assertIn("process.env.INIT_OUTCOME === 'cancelled'", script)
        # Never bootstraps on a legitimate resolver skip.
        self.assertIn("legitimatelySkipped", script)
        self.assertIn("INIT_SKIP", script)
        # Strict 40-hex validation gates every bootstrap check-run creation.
        self.assertIn("/^[0-9a-fA-F]{40}$/", script)
        # Bootstraps absent check runs as terminal failures independently.
        self.assertIn("BOOTSTRAP_FAILURE", script)
        self.assertIn("name: 'ci-aggregate'", script)
        self.assertIn("name: 'argus-gate'", script)

    def test_init_step_validation_failed_persists_checks(self):
        # Round-5 guard: when workflow_dispatch validation fails, check IDs must be
        # persisted to /tmp/merge_gate_checks.json and step outputs so fail-closed concluder
        # does not duplicate check runs and final verification is accurate.
        step = self._step_named("Initialize check runs")
        script = step["with"]["script"]
        self.assertIn("res.validation_failed", script)
        self.assertIn("checkState.ci_check_id = ciCheck.data.id", script)
        self.assertIn("checkState.argus_check_id = argusCheck.data.id", script)
        self.assertIn(
            "fs.writeFileSync('/tmp/merge_gate_checks.json', JSON.stringify(checkState))",
            script,
        )

    def test_init_step_validation_failed_persists_checks_incrementally(self):
        # Closes a residual gap in test_init_step_validation_failed_persists_checks
        # above: that test only confirms the writeFileSync marker is PRESENT, not
        # that it fires once per check creation. Within the validation_failed
        # branch, persistence must happen incrementally -- immediately after EACH
        # check run is created -- not via a single combined write at the end of
        # the block. This is what lets a partial failure survive: if the
        # ci-aggregate check is created successfully but the subsequent
        # argus-gate creation then throws, the ci_check_id must already be on
        # disk so the fail-closed concluder's one-ID-only bootstrap later only
        # needs to create the ONE check that is actually missing, instead of
        # duplicating the one that already exists.
        step = self._step_named("Initialize check runs")
        script = step["with"]["script"]
        start = script.index("if (res.validation_failed)")
        end = script.index("catch (checkErr)")
        self.assertGreater(end, start)
        block = script[start:end]

        write_marker = (
            "fs.writeFileSync('/tmp/merge_gate_checks.json', "
            "JSON.stringify(checkState));"
        )
        self.assertEqual(
            block.count(write_marker),
            2,
            "validation_failed branch must persist check state once per "
            "check creation (incrementally), not via a single combined "
            "write -- otherwise a partial failure loses the already-"
            "created check's id.",
        )

        ci_assign_idx = block.index("checkState.ci_check_id = ciCheck.data.id")
        argus_assign_idx = block.index("checkState.argus_check_id = argusCheck.data.id")
        self.assertLess(ci_assign_idx, argus_assign_idx)

        first_write_idx = block.index(write_marker)
        second_write_idx = block.index(write_marker, first_write_idx + 1)

        # The first write must land between the ci assignment and the argus
        # assignment, proving ci_check_id reaches disk BEFORE the argus check
        # creation (which could throw) is even attempted.
        self.assertTrue(ci_assign_idx < first_write_idx < argus_assign_idx)
        # The second write must land after the argus assignment.
        self.assertGreater(second_write_idx, argus_assign_idx)

    def test_bootstrap_independent_per_check_creation(self):
        # Guard: the two bootstrap branches inside the fail-closed concluder
        # must be gated INDEPENDENTLY on their own missing check id
        # (`if (!ciCheckId)` / `if (!argusCheckId)`), not combined into a
        # single all-or-nothing branch that always (re-)creates both. This is
        # what makes one-ID-only bootstrap possible: when only ONE of the two
        # checks failed to get created upstream, only that ONE check gets
        # bootstrapped here, while the other already-persisted check id is
        # left completely untouched rather than being duplicated.
        step = self._step_named("Conclude checks fail-closed on failure")
        script = step["with"]["script"]

        ci_guard_idx = script.index("if (!ciCheckId) {")
        argus_guard_idx = script.index("if (!argusCheckId) {")
        self.assertGreater(argus_guard_idx, ci_guard_idx)

        # Each independent branch creates exactly its own named check run,
        # never the other one.
        ci_branch = script[ci_guard_idx:argus_guard_idx]
        argus_branch = script[argus_guard_idx:]
        self.assertIn("name: 'ci-aggregate'", ci_branch)
        self.assertNotIn("name: 'argus-gate'", ci_branch)
        self.assertIn("name: 'argus-gate'", argus_branch)
        self.assertNotIn("name: 'ci-aggregate'", argus_branch)

        # Both independent branches mark their own bootstrap as a terminal
        # failure (two occurrences total: one per branch).
        self.assertEqual(script.count("BOOTSTRAP_FAILURE"), 2)

    def test_final_gate_check_conclusions_fail_closed_structure(self):
        # Guard: "Verify final gate check conclusions" is the one and only
        # step that independently re-reads BOTH check runs via the REST API
        # (rather than trusting any earlier step's local JSON) and fails the
        # enclosing job if either is missing or did not conclude with
        # status=='completed' AND conclusion=='success'. Without this final
        # feedback step, a check run left stuck in_progress, or concluded
        # neutral/cancelled by a race with the "Conclude ... check" steps,
        # would never fail the "Evaluate Merge Gate" job itself.
        step = self._step_named("Verify final gate check conclusions")
        self.assertEqual(
            step.get("if"), "always() && steps.init.outputs.skip != 'true'"
        )

        script = step["with"]["script"]
        # Falls back to the persisted check-state file when live step
        # outputs are unavailable (e.g. the job failed earlier and outputs
        # never got threaded through to this step).
        self.assertIn("savedChecks.ci_check_id", script)
        self.assertIn("savedChecks.argus_check_id", script)

        # A missing check id is treated as an explicit failure, never
        # silently skipped over.
        self.assertIn("if (!id)", script)
        self.assertIn("allSucceeded = false", script)

        # Both status AND conclusion are required: a merely-'completed'
        # check with a non-'success' conclusion must still fail closed.
        self.assertIn(
            "check.data.status !== 'completed' || "
            "check.data.conclusion !== 'success'",
            script,
        )
        self.assertIn('core.setFailed("One or more required Merge Gate checks', script)

    def test_argus_verdict_evaluator_crash_fallback_structure(self):
        # Round-4 guard: argus_verdict.py is invoked under `set -euo pipefail`;
        # a nonzero exit must never silently abort the step (which would skip
        # "Conclude Argus check" and leave the argus-gate check incomplete).
        # Crash output must be validated as real JSON before being trusted,
        # and a genuine crash must fall back to a fail-closed EVALUATOR_CRASH
        # verdict rather than propagating raw evaluator stdout/stderr.
        step = self._step_named("Evaluate Argus approval verdict")
        run = step["run"]
        self.assertIn("argus_verdict.py", run)
        # stderr captured separately from the evaluator's stdout.
        self.assertIn("argus_stderr.log", run)
        # Raw output is validated as legitimate JSON before being trusted.
        self.assertIn("json.load(sys.stdin)", run)
        # Fail-closed fallback reason code and verdict shape.
        self.assertIn("EVALUATOR_CRASH", run)
        self.assertIn('"passed": false', run)
        # The crash-handling block must never let the step hard-fail (so
        # downstream "Conclude Argus check" still runs and reads the
        # fallback JSON written to /tmp/argus_verdict.json).
        self.assertIn("exit 0", run)
        self.assertIn("mv /tmp/argus_verdict.raw /tmp/argus_verdict.json", run)

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
