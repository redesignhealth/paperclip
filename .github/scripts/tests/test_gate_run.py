import contextlib
import io
import json
import unittest
from unittest import mock

import _path  # noqa: F401
import argus_verdict as av
import ci_aggregate as ci
import gate_lib
import gate_run as gr
from gate_lib import GateError
from fakes import SHA, SHA2, FakeGitHub, pr

R = gate_lib.REPO
PR_PATH = f"/repos/{R}/pulls/7"
REQ = [".github/workflows/pr.yml"]

OK_A = av.ArgusResult("approve", "EXACT_HEAD_APPROVE", "ok")
OK_C = ci.CiResult("SUCCESS", "ALL_GREEN", "ok")


def seq(*values):
    """Callable returning successive values; the last repeats."""
    items = list(values)
    return lambda: items.pop(0) if len(items) > 1 else items[0]


class Harness:
    def __init__(self, heads=(SHA,), reviews=(), argus=(OK_A,), cis=(OK_C,), key="k" * 12, extra_read=None, prs_list=None, **pr_kw):
        self.log = []
        prs = list(prs_list) if prs_list is not None else [pr(7, sha=h, **pr_kw) for h in heads]
        responses = {PR_PATH: seq(*prs)}
        responses.update(extra_read or {})
        self.read = FakeGitHub(responses)
        self.app = FakeGitHub({f"{PR_PATH}/reviews": list(reviews)})
        a, c = seq(*argus), seq(*cis)

        def argus_check(n, sha, k):
            self.log.append(("argus", sha, len(self.app.writes)))
            v = a()
            if isinstance(v, Exception):
                raise v
            return v

        def ci_check(gh, sha, req, pr_head_repo_id=None, pr_labels=None):
            self.log.append(("ci", sha, len(self.app.writes)))
            v = c()
            if isinstance(v, Exception):
                raise v
            return v

        def fetch_key():
            self.log.append(("key", None, len(self.app.writes)))
            if isinstance(key, Exception):
                raise key
            return key

        self.fetch_key, self.argus_check, self.ci_check = fetch_key, argus_check, ci_check

    def run(self, expected=SHA):
        return gr.run(7, expected, REQ, read=self.read, app=self.app, fetch_key=self.fetch_key,
                      argus_check=self.argus_check, ci_check=self.ci_check)

    def posts(self, suffix):
        return [w for w in self.app.writes if w[0] == "POST" and w[1].endswith(suffix)]


class HappyPathTests(unittest.TestCase):
    def test_both_pass_concludes_success_on_head_and_approves_at_head(self):
        h = Harness()
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("completed", "success"), "ci-aggregate": ("completed", "success")})
        for _, _, body in h.posts("/check-runs"):
            self.assertEqual(body["head_sha"], SHA)
        review = h.posts("/reviews")
        self.assertEqual(len(review), 1)
        self.assertEqual(review[0][2]["commit_id"], SHA)
        self.assertEqual(review[0][2]["event"], "APPROVE")
        self.assertIn(gate_lib.REVIEW_MARKER, review[0][2]["body"])

    def test_fork_pr_is_eligible_and_gates_normally(self):
        # Public fork PR with positive integer head repo ID
        h = Harness(head_repo=987654)
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("completed", "success"), "ci-aggregate": ("completed", "success")})

    def test_in_progress_checks_exist_before_any_backend_is_queried(self):
        h = Harness()
        h.run()
        first_backend = next(i for i, (name, _, _) in enumerate(h.log) if name in ("key", "argus", "ci"))
        self.assertEqual(h.log[first_backend][2], 2)  # both check-run POSTs already happened
        self.assertEqual([e[0] for e in h.log], ["key", "argus", "ci", "argus", "ci"])  # evaluated twice

    def test_only_app_client_writes_and_read_client_never_does(self):
        h = Harness()
        h.run()
        self.assertEqual(h.read.writes, [])

    def test_adopts_an_in_progress_check_instead_of_creating_another(self):
        h = Harness()
        h.app.checks[50] = {"id": 50, "name": "argus-gate", "head_sha": SHA, "status": "in_progress", "app": {"id": gate_lib.APP_ID}}
        h.run()
        creates = [b["name"] for _, _, b in h.posts("/check-runs")]
        self.assertEqual(creates, ["ci-aggregate"])
        self.assertEqual(h.app.checks[50]["conclusion"], "success")


