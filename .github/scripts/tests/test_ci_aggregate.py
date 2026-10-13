import base64
import unittest

import _path  # noqa: F401
import ci_aggregate as ci
import gate_lib
from gate_lib import GateError
from fakes import SHA, SHA2, FakeGitHub

PR_WF = ".github/workflows/pr.yml"
DOCKER_WF = ".github/workflows/docker-runner-check.yml"
SB_WF = ".github/workflows/storybook-visual.yml"


def default_referenced_workflows():
    return [
        {
            "path": "paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/master",
            "ref": "refs/heads/master",
            "sha": SHA,
        },
        {
            "path": "paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master",
            "ref": "refs/heads/master",
            "sha": SHA,
        },
    ]


def run(
    path=PR_WF,
    rid=1,
    number=1,
    attempt=1,
    status="completed",
    conclusion="success",
    sha=SHA,
    event="pull_request",
    repo_id=gate_lib.REPO_ID,
    head_repo_id=gate_lib.REPO_ID,
    referenced_workflows="default",
):
    if referenced_workflows == "default":
        referenced_workflows = default_referenced_workflows() if path == PR_WF else None
    return {
        "id": rid,
        "run_number": number,
        "run_attempt": attempt,
        "status": status,
        "conclusion": conclusion,
        "head_sha": sha,
        "event": event,
        "path": path,
        "repository": {"id": repo_id},
        "head_repository": {"id": head_repo_id},
        "referenced_workflows": referenced_workflows,
    }


def job(name, conclusion="success", status="completed"):
    return {"name": name, "status": status, "conclusion": conclusion}


def default_pr_jobs():
    return [
        job("ci / gate / Select trusted runner"),
        job("ci / policy"),
        job("ci / verify"),
        job("ci / e2e"),
    ]


def evaluate(required, runs, jobs=None, pr_head_repo_id=gate_lib.REPO_ID, pr_labels=None):
    latest = ci.latest_runs(runs, SHA, pr_head_repo_id)
    default = {r["id"]: default_pr_jobs() for r in runs}
    table = {**default, **(jobs or {})}
    return ci.evaluate(required, latest, lambda rid: table[rid], pr_labels=pr_labels)


def _definition(uses):
    return (
        "name: PR\n"
        "on: pull_request\n"
        "jobs:\n"
        "  ci:\n"
        f"    uses: {uses}\n"
    )


# The approved outer CI definition is EXACTLY: the `ci` job of .github/workflows/pr.yml calling
# paperclipai/paperclip/.github/workflows/pr-trusted.yml at master / refs/heads/master.
# Anything else -- a local replacement, ci-routing as outer, arbitrary SHAs, another repo, another ref form -- is untrusted.
DENIED_DEFINITIONS = {
    "ci job replaced with local steps (no uses)": (
        "name: PR\n"
        "on: pull_request\n"
        "jobs:\n"
        "  ci:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps: [{run: echo pwn}]\n"
    ),
    "root-local reusable workflow (the fork's own copy)": _definition("./.github/workflows/pr-trusted.yml"),
    "unapproved repo with the ci-routing path": _definition("attacker/paperclip/.github/workflows/ci-routing.yml@master"),
    "ci-routing as outer workflow": _definition("paperclipai/paperclip/.github/workflows/ci-routing.yml@master"),
    "ci-routing with refs/heads/master as outer workflow": _definition("paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master"),
    "ci-routing with SHA as outer workflow": _definition(f"paperclipai/paperclip/.github/workflows/ci-routing.yml@{SHA}"),
    "full SHA ref in outer definition": _definition(f"paperclipai/paperclip/.github/workflows/pr-trusted.yml@{SHA}"),
    "full SHA ref but an unapproved repo": _definition(f"attacker/paperclip/.github/workflows/pr-trusted.yml@{SHA}"),
    "different branch ref": _definition("paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/main"),
    "tag ref": _definition("paperclipai/paperclip/.github/workflows/pr-trusted.yml@v1"),
    "fully-qualified tag ref": _definition("paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/tags/v1"),
    "short SHA ref": _definition("paperclipai/paperclip/.github/workflows/pr-trusted.yml@abcdef1"),
    "uppercase SHA ref": _definition(f"paperclipai/paperclip/.github/workflows/pr-trusted.yml@{SHA.upper()}"),
    "case-modified ref": _definition("paperclipai/paperclip/.github/workflows/pr-trusted.yml@Master"),
    "unparseable yaml": "jobs: [unbalanced\n",
    "jobs is not a mapping": "name: PR\non: pull_request\njobs: []\n",
    "ci job is not a mapping": "name: PR\non: pull_request\njobs:\n  ci: echo\n",
}


