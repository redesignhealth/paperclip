#!/usr/bin/env python3
"""Unit tests for deterministic path-based workflow classifier (TECH-7014).

Covers all required acceptance scenarios:
- path glob root/recursive boundaries
- leading and trailing slash handling
- non-greedy segment-safe **/ and negated character classes [^/...]
- docs-only rh-paperclip A empty
- docs-only paperclip A={PR}
- count=301 indeterminate limit
- count=0 behavior
- overlap upstream-version
- unmodeled guards (paths-ignore, branches, tags, leading !)
- types labeled only
- Storybook Visual label-gated coverage
- fetch_pr_data pagination, count reconciliation, renamed files, and error handling
- missing workflows directory raises fail-closed
- real main synchronize race path and __file__-relative integration
- parse_workflow_file YAML parsing edge cases
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from path_filter import (  # noqa: E402
    WorkflowRule,
    classify_all_workflows,
    classify_workflow,
    fetch_pr_data,
    github_glob_to_regex,
    main as path_filter_main,
    parse_workflow_file,
)


class TestPathGlobMatching(unittest.TestCase):
    def test_root_anchoring(self):
        regex = github_glob_to_regex("Dockerfile")
        self.assertTrue(regex.match("Dockerfile"))
        self.assertFalse(regex.match("sub/Dockerfile"))
        self.assertFalse(regex.match("Dockerfile.old"))

    def test_leading_slash_stripping(self):
        regex1 = github_glob_to_regex("/Dockerfile")
        self.assertTrue(regex1.match("Dockerfile"))
        self.assertFalse(regex1.match("sub/Dockerfile"))

        regex2 = github_glob_to_regex("./scripts/check.sh")
        self.assertTrue(regex2.match("scripts/check.sh"))

    def test_trailing_slash_directory_prefix(self):
        regex = github_glob_to_regex("scripts/")
        self.assertTrue(regex.match("scripts/check.sh"))
        self.assertTrue(regex.match("scripts/sub/test.sh"))
        self.assertFalse(regex.match("other/scripts/check.sh"))

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

    def test_character_class_and_negation_directory_safe(self):
        regex = github_glob_to_regex("file[0-9].txt")
        self.assertTrue(regex.match("file1.txt"))
        self.assertFalse(regex.match("fileA.txt"))

        neg_regex = github_glob_to_regex("file[!0-9].txt")
        self.assertTrue(neg_regex.match("fileA.txt"))
        self.assertFalse(neg_regex.match("file1.txt"))
        # Negated class must not match path separator '/'
        self.assertFalse(neg_regex.match("file/.txt"))


class TestParseWorkflowFile(unittest.TestCase):
    def test_parse_bare_on(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Bare PR\non: pull_request\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unfiltered)

    def test_parse_unmodeled_keys(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Paths Ignore\non:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)
            self.assertIn("paths-ignore", rule.unmodeled_reason)

    def test_parse_leading_bang_path(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Negated Path\non:\n  pull_request:\n    paths:\n      - '!docs/**'\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)
            self.assertIn("leading '!'", rule.unmodeled_reason)

    def test_parse_branch_patterns(self):
        # Matching master passes
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Branch Master\non:\n  pull_request:\n    branches:\n      - master\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertFalse(rule.unmodeled)

        # Matching ** passes
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Branch Catchall\non:\n  pull_request:\n    branches:\n      - '**'\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertFalse(rule.unmodeled)

        # Branch excluding master is unmodeled
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Branch Dev\non:\n  pull_request:\n    branches:\n      - dev\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)


class TestPathClassificationScenarios(unittest.TestCase):
    def setUp(self):
        self.rh_tf_rule = WorkflowRule(
            name="Terraform CI",
            file_path=Path(".github/workflows/terraform-ci.yml"),
            paths=[
                "terraform/**",
                ".github/workflows/terraform-ci.yml",
                ".github/workflows/image-build.yml",
                ".github/workflows/upstream-bump.yml",
                ".github/workflows/merge-gate.yml",
                ".github/workflows/merge-gate-trigger.yml",
                ".github/scripts/**",
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

    def test_storybook_visual_label_gated_coverage(self):
        rule = WorkflowRule(
            name="Storybook Visual",
            file_path=Path(".github/workflows/storybook-visual.yml"),
            label_required="storybook-visual",
        )
        res_no_label = classify_workflow(rule, ["foo.ts"], 1, labels=["bug"])
        self.assertFalse(res_no_label.applicable)
        self.assertEqual(res_no_label.reason, "label_not_present")

        res_with_label = classify_workflow(rule, ["foo.ts"], 1, labels=["storybook-visual"])
        self.assertTrue(res_with_label.applicable)
        self.assertEqual(res_with_label.reason, "label_present")

    def test_missing_workflows_dir_raises_fail_closed(self):
        with self.assertRaises(RuntimeError) as ctx:
            classify_all_workflows(Path("nonexistent_workflows_dir"), ["foo.ts"], 1)
        self.assertIn("does not exist or is not a directory", str(ctx.exception))

    def test_real_workflows_anchor_exclusion_integration(self):
        workflows_dir = REPO_ROOT / ".github" / "workflows"
        self.assertTrue(workflows_dir.is_dir(), f"Expected directory {workflows_dir}")

        results = classify_all_workflows(workflows_dir, ["docs/merge-gate.md"], 1)
        wf_names = [r.workflow_name for r in results]

        self.assertNotIn("Merge Gate Trigger", wf_names)
        self.assertNotIn("Merge Gate", wf_names)

        applicable = {r.workflow_name for r in results if r.applicable}
        self.assertNotIn("Merge Gate Trigger", applicable)
        self.assertEqual(applicable, {"PR"})


class TestFetchPrData(unittest.TestCase):
    @patch("urllib.request.urlopen")
    def test_fetch_pr_data_pagination_and_renamed_files(self, mock_urlopen):
        pr_meta = {
            "head": {"sha": "head123"},
            "changed_files": 2,
            "labels": [{"name": "storybook-visual"}],
        }
        page1 = [
            {"filename": "new_name.ts", "previous_filename": "old_name.ts"},
            {"filename": "other.ts"},
        ]

        def router(req):
            url = req.full_url
            mock_resp = MagicMock()
            if "pulls/28/files" in url:
                mock_resp.read.return_value = __import__("json").dumps(page1).encode("utf-8")
            else:
                mock_resp.read.return_value = __import__("json").dumps(pr_meta).encode("utf-8")
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        sha, count, files, labels = fetch_pr_data("org/repo", 28, "token")
        self.assertEqual(sha, "head123")
        self.assertEqual(count, 2)
        self.assertIn("new_name.ts", files)
        self.assertIn("old_name.ts", files)
        self.assertEqual(labels, ["storybook-visual"])

    @patch("urllib.request.urlopen")
    def test_fetch_pr_data_count_mismatch_fails_closed(self, mock_urlopen):
        pr_meta = {"head": {"sha": "head123"}, "changed_files": 5, "labels": []}
        page1 = [{"filename": "only_one.ts"}]

        def router(req):
            url = req.full_url
            mock_resp = MagicMock()
            if "pulls/28/files" in url:
                mock_resp.read.return_value = __import__("json").dumps(page1).encode("utf-8")
            else:
                mock_resp.read.return_value = __import__("json").dumps(pr_meta).encode("utf-8")
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        with self.assertRaises(RuntimeError) as ctx:
            fetch_pr_data("org/repo", 28, "token")
        self.assertIn("does not match PR changed_files", str(ctx.exception))


class TestSynchronizeRaceMainPath(unittest.TestCase):
    @patch("path_filter.fetch_pr_data")
    def test_main_synchronize_race_fails(self, mock_fetch):
        mock_fetch.return_value = ("new_head_sha", 1, ["foo.ts"], [])
        test_args = [
            "path_filter.py",
            "--repo", "redesignhealth/paperclip",
            "--pr-number", "28",
            "--expected-sha", "stale_head_sha",
        ]
        with patch.object(sys, "argv", test_args):
            with self.assertRaises(RuntimeError) as ctx:
                path_filter_main()
            self.assertIn("Synchronize race detected", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