class AdoptionTests(unittest.TestCase):
    def forged(self, cid, name="argus-gate", status="in_progress", sha=SHA, app=15368):
        return {"id": cid, "name": name, "head_sha": sha, "status": status, "conclusion": None, "app": {"id": app}}

    def test_in_progress_check_of_the_generic_actions_app_is_never_adopted(self):
        h = Harness()
        h.app.checks[700] = self.forged(700)
        h.run()
        creates = [b["name"] for _, _, b in h.posts("/check-runs")]
        self.assertEqual(creates, ["argus-gate", "ci-aggregate"])  # fresh runs, never the forged id
        self.assertIsNone(h.app.checks[700]["conclusion"])  # the forged record is left untouched

    def test_in_progress_check_at_another_head_is_never_adopted(self):
        h = Harness()
        h.app.checks[701] = self.forged(701, app=gate_lib.APP_ID, sha=SHA2)
        h.run()
        for _, _, body in h.posts("/check-runs"):
            self.assertEqual(body["head_sha"], SHA)

    def test_completed_check_of_a_previous_sweep_is_not_adopted_but_superseded(self):
        h = Harness()
        h.app.checks[702] = self.forged(702, app=gate_lib.APP_ID, status="completed")
        h.app.checks[702]["conclusion"] = "failure"
        self.assertEqual(h.run(), 1)
        self.assertEqual(h.app.checks[702]["conclusion"], "failure")
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("in_progress", None))


class CheckRunApiShapeTests(unittest.TestCase):
    def test_pending_patch_keeps_the_run_in_progress_without_a_conclusion(self):
        h = Harness(argus=(av.ArgusResult("pending", "MISSING_REVIEW", "m"),))
        h.run()
        patches = [b for v, p, b in h.app.writes if v == "PATCH"]
        self.assertEqual(len(patches), 2)
        for body in patches:
            self.assertEqual(body["status"], "in_progress")
            self.assertNotIn("conclusion", body)
            self.assertNotIn("completed_at", body)
            self.assertEqual(set(body), {"status", "output"})

    def test_terminal_patches_carry_a_conclusion_and_completed_at(self):
        h = Harness(argus=(av.ArgusResult("blocking", "VERDICT_BLOCKING", "b"),),
                    cis=(ci.CiResult("FAILURE", "CI_NOT_GREEN", "f"),))
        h.run()
        patches = [b for v, p, b in h.app.writes if v == "PATCH"]
        self.assertEqual(len(patches), 2)
        for body in patches:
            self.assertEqual(body["status"], "completed")
            self.assertEqual(body["conclusion"], "failure")
            self.assertRegex(body["completed_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
            self.assertEqual(set(body["output"]), {"title", "summary"})

    def test_create_post_is_in_progress_on_exactly_the_head(self):
        h = Harness(argus=(av.ArgusResult("pending", "MISSING_REVIEW", "m"),))
        h.run()
        for verb, path, body in h.app.writes:
            if verb == "POST" and path.endswith("/check-runs"):
                self.assertEqual(body["status"], "in_progress")
                self.assertEqual(body["head_sha"], SHA)
                self.assertNotIn("conclusion", body)

    def test_check_create_422_error_fails_and_not_green(self):
        # 422 error when creating App check run fails closed and exits 1
        h = Harness()
        original = h.app.post

        def post(path, body):
            if path.endswith("/check-runs"):
                raise GateError("HTTP_422")
            return original(path, body)

        h.app.post = post
        self.assertEqual(h.run(), 1)


class BackendErrorTests(unittest.TestCase):
    def test_backend_api_error_on_the_fresh_read_parks_never_publishes_the_cached_pass(self):
        h = Harness(argus=(OK_A, GateError("ARGUS_API_HTTP_503")))
        self.assertEqual(h.run(), 1)
        self.assertEqual([e[0] for e in h.log], ["key", "argus", "ci", "argus"])
        self.assertEqual(set(h.app.conclusions().values()), {("in_progress", None)})
        self.assertEqual(h.posts("/reviews"), [])

    def test_backend_api_error_on_the_first_read_parks_before_ci_is_queried(self):
        h = Harness(argus=(GateError("ARGUS_API_NETWORK_ERROR"),))
        self.assertEqual(h.run(), 1)
        self.assertEqual([e[0] for e in h.log], ["key", "argus"])
        self.assertEqual(set(h.app.conclusions().values()), {("in_progress", None)})

    def test_ci_backend_error_parks_without_concluding_success(self):
        h = Harness(cis=(GateError("PAGINATION_LIMIT"),))
        self.assertEqual(h.run(), 1)
        self.assertEqual([e[0] for e in h.log], ["key", "argus", "ci"])
        self.assertEqual(set(h.app.conclusions().values()), {("in_progress", None)})
        self.assertEqual(h.posts("/reviews"), [])


class NotSatisfiedTests(unittest.TestCase):
    def test_argus_pending_holds_even_a_green_ci_in_progress(self):
        h = Harness(argus=(av.ArgusResult("pending", "MISSING_REVIEW", "none"),))
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("in_progress", None), "ci-aggregate": ("in_progress", None)})
        self.assertEqual(h.posts("/reviews"), [])
        self.assertEqual([e[0] for e in h.log], ["key", "argus", "ci"])

    def test_blocking_concludes_failure_and_no_review(self):
        h = Harness(argus=(av.ArgusResult("blocking", "VERDICT_BLOCKING", "b"),))
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions()["argus-gate"], ("completed", "failure"))
        self.assertEqual(h.posts("/reviews"), [])

    def test_ci_failure_concludes_failure(self):
        h = Harness(cis=(ci.CiResult("FAILURE", "CI_NOT_GREEN", "f"),))
        h.run()
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("completed", "failure"))
        self.assertNotEqual(h.app.conclusions()["argus-gate"], ("completed", "success"))

    def test_ci_pending_is_not_success(self):
        h = Harness(cis=(ci.CiResult("PENDING", "CI_PENDING", "p"),))
        h.run()
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("in_progress", None))

    def test_argus_api_error_is_never_success_and_exits_nonzero(self):
        h = Harness(argus=(av.ArgusResult("error", "ARGUS_API_HTTP_403", "x"),))
        self.assertEqual(h.run(), 1)
        self.assertNotIn(("completed", "success"), h.app.conclusions().values())
        self.assertEqual(h.posts("/reviews"), [])

    def test_flip_between_the_two_reads_never_succeeds(self):
        h = Harness(argus=(OK_A, av.ArgusResult("blocking", "VERDICT_BLOCKING", "b")))
        h.run()
        self.assertEqual(h.app.conclusions()["argus-gate"], ("completed", "failure"))
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("completed", "success"))
        self.assertEqual(h.posts("/reviews"), [])

    def test_key_failure_parks_both_checks_without_querying_backends(self):
        h = Harness(key=GateError("ARGUS_KEY_UNAVAILABLE"))
        self.assertEqual(h.run(), 1)
        self.assertEqual([e[0] for e in h.log], ["key"])
        self.assertEqual(set(h.app.conclusions().values()), {("in_progress", None)})


