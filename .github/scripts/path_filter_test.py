#!/usr/bin/env python3
"""Unit tests for deterministic path-based workflow classifier (TECH-7014).

Covers all required acceptance scenarios:
- path glob root/recursive boundaries
- leading and trailing slash handling (e.g. scripts/**/ direct and nested children)
- non-greedy segment-safe **/ and negated character classes with hyphen escaping
- docs-only rh-paperclip A empty
- docs-only paperclip A={PR}
- count=301 indeterminate limit
- count=0 behavior
- overlap upstream-version
- unmodeled guards (paths-ignore, branches-ignore, tags, negative-only branches, leading !)
- types labeled only (not_applicable_types)
- branches_exclude_default classification (excludes default branch without deadlocking)
- Storybook Visual label-gated coverage and parser tests by name and filename
- fetch_pr_data pagination, count reconciliation, renamed files, and error handling
- fetch_pr_data MAX_PAGES truncation cap fails closed (distinct from count mismatch)
- missing workflows directory raises fail-closed
- real main synchronize race path and __file__-relative integration
- parse_workflow_file YAML parsing edge cases
"""

import inspect
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from gate_constants import DEFAULT_BRANCH  # noqa: E402
from path_filter import (  # noqa: E402
    MAX_PAGES,
    PER_PAGE,
    WorkflowRule,
    classify_all_workflows,
    classify_workflow,
    evaluate_branch_patterns,
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

    def test_trailing_slash_recursive_direct_and_nested_children(self):
        # scripts/**/ normalizes to scripts/** and matches direct and nested children (Requirement 9)
        regex = github_glob_to_regex("scripts/**/")
        self.assertTrue(regex.match("scripts/run.sh"))
        self.assertTrue(regex.match("scripts/nested/run.sh"))
        self.assertFalse(regex.match("other/scripts/run.sh"))

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
        self.assertFalse(neg_regex.match("file/.txt"))

    def test_negated_class_with_hyphen_escaping(self):
        # [!-a] must safely escape hyphen so it does not form a range with / (Requirement 9)
        regex = github_glob_to_regex("file[!-a].txt")
        self.assertTrue(regex.match("fileb.txt"))
        self.assertTrue(regex.match("file1.txt"))
        self.assertFalse(regex.match("file-.txt"))
        self.assertFalse(regex.match("filea.txt"))
        self.assertFalse(regex.match("file/.txt"))

    def test_negated_class_edge_cases(self):
        # [!-], [!--], [!/] and slash exclusion edge cases (Requirement C-4)
        regex_single_hyphen = github_glob_to_regex("file[!-.].txt")
        self.assertTrue(regex_single_hyphen.match("filea.txt"))
        self.assertFalse(regex_single_hyphen.match("file-.txt"))
        self.assertFalse(regex_single_hyphen.match("file/.txt"))

        regex_bare_hyphen = github_glob_to_regex("file[!].txt")
        self.assertTrue(regex_bare_hyphen.match("filea.txt"))
        self.assertFalse(regex_bare_hyphen.match("file/.txt"))

        regex_neg_slash = github_glob_to_regex("file[!/].txt")
        self.assertTrue(regex_neg_slash.match("filea.txt"))
        self.assertFalse(regex_neg_slash.match("file/.txt"))

    def test_negated_double_hyphen_class(self):
        # [!--] (literal double hyphen) takes the dedicated `inner == "--"`
        # branch, distinct from the single-hyphen and bare-"!" branches above.
        # It compiles to [^\--/], a '-'..'/' range exclusion (covers '-', '.',
        # '/') rather than two merely-escaped literal hyphens -- the '.' case
        # below is what distinguishes this branch from generic hyphen escaping.
        regex = github_glob_to_regex("file[!--].txt")
        self.assertTrue(regex.match("filea.txt"))
        self.assertTrue(regex.match("file+.txt"))
        self.assertFalse(regex.match("file-.txt"))
        self.assertFalse(regex.match("file..txt"))
        self.assertFalse(regex.match("file/.txt"))


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
        for key in ["paths-ignore", "branches-ignore", "tags", "tags-ignore"]:
            with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
                f.write(
                    f"name: Unmodeled {key}\non:\n  pull_request:\n    {key}:\n      - 'docs/**'\njobs: {{}}\n"
                )
                f.flush()
                rule = parse_workflow_file(Path(f.name))
                self.assertIsNotNone(rule)
                assert rule is not None
                self.assertTrue(rule.unmodeled)
                self.assertIn(key, rule.unmodeled_reason)

    def test_parse_leading_bang_path(self):
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Negated Path\non:\n  pull_request:\n    paths:\n      - '!docs/**'\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)
            self.assertIn("leading '!'", rule.unmodeled_reason)

    def test_parse_branch_patterns_ordered(self):
        # Matching master passes
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Branch Master\non:\n  pull_request:\n    branches:\n      - master\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertFalse(rule.unmodeled)
            self.assertFalse(rule.branch_excluded)

        # Catch-all ** matching master
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Branch Catchall\non:\n  pull_request:\n    branches:\n      - '**'\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertFalse(rule.unmodeled)
            self.assertFalse(rule.branch_excluded)

        # Ordered negation: ['**', '!master'] excludes default branch
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Exclude Master\non:\n  pull_request:\n    branches:\n      - '**'\n      - '!master'\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.branch_excluded)
            self.assertFalse(rule.unmodeled)

        # Negative-only branch pattern is unmodeled
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Negative Only\non:\n  pull_request:\n    branches:\n      - '!master'\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)

    def test_parse_label_gated_by_yaml_name_and_filename(self):
        # Parsed by workflow name: Storybook Visual
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write("name: Storybook Visual\non:\n  pull_request:\njobs: {}\n")
            f.flush()
            rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertEqual(rule.label_required, "storybook-visual")

        # Parsed by filename: storybook-visual.yml with custom name
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "storybook-visual.yml"
            file_path.write_text(
                "name: Custom Storybook Name\non:\n  pull_request:\njobs: {}\n",
                encoding="utf-8",
            )
            rule = parse_workflow_file(file_path)
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertEqual(rule.label_required, "storybook-visual")

    def test_parse_label_gated_carries_branch_exclusion(self):
        # Label-gated workflow with branch filter excluding default branch carries branch_excluded=True (Requirement C-7)
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Storybook Visual\non:\n  pull_request:\n    branches:\n      - dev\njobs: {}\n"
            )
            f.flush()
            rule = parse_workflow_file(Path(f.name), default_branch="master")
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertEqual(rule.label_required, "storybook-visual")
            self.assertTrue(rule.branch_excluded)

            res = classify_workflow(
                rule,
                ["foo.ts"],
                1,
                labels=["storybook-visual"],
                default_branch="master",
            )
            self.assertFalse(res.applicable)
            self.assertEqual(res.reason, "branches_exclude_default")


