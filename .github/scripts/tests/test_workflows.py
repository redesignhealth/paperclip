"""Structural security tests for the auto-approval gate workflows (parsed YAML; nothing is executed)."""
import json
import re
import unittest
from pathlib import Path

import yaml

import _path  # noqa: F401
import gate_lib
from _path import REPO_ROOT

WF = REPO_ROOT / ".github" / "workflows"
SHA_PIN = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
REUSABLE_FILE = "auto-approve-job.yml"
# Pinned by the rh-pr-approval-gate role trust (rh-data-platform iam-argus-gate.tf, TECH-7014).
JOB_WORKFLOW_REF = f"redesignhealth/paperclip/.github/workflows/{REUSABLE_FILE}@refs/heads/master"


def load(name):
    data = yaml.safe_load((WF / name).read_text(encoding="utf-8"))
    data["on"] = data.pop(True, data.get("on"))  # YAML 1.1 parses a bare `on:` key as True
    return data


def steps(job):
    return job.get("steps", [])


def all_run_scripts(wf):
    return [s["run"] for job in wf["jobs"].values() for s in steps(job) if "run" in s]


def writes(perms):
    return {k for k, v in (perms or {}).items() if v == "write"}


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.wf = load("auto-approve.yml")

    def test_triggers_are_trusted_events_only(self):
        self.assertEqual(set(self.wf["on"]), {"workflow_run", "workflow_dispatch", "schedule"})
        self.assertEqual(self.wf["on"]["workflow_run"]["types"], ["completed"])
        self.assertEqual(list(self.wf["on"]["workflow_dispatch"]["inputs"]), ["pr_number"])
        self.assertEqual(self.wf["on"]["workflow_dispatch"]["inputs"]["pr_number"]["type"], "number")
        cron = self.wf["on"]["schedule"][0]["cron"]
        self.assertEqual(len(cron.split()), 5)

    def test_workflow_run_list_matches_the_canonical_ci_workflows(self):
        expected = {"PR", "Docker Runner check", "Gate Tests", "Storybook Visual"}
        self.assertEqual(set(self.wf["on"]["workflow_run"]["workflows"]), expected)
        self.assertNotIn(self.wf["name"], expected)

    def test_workflow_run_list_covers_every_workflow_that_declares_pull_request(self):
        # The wrapper's own documented contract (auto-approve.yml header): the workflow_run
        # list contains EVERY workflow that declares pull_request, so the completion of any
        # workflow the classifier can require wakes the gate immediately instead of waiting
        # for the 15-minute sweep.
        names = set()
        for f in WF.glob("*.yml"):
            wf = load(f.name)
            on = wf["on"]
            if (isinstance(on, dict) and "pull_request" in on) or on == "pull_request" \
                    or (isinstance(on, list) and "pull_request" in on):
                names.add(wf["name"])
        self.assertEqual(set(self.wf["on"]["workflow_run"]["workflows"]), names,
                         "a pull_request workflow is missing from the workflow_run wake list")

    def test_schedule_is_the_15_minute_revocation_sweep(self):
        # An Argus verdict is written outside GitHub, so only this cadence revokes an
        # already-green head when a newer BLOCKING round lands.
        self.assertEqual(self.wf["on"]["schedule"][0]["cron"], "*/15 * * * *")

    def test_no_default_permissions_and_minimal_job_permissions(self):
        self.assertEqual(self.wf["permissions"], {})
        self.assertEqual(self.wf["jobs"]["plan"]["permissions"], {"contents": "read", "pull-requests": "read", "checks": "read"})
        self.assertEqual(writes(self.wf["jobs"]["plan"]["permissions"]), set())
        self.assertEqual(writes(self.wf["jobs"]["approve"]["permissions"]), {"id-token"})

    def test_calls_only_the_local_reusable_with_a_number_and_one_secret(self):
        job = self.wf["jobs"]["approve"]
        self.assertEqual(job["uses"], f"./.github/workflows/{REUSABLE_FILE}")
        self.assertEqual(set(job["with"]), {"prNumber"})
        self.assertEqual(set(job["secrets"]), {"AWS_ROLE_ARN_PR_APPROVAL_GATE"})
        self.assertNotEqual(job.get("secrets"), "inherit")

    def test_every_job_refuses_other_refs_and_repos(self):
        cond = self.wf["jobs"]["plan"]["if"]
        for needle in ["refs/heads/master", "1326789272", "redesignhealth", "216950685"]:
            self.assertIn(needle, cond)

    def test_preflight_checks_exact_refs_repo_and_owner_id(self):
        plan_steps = self.wf["jobs"]["plan"]["steps"]
        preflight = next(s for s in plan_steps if "Require the default branch" in s.get("name", ""))
        self.assertIn("REPO_OWNER_ID", preflight["env"])
        self.assertIn("${{ github.repository_owner_id }}", preflight["env"]["REPO_OWNER_ID"])
        self.assertIn('[ "$REPO_OWNER_ID" = "216950685" ]', preflight["run"])

    def test_matrix_feeds_each_planned_pr_number_to_the_reusable_workflow(self):
        approve = self.wf["jobs"]["approve"]
        needs = [approve["needs"]] if isinstance(approve["needs"], str) else approve["needs"]
        self.assertEqual(needs, ["plan"])
        self.assertEqual(approve["strategy"]["fail-fast"], False)
        self.assertEqual(approve["strategy"]["matrix"]["pr"], "${{ fromJSON(needs.plan.outputs.prs) }}")
        self.assertEqual(approve["with"]["prNumber"], "${{ matrix.pr }}")

    def test_configuration_gate_honours_the_secret_fallback_and_the_app_id(self):
        plan = next(s for s in steps(self.wf["jobs"]["plan"]) if s.get("id") == "plan")
        has_config = plan["env"]["HAS_CONFIG"]
        self.assertIn("vars.AWS_ROLE_ARN_PR_APPROVAL_GATE", has_config)
        self.assertIn("secrets.AWS_ROLE_ARN_PR_APPROVAL_GATE", has_config)
        self.assertIn("vars.PR_APPROVAL_APP_ID", has_config)