class RaceTests(unittest.TestCase):
    def test_head_moves_during_evaluation_cancels_old_head_checks_and_succeeds_nowhere(self):
        h = Harness(heads=(SHA, SHA, SHA2))
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("completed", "cancelled"), "ci-aggregate": ("completed", "cancelled")})
        self.assertEqual(h.posts("/reviews"), [])
        for c in h.app.checks.values():
            self.assertEqual(c["head_sha"], SHA)

    def test_head_moves_after_success_skips_review_but_success_stays_on_old_sha(self):
        h = Harness(heads=(SHA, SHA, SHA, SHA2))
        h.run()
        self.assertEqual(h.app.conclusions()["argus-gate"], ("completed", "success"))
        self.assertEqual(h.posts("/reviews"), [])

    def test_classified_head_differs_from_live_head_does_nothing(self):
        h = Harness(heads=(SHA2,))
        self.assertEqual(h.run(expected=SHA), 0)
        self.assertEqual(h.app.writes, [])
        self.assertEqual(h.log, [])

    def test_newer_record_for_the_same_check_is_not_overwritten_with_success(self):
        h = Harness()
        original = h.argus_check

        def interfering(n, sha, k):
            if len([e for e in h.log if e[0] == "argus"]) == 1:
                h.app.checks[900] = {"id": 900, "name": "argus-gate", "head_sha": SHA, "status": "completed",
                                     "conclusion": "failure", "app": {"id": gate_lib.APP_ID}}
            return original(n, sha, k)

        h.argus_check = interfering
        self.assertEqual(h.run(), 1)
        self.assertEqual(h.app.checks[900]["conclusion"], "failure")
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("in_progress", None))
        self.assertEqual(h.posts("/reviews"), [])

    def test_labels_added_during_evaluation_cancels_checks_as_superseded(self):
        # PR initial read has no label, second read (in evaluate) has storybook-visual added
        pr_unlabeled = pr(7, SHA, extra={"labels": []})
        pr_labeled = pr(7, SHA, extra={"labels": [{"name": "storybook-visual"}]})
        h = Harness(prs_list=[pr_unlabeled, pr_labeled])
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("completed", "cancelled"), "ci-aggregate": ("completed", "cancelled")})
        self.assertEqual(h.posts("/reviews"), [])

    def test_labels_removed_during_evaluation_cancels_checks_as_superseded(self):
        # PR initial read has label, second read has label removed
        pr_labeled = pr(7, SHA, extra={"labels": [{"name": "storybook-visual"}]})
        pr_unlabeled = pr(7, SHA, extra={"labels": []})
        h = Harness(prs_list=[pr_labeled, pr_unlabeled])
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions(), {"argus-gate": ("completed", "cancelled"), "ci-aggregate": ("completed", "cancelled")})
        self.assertEqual(h.posts("/reviews"), [])

    def test_label_present_at_initial_read_recomputes_required_and_fails_on_failed_visual_run(self):
        # PR was classified without label (required=[pr.yml] passed to run), but initial live read
        # sees storybook-visual label. effective_required recomputes to require storybook-visual.yml.
        pr_labeled = pr(7, SHA, extra={"labels": [{"name": "storybook-visual"}]})
        ci_called_with = []

        def ci_check(read, sha, req, pr_head_repo_id=None, pr_labels=None):
            ci_called_with.append((list(req), list(pr_labels or [])))
            return ci.CiResult("FAILURE", "CI_NOT_GREEN", "Storybook visual regression failed")

        h = Harness(prs_list=[pr_labeled, pr_labeled])
        h.ci_check = ci_check
        rc = h.run()
        self.assertEqual(rc, 0)
        self.assertIn(".github/workflows/storybook-visual.yml", ci_called_with[0][0])
        self.assertIn("storybook-visual", ci_called_with[0][1])
        self.assertEqual(h.app.conclusions()["ci-aggregate"], ("completed", "failure"))
        self.assertNotEqual(h.app.conclusions()["argus-gate"], ("completed", "success"))
        self.assertEqual(h.posts("/reviews"), [])