class TestBranchPatternEvaluation(unittest.TestCase):
    def test_ordered_evaluation(self):
        self.assertTrue(evaluate_branch_patterns(["master"], "master"))
        self.assertFalse(evaluate_branch_patterns(["dev"], "master"))
        self.assertTrue(evaluate_branch_patterns(["**"], "master"))
        # Order: positive then negated -> False
        self.assertFalse(evaluate_branch_patterns(["**", "!master"], "master"))
        # Order: negated then positive -> True
        self.assertTrue(evaluate_branch_patterns(["!master", "**"], "master"))
        # Negative only -> None (unmodeled)
        self.assertIsNone(evaluate_branch_patterns(["!master"], "master"))

    def test_single_star_does_not_match_slash(self):
        # Single * matches within segment; only ** matches across slashes (Requirement C-5)
        self.assertTrue(evaluate_branch_patterns(["*"], "master"))
        self.assertFalse(evaluate_branch_patterns(["*"], "release/v1"))
        self.assertTrue(evaluate_branch_patterns(["**"], "release/v1"))
        self.assertTrue(evaluate_branch_patterns(["release/*"], "release/v1"))
        self.assertFalse(evaluate_branch_patterns(["release/*"], "release/v1/patch"))
        self.assertTrue(evaluate_branch_patterns(["release/**"], "release/v1/patch"))
        self.assertTrue(evaluate_branch_patterns(["!master", "**"], "master"))
        # Negative only -> None (unmodeled)
        self.assertIsNone(evaluate_branch_patterns(["!master"], "master"))


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
        res_docker = classify_workflow(
            self.pc_docker_rule, docs_changes, len(docs_changes)
        )

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

        applicable = sorted(
            [r.workflow_name for r in [res_tf, res_img] if r.applicable]
        )
        self.assertEqual(applicable, ["Image Build", "Terraform CI"])

    def test_types_labeled_only(self):
        # types excluding opened, synchronize, reopened -> NOT_APPLICABLE (Requirement 11)
        rule_labeled_only = WorkflowRule(
            name="Labeled Only",
            file_path=Path("dummy.yml"),
            not_applicable_types=True,
            types=["labeled", "unlabeled"],
        )
        res = classify_workflow(rule_labeled_only, ["foo.txt"], 1)
        self.assertFalse(res.applicable)
        self.assertEqual(res.reason, "types_excluding_open_sync_reopen")

    def test_unmodeled_guards(self):
        # Restores test_unmodeled_guards from commit 226389b0 (Requirement 11)
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

    def test_branches_exclude_default_classification(self):
        # Branch-excluded workflow classifies not applicable without deadlocking (Requirement 10)
        rule_branch_excl = WorkflowRule(
            name="Dev Workflow",
            file_path=Path("dummy.yml"),
            branch_excluded=True,
        )
        res = classify_workflow(
            rule_branch_excl, ["foo.txt"], 1, default_branch="master"
        )
        self.assertFalse(res.applicable)
        self.assertEqual(res.reason, "branches_exclude_default")

    def test_storybook_visual_label_gated_coverage(self):
        rule = WorkflowRule(
            name="Storybook Visual",
            file_path=Path(".github/workflows/storybook-visual.yml"),
            label_required="storybook-visual",
        )
        res_no_label = classify_workflow(rule, ["foo.ts"], 1, labels=["bug"])
        self.assertFalse(res_no_label.applicable)
        self.assertEqual(res_no_label.reason, "label_not_present")

        res_with_label = classify_workflow(
            rule, ["foo.ts"], 1, labels=["storybook-visual"]
        )
        self.assertTrue(res_with_label.applicable)
        self.assertEqual(res_with_label.reason, "label_present")

    def test_missing_workflows_dir_raises_fail_closed(self):
        with self.assertRaises(RuntimeError) as ctx:
            classify_all_workflows(Path("nonexistent_workflows_dir"), ["foo.ts"], 1)
        self.assertIn("does not exist or is not a directory", str(ctx.exception))

    def test_empty_workflows_dir_raises_fail_closed(self):
        # Directory exists but has zero workflow files -> fail closed (Requirement A-2)
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(RuntimeError) as ctx:
                classify_all_workflows(Path(tmpdir), ["foo.ts"], 1)
            self.assertIn("contains zero .yml/.yaml workflow files", str(ctx.exception))

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