class DelegationTests(unittest.TestCase):
    def test_caller_permissions_are_exactly_the_union_of_leaf_job_needs(self):
        caller = load("auto-approve.yml")["jobs"]["approve"]["permissions"]
        rank = {"read": 0, "write": 1}
        needed: dict[str, str] = {}
        for leaf in load(REUSABLE_FILE)["jobs"].values():
            for scope, level in (leaf.get("permissions") or {}).items():
                held = needed.get(scope)
                needed[scope] = level if held is None or rank[level] > rank[held] else held
        self.assertEqual(caller, needed)


class ReusableTests(unittest.TestCase):
    def setUp(self):
        self.wf = load(REUSABLE_FILE)

    def test_workflow_call_only_with_numeric_input(self):
        self.assertEqual(set(self.wf["on"]), {"workflow_call"})
        call = self.wf["on"]["workflow_call"]
        self.assertEqual(set(call["inputs"]), {"prNumber"})
        self.assertEqual(call["inputs"]["prNumber"]["type"], "number")
        self.assertTrue(call["inputs"]["prNumber"]["required"])
        self.assertEqual(set(call["secrets"]), {"AWS_ROLE_ARN_PR_APPROVAL_GATE"})

    def test_concurrency_group_serializes_per_pr_without_cancelling(self):
        c = self.wf["concurrency"]
        self.assertIn("inputs.prNumber", c["group"])
        self.assertFalse(c["cancel-in-progress"])

    def test_every_job_pins_the_default_branch_and_repo_id(self):
        for name, job in self.wf["jobs"].items():
            cond = job.get("if", "")
            for needle in ["refs/heads/master", "1326789272", "redesignhealth", "216950685"]:
                self.assertIn(needle, cond, f"{name}.if missing {needle}")

    def test_preflight_checks_exact_refs_repo_and_owner_id(self):
        for name, job in self.wf["jobs"].items():
            preflight = next(s for s in steps(job) if "Require the default branch" in s.get("name", ""))
            self.assertIn("REPO_OWNER_ID", preflight["env"])
            self.assertIn("${{ github.repository_owner_id }}", preflight["env"]["REPO_OWNER_ID"])
            self.assertIn('[ "$REPO_OWNER_ID" = "216950685" ]', preflight["run"])

    def test_every_action_is_pinned_to_a_full_commit_sha(self):
        for wf_name in ["auto-approve.yml", REUSABLE_FILE]:
            wf = load(wf_name)
            for jname, job in wf["jobs"].items():
                for step in steps(job):
                    uses = step.get("uses")
                    if uses and not uses.startswith("./"):
                        self.assertTrue(SHA_PIN.match(uses), f"{wf_name}:{jname}:{step.get('name')} not SHA-pinned: {uses}")

    def test_app_token_mint_scopes_only_this_repository_and_needed_permissions(self):
        gate = self.wf["jobs"]["gate"]
        app_step = next(s for s in steps(gate) if s.get("id") == "app")
        with_ = app_step["with"]
        self.assertEqual(with_["owner"], "redesignhealth")
        self.assertEqual(with_["repositories"], "paperclip")
        self.assertEqual(with_["permission-checks"], "write")
        self.assertEqual(with_["permission-pull-requests"], "write")
        extra_perms = [k for k in with_ if k.startswith("permission-") and k not in ("permission-checks", "permission-pull-requests")]
        self.assertEqual(extra_perms, [])

    def test_ssm_parameter_name_and_region_are_hardcoded(self):
        scripts = all_run_scripts(self.wf)
        ssm_script = next(s for s in scripts if "aws ssm get-parameter" in s)
        self.assertIn("/github-app/pr-approval-gate-private-key", ssm_script)
        self.assertIn("us-east-1", ssm_script)
        self.assertNotIn("${{", ssm_script)