class ProvenanceTests(unittest.TestCase):
    def test_trusted_definitions_pass(self):
        for uses in [
            "paperclipai/paperclip/.github/workflows/pr-trusted.yml@master",
            "paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/master",
        ]:
            with self.subTest(uses=uses):
                ci.validate_ci_definition(_definition(uses))

    def test_the_approved_definition_is_exact_no_broader_form_passes(self):
        for label, text in DENIED_DEFINITIONS.items():
            with self.subTest(label=label):
                with self.assertRaises(GateError) as ctx:
                    ci.validate_ci_definition(text)
                self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")


class ReferencedWorkflowsTests(unittest.TestCase):
    def test_valid_exact_two_referenced_workflows_pass(self):
        r = run(PR_WF, 1)
        valid, err, shas = ci.validate_run_referenced_workflows(r)
        self.assertTrue(valid)
        self.assertIsNone(err)
        self.assertEqual(len(shas), 2)
        self.assertEqual(shas["paperclipai/paperclip/.github/workflows/pr-trusted.yml"], SHA)
        self.assertEqual(shas["paperclipai/paperclip/.github/workflows/ci-routing.yml"], SHA)

    def test_missing_referenced_workflows_fails(self):
        r = run(PR_WF, 1, referenced_workflows=None)
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("missing", err)

    def test_empty_referenced_workflows_fails(self):
        r = run(PR_WF, 1, referenced_workflows=[])
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("missing", err)

    def test_single_referenced_workflow_fails(self):
        # Missing ci-routing.yml
        r = run(PR_WF, 1, referenced_workflows=[
            {"path": "paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/master", "ref": "refs/heads/master", "sha": SHA}
        ])
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("expected exactly 2", err)

    def test_extra_referenced_workflow_fails(self):
        extra = default_referenced_workflows() + [
            {"path": "attacker/paperclip/.github/workflows/evil.yml@refs/heads/master", "ref": "refs/heads/master", "sha": SHA}
        ]
        r = run(PR_WF, 1, referenced_workflows=extra)
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("expected exactly 2", err)

    def test_wrong_ref_in_referenced_workflows_fails(self):
        bad_ref = [
            {"path": "paperclipai/paperclip/.github/workflows/pr-trusted.yml@refs/heads/feature", "ref": "refs/heads/feature", "sha": SHA},
            {"path": "paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master", "ref": "refs/heads/master", "sha": SHA},
        ]
        r = run(PR_WF, 1, referenced_workflows=bad_ref)
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("untrusted referenced workflow ref", err)

    def test_wrong_path_in_referenced_workflows_fails(self):
        bad_path = [
            {"path": "attacker/paperclip/.github/workflows/pr-trusted.yml@refs/heads/master", "ref": "refs/heads/master", "sha": SHA},
            {"path": "paperclipai/paperclip/.github/workflows/ci-routing.yml@refs/heads/master", "ref": "refs/heads/master", "sha": SHA},
        ]
        r = run(PR_WF, 1, referenced_workflows=bad_path)
        valid, err, _ = ci.validate_run_referenced_workflows(r)
        self.assertFalse(valid)
        self.assertIn("untrusted referenced workflow path", err)


