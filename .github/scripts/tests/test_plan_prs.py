import json
import unittest

import _path  # noqa: F401
import gate_lib
from gate_lib import GateError
import plan_prs
from fakes import SHA, SHA2, FakeGitHub, pr

PULLS_PATH = f"/repos/{gate_lib.REPO}/pulls?state=open&base=master"


class RecordingGitHub(FakeGitHub):
    """FakeGitHub that also records the paginate() bounds callers ask for."""

    def __init__(self, responses=None):
        super().__init__(responses)
        self.paginate_calls = []

    def paginate(self, path, key=None, **kwargs):
        self.paginate_calls.append((path, kwargs.get("max_pages")))
        return super().paginate(path, key)


def event(sha=SHA, ev="pull_request", repo_id=gate_lib.REPO_ID, head_repo_id=gate_lib.REPO_ID):
    return {
        "workflow_run": {
            "event": ev,
            "head_sha": sha,
            "repository": {"id": repo_id},
            "head_repository": {"id": head_repo_id},
        }
    }


class WorkflowRunTests(unittest.TestCase):
    def test_fork_and_branch_prs_resolved_via_open_master_prs_listing(self):
        fork_head_repo = 987654
        pr_internal = pr(10, SHA, head_repo=gate_lib.REPO_ID)
        pr_fork = pr(20, SHA, head_repo=fork_head_repo)
        pr_other_sha = pr(30, SHA2, head_repo=fork_head_repo)

        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/pulls?state=open&base=master": [pr_internal, pr_fork, pr_other_sha]
        })

        # Event for the fork run
        event = {
            "workflow_run": {
                "event": "pull_request",
                "head_sha": SHA,
                "repository": {"id": gate_lib.REPO_ID},
                "head_repository": {"id": fork_head_repo},
            }
        }
        res = plan_prs._from_workflow_run(gh, event)
        self.assertEqual(res, [20])

        # Event for the internal branch run
        event_internal = {
            "workflow_run": {
                "event": "pull_request",
                "head_sha": SHA,
                "repository": {"id": gate_lib.REPO_ID},
                "head_repository": {"id": gate_lib.REPO_ID},
            }
        }
        res_internal = plan_prs._from_workflow_run(gh, event_internal)
        self.assertEqual(res_internal, [10])

    def test_run_from_wrong_base_repo_or_event_is_ignored(self):
        gh = FakeGitHub()
        event_wrong_repo = {
            "workflow_run": {
                "event": "pull_request",
                "head_sha": SHA,
                "repository": {"id": 1170821064},  # upstream ID
                "head_repository": {"id": 1170821064},
            }
        }
        self.assertEqual(plan_prs._from_workflow_run(gh, event_wrong_repo), [])

        event_wrong_event = {
            "workflow_run": {
                "event": "push",
                "head_sha": SHA,
                "repository": {"id": gate_lib.REPO_ID},
                "head_repository": {"id": gate_lib.REPO_ID},
            }
        }
        self.assertEqual(plan_prs._from_workflow_run(gh, event_wrong_event), [])

    def test_malformed_run_metadata_is_ignored_before_any_listing(self):
        # A short SHA, a missing / negative / string head-repo id or a non-object payload is
        # dropped without ever consulting the API (fail closed, no wasted calls).
        for ev in [
            {},
            {"workflow_run": "x"},
            event(sha="abc"),
            event(sha=SHA[:7]),
            event(head_repo_id=None),
            event(head_repo_id=0),
            event(head_repo_id="12345"),  # a string id is not an integer id
            event(repo_id=0),
        ]:
            with self.subTest(ev=ev):
                gh = RecordingGitHub()
                self.assertEqual(plan_prs._from_workflow_run(gh, ev), [])
                self.assertEqual(gh.gets, [])

    def test_matching_but_ineligible_prs_are_not_queued(self):
        pulls = [
            pr(10, SHA, author=gate_lib.APP_BOT_LOGIN),  # the gate App never approves itself
            pr(11, SHA, state="closed"),
            pr(12, SHA, base="develop"),
            pr(13, SHA),
        ]
        gh = FakeGitHub({PULLS_PATH: pulls})
        self.assertEqual(plan_prs._from_workflow_run(gh, event()), [13])

    def test_resolution_uses_the_bounded_open_pr_listing_not_commit_pulls(self):
        # Fork and branch PRs are resolved via the bounded /pulls?state=open&base=master listing
        # (head sha + head repo id); /commits/{sha}/pulls is never consulted (it can be empty
        # for fork PRs), and the listing is bounded so a huge repo fails loudly, not silently.
        gh = RecordingGitHub({PULLS_PATH: [pr(20, SHA, head_repo=98765)]})
        self.assertEqual(plan_prs._from_workflow_run(gh, event(head_repo_id=98765)), [20])
        self.assertEqual(gh.paginate_calls, [(PULLS_PATH, plan_prs.MAX_LIST_PAGES)])
        self.assertFalse(any("/commits/" in g for g in gh.gets))