class GateWorkflowHygieneTests(unittest.TestCase):
    """Fork PRs are evaluated from trusted metadata only: the privileged jobs never check out
    anything but the default-branch SHA, never cache/artifact fork content, and never
    interpolate PR-controlled text into a shell."""

    FILES = ["auto-approve.yml", REUSABLE_FILE]

    def test_checkouts_pin_the_default_branch_sha_and_drop_credentials(self):
        for f in self.FILES:
            for job in load(f)["jobs"].values():
                for step in steps(job):
                    if step.get("uses", "").startswith("actions/checkout@"):
                        with_patch = step.get("with", {})
                        self.assertEqual(with_patch.get("ref"), "${{ github.sha }}", f)
                        self.assertIs(with_patch.get("persist-credentials"), False, f)

    def test_no_fork_code_pr_text_or_secret_inheritance_reaches_the_gate_workflows(self):
        for f in self.FILES:
            text = (WF / f).read_text(encoding="utf-8")
            for banned in [
                "pull_request_target", "actions/cache", "download-artifact", "upload-artifact",
                "head_ref", "pull_request.title", "pull_request.body", "workflow_run.head_branch",
                "secrets: inherit",
            ]:
                self.assertNotIn(banned, text, f"{f}: {banned}")

    def test_guard_constants_match_the_iam_role_trust_contract(self):
        # org 216950685 / repo 1326789272 / master are the same facts the rh-pr-approval-gate
        # role trust (rh-data-platform iam-argus-gate.tf) pins in its immutable subject and
        # job_workflow_ref for this repository's credential job.
        self.assertEqual(
            (gate_lib.ORG_ID, gate_lib.REPO_ID, gate_lib.DEFAULT_BRANCH),
            (216950685, 1326789272, "master"),
        )


class GateTestsMirrorTests(unittest.TestCase):
    """The classifier must require gate-tests.yml exactly when gate-tests.yml's own paths
    filter would run it, so gate code can never change without the gate tests running."""

    def test_classifier_requirements_mirror_gate_tests_own_paths(self):
        import path_filter as pf

        on = load("gate-tests.yml")["on"]["pull_request"]
        regexes = [pf.github_glob_to_regex(g) for g in on["paths"]]
        # one representative changed file per declared glob, plus files that match nothing
        samples = {g[:-2] + "sample.py" if g.endswith("/**") else g for g in on["paths"]}
        samples |= {"README.md", "docs/x.md", "packages/server/x.ts", "ui/x.tsx",
                    "scripts/check-docker-deps-stage.mjs", "pnpm-lock.yaml", "tests/e2e/x.spec.ts"}
        for f in sorted(samples):
            with self.subTest(f=f):
                runs_here = any(rx.match(f.lstrip("/")) for rx in regexes)
                required = pf.required_workflows(WF, [f], 1)
                self.assertEqual(".github/workflows/gate-tests.yml" in required, runs_here,
                                 f"{f}: gate-tests must run exactly when its own paths match")

    def test_gate_files_require_the_gate_tests(self):
        import path_filter as pf

        for f in [
            ".github/scripts/gate_run.py",
            ".github/scripts/ci_aggregate.py",
            ".github/workflows/auto-approve.yml",
            ".github/rulesets/master-argus-review.json",
            "scripts/review-policy-machine-cutover.jq",
        ]:
            with self.subTest(f=f):
                self.assertIn(".github/workflows/gate-tests.yml", pf.required_workflows(WF, [f], 1))


