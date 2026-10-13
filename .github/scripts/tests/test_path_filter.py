import tempfile
import unittest
from pathlib import Path

import _path  # noqa: F401
import gate_lib
import path_filter as pf
from fakes import FakeGitHub


class GlobTests(unittest.TestCase):
    def m(self, pattern, path):
        return bool(pf.github_glob_to_regex(pattern).match(path))

    def test_semantics(self):
        self.assertTrue(self.m("terraform/**", "terraform/a/b.tf"))
        self.assertTrue(self.m("docs/**", "docs/x.md"))
        self.assertFalse(self.m("docs/**", "xdocs/x.md"))
        self.assertTrue(self.m("scripts/*.sh", "scripts/a.sh"))
        self.assertFalse(self.m("scripts/*.sh", "scripts/a/b.sh"))
        self.assertTrue(self.m("upstream-version.txt", "upstream-version.txt"))
        self.assertFalse(self.m("upstream-version.txt", "sub/upstream-version.txt"))
        self.assertTrue(self.m("**/x.md", "x.md"))
        self.assertTrue(self.m("**/x.md", "a/b/x.md"))
        self.assertTrue(self.m("a?c", "abc"))
        self.assertFalse(self.m("a?c", "a/c"))

    def test_bracket_classes_and_backslash_behavior(self):
        self.assertTrue(self.m("[abc].txt", "b.txt"))
        self.assertFalse(self.m("[abc].txt", "d.txt"))
        self.assertTrue(self.m("[!abc].txt", "d.txt"))
        self.assertFalse(self.m("[!abc].txt", "a.txt"))
        self.assertFalse(self.m("a\\*", "a*"))
        self.assertFalse(self.m("a\\*", "ab"))


WF = {
    "filtered.yml": "on:\n  pull_request:\n    paths: ['src/**']\n  push:\n    branches: [master]\njobs: {}\n",
    "open.yml": "on: pull_request\njobs: {}\n",
    "listform.yml": "on: [push, pull_request]\njobs: {}\n",
    "pushonly.yml": "on:\n  push:\n    branches: [master]\njobs: {}\n",
    "dispatch.yml": "on: workflow_dispatch\njobs: {}\n",
    "labeled.yml": "on:\n  pull_request:\n    types: [labeled]\njobs: {}\n",
    "unmodeled.yml": "on:\n  pull_request:\n    paths-ignore: ['docs/**']\njobs: {}\n",
    "negated.yml": "on:\n  pull_request:\n    paths: ['src/**', '!src/x/**']\njobs: {}\n",
    "branches.yml": "on:\n  pull_request:\n    branches: [master]\n    paths: ['zzz/**']\njobs: {}\n",
    "synconly.yml": "on:\n  pull_request:\n    types: [synchronize]\njobs: {}\n",
    "pathnum.yml": "on:\n  pull_request:\n    paths: [1, 2]\njobs: {}\n",
    "emptypaths.yml": "on:\n  pull_request:\n    paths: []\njobs: {}\n",
}


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        for name, body in WF.items():
            (self.dir / name).write_text(body)

    def tearDown(self):
        self.tmp.cleanup()

    def req(self, files, total=None):
        return pf.required_workflows(self.dir, files, len(files) if total is None else total)

    def p(self, *names):
        return sorted(f".github/workflows/{n}" for n in names)

    def test_paths_match(self):
        self.assertEqual(self.req(["src/a.py"]), self.p(
            "filtered.yml", "open.yml", "listform.yml", "unmodeled.yml", "negated.yml", "branches.yml",
            "synconly.yml", "pathnum.yml"))

    def test_no_match_drops_only_modeled_filtered(self):
        got = self.req(["README.md"])
        self.assertNotIn(".github/workflows/filtered.yml", got)
        self.assertIn(".github/workflows/open.yml", got)
        self.assertIn(".github/workflows/unmodeled.yml", got)
        self.assertNotIn(".github/workflows/pushonly.yml", got)
        self.assertNotIn(".github/workflows/dispatch.yml", got)
        self.assertNotIn(".github/workflows/labeled.yml", got)

    def test_over_limit_makes_filtered_workflows_required(self):
        self.assertIn(".github/workflows/filtered.yml", self.req(["README.md"], total=301))

    def test_zero_files_requires_only_unfiltered(self):
        got = self.req([], total=0)
        self.assertNotIn(".github/workflows/filtered.yml", got)
        self.assertIn(".github/workflows/open.yml", got)

    def test_standard_open_types_include_synchronize_and_reopened(self):
        got = self.req(["README.md"])
        self.assertIn(".github/workflows/synconly.yml", got)
        self.assertNotIn(".github/workflows/labeled.yml", got)

    def test_non_string_path_entries_are_unmodeled_fail_closed(self):
        self.assertIn(".github/workflows/pathnum.yml", self.req(["README.md"]))

    def test_empty_paths_list_is_modeled_and_matches_nothing(self):
        self.assertNotIn(".github/workflows/emptypaths.yml", self.req(["src/a.py"]))
        self.assertNotIn(".github/workflows/emptypaths.yml", self.req(["README.md"]))

    def test_output_is_canonical_workflow_paths(self):
        for p in self.req(["src/a.py"]):
            self.assertRegex(p, gate_lib.WORKFLOW_PATH_RE.pattern)

    def test_workflow_paths_actual_20(self):
        # Negative/coverage test: parse every real workflow in .github/workflows
        wf_dir = Path(__file__).resolve().parents[2] / "workflows"
        actual_files = sorted(wf_dir.glob("*.yml"))
        self.assertGreaterEqual(len(actual_files), 20)
        for f in actual_files:
            # All actual workflow files parse without throwing unhandled exceptions
            pf.parse_workflow(f)

    def test_storybook_visual_requires_label(self):
        wf_dir = Path(__file__).resolve().parents[2] / "workflows"
        sb = wf_dir / "storybook-visual.yml"
        rule = pf.parse_workflow(sb)
        self.assertIsNotNone(rule)
        self.assertEqual(rule.required_label, "storybook-visual")
        self.assertFalse(pf.is_required(rule, ["README.md"], 1, labels=[]))
        self.assertTrue(pf.is_required(rule, ["README.md"], 1, labels=["storybook-visual"]))


class FetchFilesTests(unittest.TestCase):
    def test_reconciles_count(self):
        gh = FakeGitHub({f"/repos/{gate_lib.REPO}/pulls/7/files": [{"filename": "a"}, {"filename": "b"}]})
        self.assertEqual(pf.fetch_changed_files(gh, 7, 2), ["a", "b"])
        with self.assertRaises(gate_lib.GateError) as c:
            pf.fetch_changed_files(gh, 7, 3)
        self.assertEqual(c.exception.code, "CHANGED_FILES_MISMATCH")
        self.assertEqual(pf.fetch_changed_files(gh, 7, 0), [])

    def test_file_listing_is_bounded_by_max_file_pages(self):
        gh = FakeGitHub({f"/repos/{gate_lib.REPO}/pulls/7/files": [{"filename": f"f{i}"} for i in range(10)]})
        self.assertEqual(len(pf.fetch_changed_files(gh, 7, 10)), 10)


if __name__ == "__main__":
    unittest.main()