class TestCentralizedDefaultBranch(unittest.TestCase):
    """Every public default_branch parameter must default to the single
    gate_constants.DEFAULT_BRANCH constant, not an independently hardcoded
    "master" literal that could silently drift from it."""

    def test_signatures_default_to_centralized_constant(self):
        self.assertEqual(DEFAULT_BRANCH, "master")
        for fn in (parse_workflow_file, classify_workflow, classify_all_workflows):
            with self.subTest(fn=fn.__qualname__):
                default = inspect.signature(fn).parameters["default_branch"].default
                self.assertEqual(default, DEFAULT_BRANCH)


TEST_SHA = "0123456789abcdef0123456789abcdef01234567"


class TestFetchPrData(unittest.TestCase):
    @patch("urllib.request.urlopen")
    def test_fetch_pr_data_pagination_and_renamed_files(self, mock_urlopen):
        pr_meta = {
            "head": {"sha": TEST_SHA},
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
                mock_resp.read.return_value = (
                    __import__("json").dumps(page1).encode("utf-8")
                )
            else:
                mock_resp.read.return_value = (
                    __import__("json").dumps(pr_meta).encode("utf-8")
                )
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        sha, count, files, labels = fetch_pr_data("org/repo", 28, "token")
        self.assertEqual(sha, TEST_SHA)
        self.assertEqual(count, 2)
        self.assertIn("new_name.ts", files)
        self.assertIn("old_name.ts", files)
        self.assertEqual(labels, ["storybook-visual"])

    @patch("urllib.request.urlopen")
    def test_fetch_pr_data_count_mismatch_fails_closed(self, mock_urlopen):
        pr_meta = {"head": {"sha": TEST_SHA}, "changed_files": 5, "labels": []}
        page1 = [{"filename": "only_one.ts"}]

        def router(req):
            url = req.full_url
            mock_resp = MagicMock()
            if "pulls/28/files" in url:
                mock_resp.read.return_value = (
                    __import__("json").dumps(page1).encode("utf-8")
                )
            else:
                mock_resp.read.return_value = (
                    __import__("json").dumps(pr_meta).encode("utf-8")
                )
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        with self.assertRaises(RuntimeError) as ctx:
            fetch_pr_data("org/repo", 28, "token")
        self.assertIn("does not match PR changed_files", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_fetch_pr_data_pagination_cap_exceeded_fails_closed(self, mock_urlopen):
        # Every page returns a full PER_PAGE batch for MAX_PAGES pages, so the
        # file-listing loop exhausts its pagination cap before reconciling the
        # full declared changed_files count (distinct from a same-page count
        # mismatch: this never even reaches the final count comparison).
        changed_files_count = MAX_PAGES * PER_PAGE + 50
        pr_meta = {
            "head": {"sha": TEST_SHA},
            "changed_files": changed_files_count,
            "labels": [],
        }

        def router(req):
            url = req.full_url
            mock_resp = MagicMock()
            if "pulls/28/files" in url:
                page_items = [{"filename": f"file_{i}.ts"} for i in range(PER_PAGE)]
                mock_resp.read.return_value = (
                    __import__("json").dumps(page_items).encode("utf-8")
                )
            else:
                mock_resp.read.return_value = (
                    __import__("json").dumps(pr_meta).encode("utf-8")
                )
            mock_ctx = MagicMock()
            mock_ctx.__enter__.return_value = mock_resp
            return mock_ctx

        mock_urlopen.side_effect = router
        with self.assertRaises(RuntimeError) as ctx:
            fetch_pr_data("org/repo", 28, "token")
        self.assertIn("exceeded maximum pagination limit", str(ctx.exception))
        self.assertIn(f"{MAX_PAGES} pages", str(ctx.exception))
        self.assertIn("Fail closed", str(ctx.exception))


class TestSynchronizeRaceMainPath(unittest.TestCase):
    @patch("path_filter.fetch_pr_data")
    def test_main_synchronize_race_fails(self, mock_fetch):
        live_sha = "0123456789abcdef0123456789abcdef01234567"
        expected_sha = "1111111111abcdef0123456789abcdef01234567"
        mock_fetch.return_value = (live_sha, 1, ["foo.ts"], [])
        test_args = [
            "path_filter.py",
            "--repo",
            "redesignhealth/paperclip",
            "--pr-number",
            "28",
            "--expected-sha",
            expected_sha,
        ]
        with patch.object(sys, "argv", test_args):
            with self.assertRaises(RuntimeError) as ctx:
                path_filter_main()
            self.assertIn("Synchronize race detected", str(ctx.exception))


class TestPathFilterCharClassAndRegexEdgeCases(unittest.TestCase):
    """Tests for leading-], backslash, nested [, mid-token **, and re.error fail-closed."""

    def test_leading_bracket_in_character_class(self):
        # []a] matches ']' or 'a'
        regex_pos = github_glob_to_regex("file[]a].txt")
        self.assertTrue(regex_pos.match("file].txt"))
        self.assertTrue(regex_pos.match("filea.txt"))
        self.assertFalse(regex_pos.match("fileb.txt"))

        # [!]] matches anything except ']' and '/'
        regex_neg = github_glob_to_regex("file[!]].txt")
        self.assertTrue(regex_neg.match("filea.txt"))
        self.assertFalse(regex_neg.match("file].txt"))
        self.assertFalse(regex_neg.match("file/.txt"))

        # []-] matches ']' or '-'
        regex_hyphen = github_glob_to_regex("file[]-].txt")
        self.assertTrue(regex_hyphen.match("file].txt"))
        self.assertTrue(regex_hyphen.match("file-.txt"))
        self.assertFalse(regex_hyphen.match("filea.txt"))

    def test_backslash_escaping(self):
        # Literal \[ should match literal '[', not open a character class
        regex_bracket = github_glob_to_regex(r"file\[a\].txt")
        self.assertTrue(regex_bracket.match("file[a].txt"))
        self.assertFalse(regex_bracket.match("filea.txt"))

        # Literal \* should match literal '*', not wildcard
        regex_star = github_glob_to_regex(r"file\*name.txt")
        self.assertTrue(regex_star.match("file*name.txt"))
        self.assertFalse(regex_star.match("file_any_name.txt"))

    def test_nested_bracket_safety(self):
        # Nested [ inside character class compiles safely without warnings
        regex = github_glob_to_regex("file[a[b]c.txt")
        self.assertIsNotNone(regex)

    def test_mid_token_double_star_crosses_slash_dismissal_lock(self):
        # Mid-token ** must match across path segment separators (slashes) per GitHub Actions spec
        regex_double = github_glob_to_regex("src/**test.ts")
        self.assertTrue(regex_double.match("src/test.ts"))
        self.assertTrue(regex_double.match("src/sub/dir/test.ts"))

        # Single * must NOT match across slashes
        regex_single = github_glob_to_regex("src/*test.ts")
        self.assertTrue(regex_single.match("src/unit_test.ts"))
        self.assertFalse(regex_single.match("src/sub/dir/test.ts"))

    def test_parse_workflow_file_invalid_path_glob_treated_as_unmodeled(self):
        # parse_workflow_file must independently guard each path pattern at
        # parse time (not only classify_workflow at classification time):
        # a regex-compilation fault on any declared path must fail closed to
        # unmodeled=True rather than propagating a raw re.error/crash.
        with tempfile.NamedTemporaryFile("w+", suffix=".yml") as f:
            f.write(
                "name: Malformed Path Workflow\n"
                "on:\n"
                "  pull_request:\n"
                "    paths:\n"
                "      - 'valid/**'\n"
                "jobs: {}\n"
            )
            f.flush()
            with patch(
                "path_filter.github_glob_to_regex",
                side_effect=re.error("test regex fault"),
            ):
                rule = parse_workflow_file(Path(f.name))
            self.assertIsNotNone(rule)
            assert rule is not None
            self.assertTrue(rule.unmodeled)
            self.assertIn("invalid path glob pattern", rule.unmodeled_reason)
            self.assertIn("'valid/**'", rule.unmodeled_reason)

    def test_regex_compilation_error_treated_as_unmodeled(self):
        rule = WorkflowRule(
            name="Malformed Pattern Workflow",
            file_path="malformed.yml",
            paths=["valid/**"],
        )
        with patch(
            "path_filter.github_glob_to_regex", side_effect=re.error("test regex fault")
        ):
            res = classify_workflow(rule, ["valid/code.ts"], 1)
        self.assertTrue(res.applicable)
        self.assertEqual(res.reason, "unmodeled")
        self.assertIn("regex compilation error", res.details)


if __name__ == "__main__":
    unittest.main()