class DependencyProvisioningTests(unittest.TestCase):
    """PyYAML is provisioned via a dedicated venv in both classify and gate jobs,
    BEFORE any AWS, SSM, or App token credentials are used."""

    def test_gate_job_installs_pyyaml_before_credentials_and_uses_venv_python(self):
        wf = load(REUSABLE_FILE)
        gate_steps = wf["jobs"]["gate"]["steps"]

        install_idx = next(i for i, s in enumerate(gate_steps) if s.get("name") == "Install pinned PyYAML (gate runner venv)")
        aws_idx = next(i for i, s in enumerate(gate_steps) if s.get("name") == "Assume the gate role (OIDC; trust pins master, this file and repository id)")
        ssm_idx = next(i for i, s in enumerate(gate_steps) if s.get("name") == "Read the App private key (fixed SSM name; never logged)")
        app_idx = next(i for i, s in enumerate(gate_steps) if s.get("name") == "Mint the App installation token (this repository, checks + pull requests write only)")
        publish_idx = next(i for i, s in enumerate(gate_steps) if s.get("name") == "Publish the argus-gate and ci-aggregate checks")

        self.assertLess(install_idx, aws_idx)
        self.assertLess(install_idx, ssm_idx)
        self.assertLess(install_idx, app_idx)

        install_run = gate_steps[install_idx]["run"]
        self.assertIn('pip" install --disable-pip-version-check "pyyaml==6.0.2"', install_run)

        publish_run = gate_steps[publish_idx]["run"]
        self.assertIn('"$RUNNER_TEMP/gate-venv/bin/python" .github/scripts/gate_run.py', publish_run)

    def test_classify_and_gate_jobs_use_consistent_pinned_pyyaml_version(self):
        wf = load(REUSABLE_FILE)
        classify_install = next(s["run"] for s in wf["jobs"]["classify"]["steps"] if "pyyaml==" in s.get("run", ""))
        gate_install = next(s["run"] for s in wf["jobs"]["gate"]["steps"] if "pyyaml==" in s.get("run", ""))
        self.assertIn("pyyaml==6.0.2", classify_install)
        self.assertIn("pyyaml==6.0.2", gate_install)

    def test_scoped_fresh_temp_venv_entrypoint_dependency_guard_and_run(self):
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            venv_dir = Path(td) / "test-venv"
            subprocess.run([sys.executable, "-m", "venv", str(venv_dir), "--clear"], check=True)
            venv_python = str(venv_dir / "bin" / "python")

            code = "import sys; sys.path.insert(0, '.github/scripts'); import gate_run"
            res = subprocess.run([venv_python, "-c", code], cwd=str(REPO_ROOT), capture_output=True, text=True)
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("yaml", res.stderr)

            pip_cmd = [str(venv_dir / "bin" / "pip"), "install", "--disable-pip-version-check", "pyyaml==6.0.2"]
            subprocess.run(pip_cmd, check=True, capture_output=True)

            fake_env = {
                "PR_NUMBER": "7",
                "EXPECTED_HEAD_SHA": "a" * 40,
                "REQUIRED_WORKFLOWS": "[]",
                "GITHUB_TOKEN": "mock-token",
                "APP_TOKEN": "mock-token",
            }
            run_cmd = [venv_python, ".github/scripts/gate_run.py"]
            run_res = subprocess.run(run_cmd, cwd=str(REPO_ROOT), env=fake_env, capture_output=True, text=True)
            self.assertNotIn("ModuleNotFoundError", run_res.stderr)
            self.assertNotIn("No module named 'yaml'", run_res.stderr)


if __name__ == "__main__":
    unittest.main()