class LatestRunTests(unittest.TestCase):
    def test_filters_sha_event_repo_and_head_repo(self):
        runs = [
            run(sha=SHA2),  # wrong sha
            run(event="push", rid=2),  # wrong event
            run(repo_id=5, rid=3),  # wrong base repo
            run(head_repo_id=999, rid=4),  # wrong head repo (negative test: run wrong head repo)
            run(path="dynamic/x", rid=5),  # not a workflow path
            run(rid=6, number=9),
        ]
        latest = ci.latest_runs(runs, SHA, gate_lib.REPO_ID)
        self.assertEqual(list(latest), [PR_WF])
        self.assertEqual(latest[PR_WF]["id"], 6)

    def test_run_from_fork_repo_matches_fork_head_repo_id(self):
        fork_head_repo_id = 98765
        runs = [
            run(head_repo_id=gate_lib.REPO_ID, rid=1),
            run(head_repo_id=fork_head_repo_id, rid=2),
        ]
        latest = ci.latest_runs(runs, SHA, fork_head_repo_id)
        self.assertEqual(list(latest), [PR_WF])
        self.assertEqual(latest[PR_WF]["id"], 2)

    def test_latest_run_number_then_attempt_wins_older_green_vs_latest_red(self):
        # negative test: older attempt was green, latest attempt was red -> latest red wins
        runs = [
            run(rid=1, number=1, attempt=1, conclusion="success"),
            run(rid=2, number=1, attempt=2, conclusion="failure"),
        ]
        latest = ci.latest_runs(runs, SHA, gate_lib.REPO_ID)
        self.assertEqual(latest[PR_WF]["run_attempt"], 2)
        self.assertEqual(latest[PR_WF]["conclusion"], "failure")

    def test_newer_run_number_red_beats_older_run_number_green(self):
        runs = [
            run(rid=1, number=1, conclusion="success"),
            run(rid=2, number=2, conclusion="failure"),
        ]
        self.assertEqual(ci.evaluate({PR_WF}, ci.latest_runs(runs, SHA, gate_lib.REPO_ID),
                                     lambda rid: default_pr_jobs()).state, "FAILURE")

    def test_path_ref_suffix_is_canonicalized(self):
        self.assertIn(PR_WF, ci.latest_runs([run(path=PR_WF + "@refs/pull/1/merge")], SHA, gate_lib.REPO_ID))


class EvaluateTests(unittest.TestCase):
    def test_zero_required_zero_runs_is_explicit_success(self):
        r = evaluate(set(), [])
        self.assertEqual((r.state, r.code), ("SUCCESS", "ZERO_APPLICABLE_RUNS"))

    def test_all_green_with_required_anchors(self):
        jobs = default_pr_jobs() + [job("ci / build"), job("ci / general_tests (1/5)")]
        r = evaluate({PR_WF}, [run(PR_WF, 1)], {1: jobs})
        self.assertEqual(r.state, "SUCCESS")

    def test_missing_anchor_job_fails_closed_pending(self):
        incomplete_jobs = [
            job("ci / gate / Select trusted runner"),
            job("ci / policy"),
            job("ci / verify"),
        ]
        r = evaluate({PR_WF}, [run(PR_WF, 1)], {1: incomplete_jobs})
        self.assertEqual(r.state, "PENDING")
        self.assertIn("ci / e2e", r.summary)

    def test_job_lacks_ci_prefix_fails(self):
        bad_prefix_jobs = default_pr_jobs() + [job("arbitrary_unscoped_job")]
        r = evaluate({PR_WF}, [run(PR_WF, 1)], {1: bad_prefix_jobs})
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("lacks required 'ci / ' prefix", r.summary)

    def test_allowed_skips_empty_any_skipped_job_fails(self):
        skipped_job = default_pr_jobs() + [job("ci / build", conclusion="skipped")]
        r = evaluate({PR_WF}, [run(PR_WF, 1)], {1: skipped_job})
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("concluded skipped", r.summary)

    def test_negative_action_required_fails(self):
        r = evaluate({PR_WF}, [run(conclusion="action_required")])
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("needs approval to run", r.summary)

    def test_waiting_status_fails(self):
        r = evaluate({PR_WF}, [run(status="waiting", conclusion=None)])
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("needs approval to run", r.summary)

    def test_in_progress_is_pending(self):
        for s in ["queued", "in_progress", "pending", "requested"]:
            with self.subTest(s=s):
                self.assertEqual(evaluate({PR_WF}, [run(status=s, conclusion=None)]).state, "PENDING")

    def test_every_non_success_conclusion_fails(self):
        for c in ["failure", "cancelled", "timed_out", "neutral", "stale", "startup_failure"]:
            with self.subTest(c=c):
                self.assertEqual(evaluate({PR_WF}, [run(conclusion=c)]).state, "FAILURE")

    def test_job_level_action_required_is_a_failure(self):
        jobs = default_pr_jobs() + [job("ci / canary", conclusion="action_required")]
        r = evaluate({PR_WF}, [run(PR_WF, 1)], {1: jobs})
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("concluded action_required", r.summary)

    def test_non_pr_workflows_do_not_need_the_ci_prefix_or_the_anchors(self):
        jobs = [job("Compile isolated native Runner"), job("some unprefixed lane")]
        r = evaluate({DOCKER_WF}, [run(DOCKER_WF, 1)], {1: jobs})
        self.assertEqual((r.state, r.code), ("SUCCESS", "ALL_GREEN"))

    def test_skipped_jobs_fail_in_non_pr_workflows_too(self):
        r = evaluate({DOCKER_WF}, [run(DOCKER_WF, 1)], {1: [job("runner", conclusion="skipped")]})
        self.assertEqual(r.state, "FAILURE")
        self.assertIn("concluded skipped", r.summary)

    def test_green_is_job_count_agnostic(self):
        jobs = default_pr_jobs() + [job(f"ci / lane {i}") for i in range(50)]
        self.assertEqual(evaluate({PR_WF}, [run(PR_WF, 1)], {1: jobs}).state, "SUCCESS")