class RevocationTests(unittest.TestCase):
    def test_newer_blocking_at_the_same_head_concludes_the_latest_argus_check_failure(self):
        first = Harness()
        self.assertEqual(first.run(), 0)
        self.assertEqual(first.app.conclusions(),
                         {"argus-gate": ("completed", "success"), "ci-aggregate": ("completed", "success")})
        self.assertEqual(len(first.posts("/reviews")), 1)

        second = Harness(argus=(av.ArgusResult("blocking", "VERDICT_BLOCKING", "b"),))
        second.app = first.app
        self.assertEqual(second.run(), 0)

        latest = gr.latest_app_check(second.app, gate_lib.CHECK_ARGUS, SHA)
        self.assertEqual((latest["status"], latest["conclusion"]), ("completed", "failure"))
        latest_ci = gr.latest_app_check(second.app, gate_lib.CHECK_CI, SHA)
        self.assertEqual((latest_ci["status"], latest_ci.get("conclusion")), ("in_progress", None))

        old = [c for c in first.app.checks.values() if c["name"] == gate_lib.CHECK_ARGUS and c["id"] != latest["id"]]
        self.assertEqual({(c["status"], c["conclusion"]) for c in old}, {("completed", "success")})
        self.assertEqual(len(first.posts("/reviews")), 1)
        self.assertNotIn("PUT", [w[0] for w in first.app.writes])


class EligibilityTests(unittest.TestCase):
    def test_ineligible_prs_cause_no_writes_at_all(self):
        for kw in [dict(state="closed"), dict(base="dev"), dict(head_repo=None), dict(head_repo=0), dict(author=gate_lib.APP_BOT_LOGIN)]:
            with self.subTest(kw=kw):
                h = Harness(**kw)
                self.assertEqual(h.run(), 0)
                self.assertEqual(h.app.writes, [])
                self.assertEqual(h.log, [])


