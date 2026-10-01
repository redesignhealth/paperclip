#!/usr/bin/env python3
"""Unit tests for deterministic path-based workflow classifier (TECH-7014).

Covers all required acceptance scenarios:
- path glob root/recursive boundaries
- docs-only rh-paperclip A empty
- docs-only paperclip A={PR}
- count=301 indeterminate limit
- count=0 behavior
- overlap upstream-version
- unmodeled guards (paths-ignore, branches, tags, leading !)
- types labeled only
"""

import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from path_filter import (
    PATHS_FILTER_LIMIT,
    WorkflowRule,
    classify_workflow,
    github_glob_to_regex,
    parse_workflow_file,
)


class TestPathGlobMatching(unittest.TestCase):
    def test_root_anchoring(self):
        regex = github_glob_to_regex("Dockerfile")
        self.assertTrue(regex.match("Dockerfile"))
        self.assertFalse(regex.match("sub/Dockerfile"))
        self.assertFalse(regex.match("Dockerfile.old"))

    def test_recursive_double_star(self):
        regex = github_glob_to_regex("terraform/**")
        self.assertTrue(regex.match("terraform/main.tf"))
        self.assertTrue(regex.match("terraform/modules/foo/bar.tf"))
        self.assertFalse(regex.match("sub/terraform/main.tf"))

    def test_single_star_segment_boundary(self):
        regex = github_glob_to_regex("*.txt")
        self.assertTrue(regex.match("foo.txt"))
        self.assertFalse(regex.match("dir/foo.txt"))

    def test_double_star_leading(self):
        regex = github_glob_to_regex("**/*.js")
        self.assertTrue(regex.match("index.js"))
        self.assertTrue(regex.match("src/index.js"))
        self.assertTrue(regex.match("src/components/button.js"))
        self.assertFalse(regex.match("index.ts"))

    def test_question_mark_single_char(self):
        regex = github_glob_to_regex("file?.txt")
        self.assertTrue(regex.match("file1.txt"))
        self.assertTrue(regex.match("fileA.txt"))
        self.assertFalse(regex.match("file12.txt"))
        self.assertFalse(regex.match("file/.txt"))

    def test_character_class_and_negation(self):
        regex = github_glob_to_regex("file[0-9].txt")
        self.assertTrue(regex.match("file1.txt"))
        self.assertFalse(regex.match("fileA.txt"))

        neg_regex = github_glob_to_regex("file[!0-9].txt")
        self.assertTrue(neg_regex.match("fileA.txt"))
        self.assertFalse(neg_regex.match("file1.txt"))