class StorybookVisualTests(unittest.TestCase):
    def test_unlabeled_trivial_readme_pr_ci_green(self):
        # On an unlabeled PR, storybook-visual.yml is skipped/not applicable even if a run exists
        pr_run = run(PR_WF, 1)
        sb_run = run(SB_WF, 2, status="completed", conclusion="success")
        sb_jobs = [
            job("Storybook visual regression", conclusion="skipped"),
            job("Deploy selected branch Storybook", conclusion="skipped"),
        ]
        res = evaluate({PR_WF}, [pr_run, sb_run], {1: default_pr_jobs(), 2: sb_jobs}, pr_labels=[])
        self.assertEqual(res.state, "SUCCESS")
        self.assertEqual(res.code, "ALL_GREEN")

    def test_labelled_visual_failure_fails(self):
        # On a labeled PR, visual regression failure must fail the gate
        pr_run = run(PR_WF, 1)
        sb_run = run(SB_WF, 2, status="completed", conclusion="failure")
        sb_jobs = [
            job("Storybook visual regression", conclusion="failure"),
            job("Deploy selected branch Storybook", conclusion="skipped"),
        ]
        res = evaluate({PR_WF, SB_WF}, [pr_run, sb_run], {1: default_pr_jobs(), 2: sb_jobs}, pr_labels=["storybook-visual"])
        self.assertEqual(res.state, "FAILURE")
        self.assertEqual(res.code, "CI_NOT_GREEN")

    def test_labelled_visual_success_preview_skipped_green(self):
        # On a labeled PR, visual regression success + preview dispatch job skipped is green
        pr_run = run(PR_WF, 1)
        sb_run = run(SB_WF, 2, status="completed", conclusion="success")
        sb_jobs = [
            job("Storybook visual regression", conclusion="success"),
            job("Deploy selected branch Storybook", conclusion="skipped"),
        ]
        res = evaluate({PR_WF, SB_WF}, [pr_run, sb_run], {1: default_pr_jobs(), 2: sb_jobs}, pr_labels=["storybook-visual"])
        self.assertEqual(res.state, "SUCCESS")
        self.assertEqual(res.code, "ALL_GREEN")

    def test_unknown_job_skip_or_unexpected_jobs_fails(self):
        # If an unknown job in storybook-visual is skipped, it must fail
        pr_run = run(PR_WF, 1)
        sb_run = run(SB_WF, 2, status="completed", conclusion="success")
        sb_jobs = [
            job("Storybook visual regression", conclusion="success"),
            job("Deploy selected branch Storybook", conclusion="skipped"),
            job("unexpected_extra_job", conclusion="skipped"),
        ]
        res = evaluate({PR_WF, SB_WF}, [pr_run, sb_run], {1: default_pr_jobs(), 2: sb_jobs}, pr_labels=["storybook-visual"])
        self.assertEqual(res.state, "FAILURE")
        self.assertEqual(res.code, "CI_NOT_GREEN")

    def test_visual_job_skipped_on_labelled_pr_fails(self):
        # If the visual job itself was skipped on a labelled PR, it must fail
        pr_run = run(PR_WF, 1)
        sb_run = run(SB_WF, 2, status="completed", conclusion="success")
        sb_jobs = [
            job("Storybook visual regression", conclusion="skipped"),
            job("Deploy selected branch Storybook", conclusion="skipped"),
        ]
        res = evaluate({PR_WF, SB_WF}, [pr_run, sb_run], {1: default_pr_jobs(), 2: sb_jobs}, pr_labels=["storybook-visual"])
        self.assertEqual(res.state, "FAILURE")
        self.assertEqual(res.code, "CI_NOT_GREEN")