class ReviewTests(unittest.TestCase):
    def rev(self, login=gate_lib.APP_BOT_LOGIN, state="APPROVED", commit=SHA, body=gate_lib.REVIEW_MARKER + " x"):
        return {"user": {"login": login}, "state": state, "commit_id": commit, "body": body}

    def test_dedup_only_on_the_apps_own_approval_at_this_head_with_marker(self):
        h = Harness(reviews=[self.rev()])
        h.run()
        self.assertEqual(h.posts("/reviews"), [])

    def test_other_actors_markers_states_heads_do_not_dedup(self):
        for r in [self.rev(login="someone"), self.rev(state="COMMENTED"), self.rev(commit=SHA2), self.rev(body="no marker"),
                  self.rev(login="rh-pr-approval-gate")]:
            with self.subTest(r=r):
                h = Harness(reviews=[r])
                h.run()
                self.assertEqual(len(h.posts("/reviews")), 1)

    def test_review_failure_does_not_undo_or_fail_the_checks(self):
        h = Harness()
        original = h.app.post

        def post(path, body):
            if path.endswith("/reviews"):
                raise GateError("HTTP_422")
            return original(path, body)

        h.app.post = post
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.app.conclusions()["argus-gate"], ("completed", "success"))
        self.assertEqual(gr.submit_review(h.read, h.app, 7, SHA), "REVIEW_UNAVAILABLE_HTTP_422")

    def test_head_moved_or_pr_closed_before_the_review_is_skipped_without_writes(self):
        for kw in [dict(heads=(SHA2,)), dict(heads=(SHA,), state="closed")]:
            with self.subTest(kw=kw):
                h = Harness(**kw)
                self.assertEqual(gr.submit_review(h.read, h.app, 7, SHA), "SKIPPED_HEAD_CHANGED")
                self.assertEqual(h.app.writes, [])

    def test_review_listing_failure_is_reported_not_raised(self):
        h = Harness()

        def boom(path, key=None, **_):
            raise GateError("HTTP_403")

        h.app.paginate = boom
        self.assertEqual(gr.submit_review(h.read, h.app, 7, SHA), "REVIEW_UNAVAILABLE_HTTP_403")
        self.assertEqual(h.app.writes, [])

    def test_changes_requested_or_markerless_history_never_dedups(self):
        for r in [self.rev(state="CHANGES_REQUESTED"), self.rev(body="no marker")]:
            with self.subTest(r=r):
                h = Harness(reviews=[r])
                h.run()
                self.assertEqual(len(h.posts("/reviews")), 1)


class HostileMetadataTests(unittest.TestCase):
    HOSTILE = {"title": "::error::pwned", "body": "::add-mask::SECRET\nshell-injection",
               "labels": [{"name": "::error::label"}]}

    def test_hostile_metadata_still_gates_normally_and_is_never_echoed(self):
        h = Harness(extra=self.HOSTILE)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = h.run()
        self.assertEqual(rc, 0)
        self.assertEqual(h.app.conclusions()["argus-gate"], ("completed", "success"))
        for blob in [json.dumps([w[2] for w in h.app.writes]), buf.getvalue()]:
            for hostile in ["pwned", "SECRET", "shell-injection", "::error::label"]:
                self.assertNotIn(hostile, blob)

    def test_ineligible_notice_carries_the_fixed_reason_code_only(self):
        h = Harness(state="closed", extra=self.HOSTILE)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = h.run()
        self.assertEqual(rc, 0)
        self.assertEqual(h.app.writes, [])
        self.assertIn("NOT_OPEN", buf.getvalue())
        for hostile in ["pwned", "SECRET", "shell-injection"]:
            self.assertNotIn(hostile, buf.getvalue())

    def test_malformed_live_pr_is_a_notice_not_a_crash(self):
        h = Harness(extra_read={PR_PATH: "not-a-pr"})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = h.run()
        self.assertEqual(rc, 0)
        self.assertEqual(h.app.writes, [])
        self.assertEqual(h.log, [])
        self.assertIn("MALFORMED_PR", buf.getvalue())


class MainTests(unittest.TestCase):
    def test_bad_inputs_fail_closed_before_any_network(self):
        import os
        base = {"PR_NUMBER": "7", "EXPECTED_HEAD_SHA": SHA, "REQUIRED_WORKFLOWS": "[]", "GITHUB_TOKEN": "t", "APP_TOKEN": "a"}
        for patch in [{"PR_NUMBER": "x"}, {"EXPECTED_HEAD_SHA": "master"}, {"REQUIRED_WORKFLOWS": "not json"},
                      {"REQUIRED_WORKFLOWS": '["../x"]'}, {"REQUIRED_WORKFLOWS": '{"a":1}'}, {"APP_TOKEN": ""}]:
            with self.subTest(patch=patch), mock.patch.dict(os.environ, {**base, **patch}, clear=True), \
                    mock.patch.object(gr, "run", side_effect=AssertionError("must not run")):
                self.assertEqual(gr.main(), 1)


if __name__ == "__main__":
    unittest.main()