class TestPathClassificationScenarios(unittest.TestCase):
    def setUp(self):
        # rh-paperclip workflows
        self.rh_tf_rule = WorkflowRule(
            name="Terraform CI",
            file_path=Path(".github/workflows/terraform-ci.yml"),
            paths=[
                "terraform/**",
                ".github/workflows/terraform-ci.yml",
                ".github/workflows/image-build.yml",
                ".github/workflows/upstream-bump.yml",
                "upstream-version.txt",
                "scripts/**",
            ],
        )
        self.rh_image_rule = WorkflowRule(
            name="Image Build",
            file_path=Path(".github/workflows/image-build.yml"),
            paths=[
                "upstream-version.txt",
                ".github/workflows/image-build.yml",
            ],
        )

        # paperclip workflows
        self.pc_pr_rule = WorkflowRule(
            name="PR",
            file_path=Path(".github/workflows/pr.yml"),
            unfiltered=True,
        )
        self.pc_docker_rule = WorkflowRule(
            name="Docker Runner check",
            file_path=Path(".github/workflows/docker-runner-check.yml"),
            paths=[
                ".github/workflows/docker-runner-check.yml",
                "Dockerfile",
                ".dockerignore",
                "scripts/check-docker-runner-cache.sh",
                "packages/paperclip-runner/rust-toolchain.toml",
                "packages/paperclip-runner/runner/**",
                "packages/paperclip-runner/protocol/**",
            ],
        )

    def test_docs_only_rh_paperclip_a_empty(self):
        docs_changes = ["docs/merge-gate.md", "README.md"]
        res_tf = classify_workflow(self.rh_tf_rule, docs_changes, len(docs_changes))
        res_img = classify_workflow(self.rh_image_rule, docs_changes, len(docs_changes))

        self.assertFalse(res_tf.applicable)
        self.assertEqual(res_tf.reason, "paths_no_match")
        self.assertFalse(res_img.applicable)
        self.assertEqual(res_img.reason, "paths_no_match")

        applicable = [r.workflow_name for r in [res_tf, res_img] if r.applicable]
        self.assertEqual(applicable, [])

    def test_docs_only_paperclip_a_pr(self):
        docs_changes = ["docs/merge-gate.md", "README.md"]
        res_pr = classify_workflow(self.pc_pr_rule, docs_changes, len(docs_changes))
        res_docker = classify_workflow(self.pc_docker_rule, docs_changes, len(docs_changes))

        self.assertTrue(res_pr.applicable)
        self.assertEqual(res_pr.reason, "unfiltered")
        self.assertFalse(res_docker.applicable)
        self.assertEqual(res_docker.reason, "paths_no_match")

        applicable = [r.workflow_name for r in [res_pr, res_docker] if r.applicable]
        self.assertEqual(applicable, ["PR"])

    def test_count_301_indeterminate_limit(self):
        changed_files = [f"file_{i}.txt" for i in range(301)]
        res_tf = classify_workflow(self.rh_tf_rule, changed_files, 301)
        self.assertTrue(res_tf.applicable)
        self.assertEqual(res_tf.reason, "indeterminate_limit")

    def test_count_0_behavior(self):
        res_unfiltered = classify_workflow(self.pc_pr_rule, [], 0)
        self.assertTrue(res_unfiltered.applicable)
        self.assertEqual(res_unfiltered.reason, "unfiltered")

        res_filtered = classify_workflow(self.rh_tf_rule, [], 0)
        self.assertFalse(res_filtered.applicable)
        self.assertEqual(res_filtered.reason, "paths_no_match")

    def test_overlap_upstream_version(self):
        changes = ["upstream-version.txt"]
        res_tf = classify_workflow(self.rh_tf_rule, changes, len(changes))
        res_img = classify_workflow(self.rh_image_rule, changes, len(changes))

        self.assertTrue(res_tf.applicable)
        self.assertEqual(res_tf.reason, "paths_match")
        self.assertTrue(res_img.applicable)
        self.assertEqual(res_img.reason, "paths_match")

        applicable = sorted([r.workflow_name for r in [res_tf, res_img] if r.applicable])
        self.assertEqual(applicable, ["Image Build", "Terraform CI"])

    def test_unmodeled_guards(self):
        rule_paths_ignore = WorkflowRule(
            name="Unmodeled Paths Ignore",
            file_path=Path("dummy.yml"),
            unmodeled=True,
            unmodeled_reason="unmodeled trigger key: paths-ignore",
        )
        res = classify_workflow(rule_paths_ignore, ["foo.txt"], 1)
        self.assertTrue(res.applicable)
        self.assertEqual(res.reason, "unmodeled")

        rule_branches_ignore = WorkflowRule(
            name="Unmodeled Branches",
            file_path=Path("dummy.yml"),
            unmodeled=True,
            unmodeled_reason="unmodeled trigger key: branches-ignore",
        )
        res = classify_workflow(rule_branches_ignore, ["foo.txt"], 1)
        self.assertTrue(res.applicable)
        self.assertEqual(res.reason, "unmodeled")

        rule_neg_path = WorkflowRule(
            name="Leading Bang Path",
            file_path=Path("dummy.yml"),
            unmodeled=True,
            unmodeled_reason="leading '!' in path: !docs/**",
        )
        res = classify_workflow(rule_neg_path, ["foo.txt"], 1)
        self.assertTrue(res.applicable)
        self.assertEqual(res.reason, "unmodeled")

    def test_types_labeled_only(self):
        rule_labeled_only = WorkflowRule(
            name="Labeled Only",
            file_path=Path("dummy.yml"),
            not_applicable_types=True,
            types=["labeled", "unlabeled"],
        )
        res = classify_workflow(rule_labeled_only, ["foo.txt"], 1)
        self.assertFalse(res.applicable)
        self.assertEqual(res.reason, "types_excluding_open_sync_reopen")


if __name__ == "__main__":
    unittest.main()