class AggregateIntegrationTests(unittest.TestCase):
    def test_aggregate_checks_provenance_and_runs(self):
        runs = [run(PR_WF, 1)]
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/actions/runs": {"workflow_runs": runs},
            f"/repos/{gate_lib.REPO}/actions/runs/1/jobs": {"jobs": default_pr_jobs()},
        })
        res = ci.aggregate(gh, SHA, {PR_WF})
        self.assertEqual(res.state, "SUCCESS")

    def test_negative_ci_provenance_untrusted_workflow(self):
        bad_yaml = (
            "name: PR\n"
            "on: pull_request\n"
            "jobs:\n"
            "  ci:\n"
            "    uses: attacker/untrusted/.github/workflows/ci.yml@master\n"
        )
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/contents/.github/workflows/pr.yml": {
                "content": base64.b64encode(bad_yaml.encode("utf-8")).decode("ascii")
            },
        })
        res = ci.aggregate(gh, SHA, {PR_WF})
        self.assertEqual(res.state, "FAILURE")
        self.assertEqual(res.code, "UNTRUSTED_CI_DEFINITION")

    def test_pr_yml_unreadable_at_head_fails_closed(self):
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/contents/.github/workflows/pr.yml": {"sha": "x"},
        })
        res = ci.aggregate(gh, SHA, {PR_WF})
        self.assertEqual((res.state, res.code), ("FAILURE", "UNTRUSTED_CI_DEFINITION"))

    def test_fork_pr_aggregates_runs_of_its_own_head_repo_at_the_exact_head(self):
        fork_head_repo_id = 98765
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/actions/runs": {"workflow_runs": [run(PR_WF, 1, head_repo_id=fork_head_repo_id)]},
            f"/repos/{gate_lib.REPO}/actions/runs/1/jobs": {"jobs": default_pr_jobs()},
        })
        res = ci.aggregate(gh, SHA, {PR_WF}, pr_head_repo_id=fork_head_repo_id)
        self.assertEqual((res.state, res.code), ("SUCCESS", "ALL_GREEN"))
        self.assertTrue(any(f"head_sha={SHA}&event=pull_request" in g for g in gh.gets))
        self.assertTrue(any("jobs?filter=latest" in g for g in gh.gets))

    def test_internal_pr_is_not_credited_with_a_fork_head_repo_run(self):
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/actions/runs": {"workflow_runs": [run(PR_WF, 1, head_repo_id=98765)]},
        })
        res = ci.aggregate(gh, SHA, {PR_WF})
        self.assertEqual((res.state, res.code), ("PENDING", "CI_PENDING"))

    def test_modified_head_storybook_visual_fails_aggregate(self):
        bad_sb = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "jobs:\n"
            "  visual:\n"
            "    name: Storybook visual regression\n"
            "    if: true\n"
        )
        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/contents/.github/workflows/storybook-visual.yml": {
                "content": base64.b64encode(bad_sb.encode("utf-8")).decode("ascii")
            },
        })
        res = ci.aggregate(gh, SHA, {PR_WF})
        self.assertEqual((res.state, res.code), ("FAILURE", "UNTRUSTED_CI_DEFINITION"))