class SweepTests(unittest.TestCase):
    def test_sweep_queues_all_eligible_open_prs(self):
        pr1 = pr(1, SHA)
        pr2 = pr(2, SHA2, head_repo=55555)  # fork PR
        pr_closed = pr(3, SHA, state="closed")
        pr_wrong_base = pr(4, SHA, base="main")

        gh = FakeGitHub({
            f"/repos/{gate_lib.REPO}/pulls?state=open&base=master": [pr1, pr2, pr_closed, pr_wrong_base]
        })
        res = plan_prs._sweep(gh)
        self.assertEqual(res, [1, 2])

    def test_sweep_listing_is_bounded_by_max_list_pages(self):
        gh = RecordingGitHub({PULLS_PATH: [pr(1, SHA)]})
        self.assertEqual(plan_prs._sweep(gh), [1])
        self.assertEqual(gh.paginate_calls, [(PULLS_PATH, plan_prs.MAX_LIST_PAGES)])

    def test_sweep_fails_loudly_when_too_many_prs_are_open(self):
        # More than MAX_PRS candidates is a loud error, never a silent skip of the overflow
        # (the sweep is the only thing that revokes an already-green head on a new BLOCKING).
        pulls = [pr(i, SHA) for i in range(1, plan_prs.MAX_PRS + 2)]
        gh = FakeGitHub({PULLS_PATH: pulls})
        with self.assertRaises(GateError) as ctx:
            plan_prs.plan("schedule", {}, gh, "", configured=True)
        self.assertEqual(ctx.exception.code, "TOO_MANY_PRS")


class PlanTests(unittest.TestCase):
    def test_workflow_dispatch_returns_exact_pr(self):
        gh = FakeGitHub()
        res = plan_prs.plan("workflow_dispatch", {}, gh, "42", configured=True)
        self.assertEqual(res, [42])

    def test_unconfigured_dispatch_fails_loudly(self):
        gh = FakeGitHub()
        with self.assertRaises(GateError) as ctx:
            plan_prs.plan("workflow_dispatch", {}, gh, "42", configured=False)
        self.assertEqual(ctx.exception.code, "NOT_CONFIGURED")

    def test_unconfigured_sweep_and_event_returns_empty(self):
        gh = FakeGitHub()
        self.assertEqual(plan_prs.plan("schedule", {}, gh, "", configured=False), [])
        self.assertEqual(plan_prs.plan("workflow_run", {}, gh, "", configured=False), [])

    def test_unsupported_event_is_rejected(self):
        with self.assertRaises(GateError) as ctx:
            plan_prs.plan("pull_request", {}, FakeGitHub(), "", configured=True)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_EVENT")

    def test_dispatch_rejects_invalid_numbers_even_when_configured(self):
        for bad in ["0", "x", "1 2", "-3", ""]:
            with self.subTest(bad=bad):
                with self.assertRaises(GateError) as ctx:
                    plan_prs.plan("workflow_dispatch", {}, FakeGitHub(), bad, configured=True)
                self.assertEqual(ctx.exception.code, "INVALID_PR_NUMBER")


if __name__ == "__main__":
    unittest.main()
