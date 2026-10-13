"""The machine ruleset JSON and the offline cutover transformer (jq). No GitHub access."""
import copy
import json
import shutil
import subprocess
import unittest

import _path  # noqa: F401
from _path import REPO_ROOT

JQ = REPO_ROOT / "scripts" / "review-policy-machine-cutover.jq"
TARGET = REPO_ROOT / ".github" / "rulesets" / "master-argus-review.json"
HUMAN = REPO_ROOT / ".github" / "rulesets" / "master-bootstrap-human.json"
APP = 5166579


def rule(ruleset, kind):
    found = [r for r in ruleset["rules"] if r["type"] == kind]
    assert len(found) == 1, kind
    return found[0]


class TargetPolicyTests(unittest.TestCase):
    def setUp(self):
        self.t = json.loads(TARGET.read_text())

    def test_machine_policy_shape(self):
        self.assertEqual(self.t["enforcement"], "active")
        self.assertEqual(self.t["bypass_actors"], [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}])
        self.assertEqual(self.t["conditions"], {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}})
        self.assertEqual(sorted(r["type"] for r in self.t["rules"]), ["deletion", "non_fast_forward", "pull_request", "required_status_checks"])
        self.assertNotIn("merge_queue", [r["type"] for r in self.t["rules"]])

    def test_pull_request_requirement_kept_but_no_human_review(self):
        p = rule(self.t, "pull_request")["parameters"]
        self.assertEqual(p["required_approving_review_count"], 0)
        self.assertEqual(p["required_reviewers"], [])
        self.assertIs(p["require_code_owner_review"], False)
        self.assertIs(p["require_last_push_approval"], False)

    def test_required_checks_are_pinned_to_the_gate_app_not_actions(self):
        checks = rule(self.t, "required_status_checks")["parameters"]
        self.assertEqual({(c["context"], c["integration_id"]) for c in checks["required_status_checks"]},
                         {("argus-gate", APP), ("ci-aggregate", APP)})
        self.assertNotIn(15368, [c["integration_id"] for c in checks["required_status_checks"]])
        self.assertIs(checks["strict_required_status_checks_policy"], False)

    def test_bootstrap_human_ruleset_shape(self):
        h = json.loads(HUMAN.read_text())
        p = rule(h, "pull_request")["parameters"]
        self.assertEqual(p["required_approving_review_count"], 1)
        self.assertEqual(h["bypass_actors"], [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}])
        self.assertIs(p["require_code_owner_review"], False)
        self.assertTrue(p["dismiss_stale_reviews_on_push"])
        self.assertTrue(p["require_last_push_approval"])
        self.assertEqual(p["required_reviewers"][0]["reviewer"]["id"], 16403522)


@unittest.skipUnless(shutil.which("jq"), "jq not installed")
class TransformerTests(unittest.TestCase):
    def jq(self, doc, mode, human=None, expect_ok=True):
        cmd = ["jq", "-e", "--arg", "mode", mode]
        if human is not None:
            cmd += ["--argjson", "human", json.dumps(human)]
        cmd += ["-f", str(JQ)]
        proc = subprocess.run(cmd, input=json.dumps(doc), capture_output=True, text=True)
        if expect_ok:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        self.assertNotEqual(proc.returncode, 0)
        return proc.stderr

    def live(self):
        h = json.loads(HUMAN.read_text())
        live = copy.deepcopy(h)
        live.update(id=99999999, node_id="X", source_type="Repository", _links={"self": {}}, created_at="t", updated_at="t")
        return live

    def test_full_cutover_reaches_the_target_policy_and_preserves_admin_bypass(self):
        # Negative/preservation test: ruleset jq admin preserve across all cutover steps
        step1 = self.jq(self.live(), "add-checks")
        self.assertEqual(step1["bypass_actors"], [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}])

        step2 = self.jq(step1, "machine-review")
        target = json.loads(TARGET.read_text())
        self.assertEqual(rule(step2, "required_status_checks"), rule(target, "required_status_checks"))
        want = rule(target, "pull_request")["parameters"]
        got = rule(step2, "pull_request")["parameters"]
        for k, v in want.items():
            self.assertEqual(got[k], v, k)
        self.assertEqual(step2["bypass_actors"], target["bypass_actors"])
        self.assertEqual(step2["conditions"], target["conditions"])

    def test_rollback_restores_human_and_preserves_admin_bypass(self):
        original = self.live()
        human = copy.deepcopy(rule(original, "pull_request")["parameters"])
        machine = self.jq(self.jq(original, "add-checks"), "machine-review")
        restored = self.jq(machine, "restore-human", human=human)
        self.assertEqual(rule(restored, "pull_request")["parameters"], human)
        self.assertEqual(rule(restored, "required_status_checks"), rule(machine, "required_status_checks"))
        self.assertEqual(restored["bypass_actors"], original["bypass_actors"])

    def test_structural_assertions_fail_closed(self):
        # Zero or several pull_request rules, several required_status_checks rules, or an
        # unknown mode refuse to emit anything (the transformer never guesses).
        live = self.live()
        live["rules"].append(copy.deepcopy(rule(live, "pull_request")))
        self.jq(live, "add-checks", expect_ok=False)
        live = self.live()
        live["rules"] = [r for r in live["rules"] if r["type"] != "pull_request"]
        self.jq(live, "add-checks", expect_ok=False)
        live = self.live()
        live["rules"] += [{"type": "required_status_checks", "parameters": {"required_status_checks": []}}] * 2
        self.jq(live, "add-checks", expect_ok=False)
        self.jq(self.live(), "bogus", expect_ok=False)

    def test_machine_review_refuses_without_our_checks_enforced_first(self):
        # Dropping human review is allowed only AFTER the App checks are required; a ruleset
        # without them (or with only forged non-App entries) is refused.
        self.assertIn("enforce the App checks first", self.jq(self.live(), "machine-review", expect_ok=False))
        live = self.live()
        live["rules"].append({"type": "required_status_checks", "parameters": {"required_status_checks": [
            {"context": "argus-gate", "integration_id": 15368}, {"context": "ci-aggregate", "integration_id": 15368}]}})
        self.assertIn("enforce the App checks first", self.jq(live, "machine-review", expect_ok=False))

    def test_rollback_rejects_a_non_human_snapshot(self):
        machine = self.jq(self.jq(self.live(), "add-checks"), "machine-review")
        for bad in [{}, "x",
                    {"required_approving_review_count": 0, "required_reviewers": []},
                    {"required_approving_review_count": 1, "required_reviewers": []}]:
            with self.subTest(bad=bad):
                self.jq(machine, "restore-human", human=bad, expect_ok=False)


if __name__ == "__main__":
    unittest.main()