class StorybookDefinitionTests(unittest.TestCase):
    def test_canonical_definition_passes(self):
        from fakes import CANONICAL_STORYBOOK_YML
        ci.validate_storybook_definition(CANONICAL_STORYBOOK_YML)

    def test_counterexample_modified_head_visual_if_true_fails(self):
        bad_yaml = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "    types: [labeled]\n"
            "jobs:\n"
            "  visual:\n"
            "    name: Storybook visual regression\n"
            "    if: true\n"
            "  preview:\n"
            "    name: Deploy selected branch Storybook\n"
            "    if: github.event_name == 'workflow_dispatch' && inputs.deploy_preview\n"
        )
        with self.assertRaises(GateError) as ctx:
            ci.validate_storybook_definition(bad_yaml)
        self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")

    def test_counterexample_mixed_condition_contains_label_or_true_fails(self):
        bad_yaml = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "    types: [labeled]\n"
            "jobs:\n"
            "  visual:\n"
            "    name: Storybook visual regression\n"
            "    if: (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual')) || true\n"
            "  preview:\n"
            "    name: Deploy selected branch Storybook\n"
            "    if: github.event_name == 'workflow_dispatch' && inputs.deploy_preview\n"
        )
        with self.assertRaises(GateError) as ctx:
            ci.validate_storybook_definition(bad_yaml)
        self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")

    def test_counterexample_preview_if_pr_fails(self):
        bad_yaml = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "    types: [labeled]\n"
            "jobs:\n"
            "  visual:\n"
            "    name: Storybook visual regression\n"
            "    if: (github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))\n"
            "  preview:\n"
            "    name: Deploy selected branch Storybook\n"
            "    if: github.event_name == 'pull_request'\n"
        )
        with self.assertRaises(GateError) as ctx:
            ci.validate_storybook_definition(bad_yaml)
        self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")

    def test_counterexample_job_contract_rename_or_extra_fails(self):
        bad_rename = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "    types: [labeled]\n"
            "jobs:\n"
            "  renamed_visual:\n"
            "    name: Storybook visual regression\n"
            "    if: (github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))\n"
            "  preview:\n"
            "    name: Deploy selected branch Storybook\n"
            "    if: github.event_name == 'workflow_dispatch' && inputs.deploy_preview\n"
        )
        with self.assertRaises(GateError) as ctx:
            ci.validate_storybook_definition(bad_rename)
        self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")

        bad_extra = (
            "name: Storybook Visual\n"
            "on:\n"
            "  pull_request:\n"
            "    branches: [master]\n"
            "    types: [labeled]\n"
            "jobs:\n"
            "  visual:\n"
            "    name: Storybook visual regression\n"
            "    if: (github.event_name == 'workflow_dispatch' && !inputs.deploy_preview) || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'storybook-visual'))\n"
            "  preview:\n"
            "    name: Deploy selected branch Storybook\n"
            "    if: github.event_name == 'workflow_dispatch' && inputs.deploy_preview\n"
            "  backdoor:\n"
            "    runs-on: ubuntu-latest\n"
        )
        with self.assertRaises(GateError) as ctx:
            ci.validate_storybook_definition(bad_extra)
        self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")

    def test_malformed_storybook_definition_fails_closed(self):
        for bad in ["", "not: yaml: [", "123", "name: 5\n"]:
            with self.subTest(bad=bad), self.assertRaises(GateError) as ctx:
                ci.validate_storybook_definition(bad)
            self.assertEqual(ctx.exception.code, "UNTRUSTED_CI_DEFINITION")


if __name__ == "__main__":
    unittest.main()
