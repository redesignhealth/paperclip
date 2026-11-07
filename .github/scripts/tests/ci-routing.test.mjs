import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../workflows/ci-routing.yml", import.meta.url), "utf8");
const jobs = workflow.split(/^jobs:\n/m)[1];

test("routing runs on ubuntu-latest and runs no PR code or actions", () => {
  assert.deepEqual([...jobs.matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]), ["gate"]);
  const placement = jobs.match(/^ {4}runs-on: (.+)$/m)?.[1];
  assert.equal(placement, "ubuntu-latest", "gate must run on ubuntu-latest until CODEOWNERS verified");
  assert.match(jobs, /# No AWS capacity is allocated until current CI CODEOWNERS are verified\./);
  assert.match(jobs, /# A cached numeric allowlist alone can outlive removal from CODEOWNERS\./);
  assert.doesNotMatch(jobs, /uses:|actions\/checkout|secrets\./);
  assert.doesNotMatch(workflow, /^ {2}(?:actions|contents|pull-requests): write$/m);
});

test("routing exports placement, stack scope, and task plan to callers", () => {
  assert.match(workflow, /^ {6}runner:\n {8}value: \$\{\{ jobs\.gate\.outputs\.runner \}\}$/m);
  assert.match(workflow, /^ {6}full_ci:\n {8}value: \$\{\{ jobs\.gate\.outputs\.full_ci \}\}$/m);
  assert.match(workflow, /^ {6}plan:\n {8}value: \$\{\{ jobs\.gate\.outputs\.plan \}\}$/m);
  assert.match(workflow, /^ {6}profile_ci:\n {8}value: \$\{\{ jobs\.gate\.outputs\.profile_ci \}\}$/m);
  assert.match(jobs, /^ {6}plan: \$\{\{ steps\.plan\.outputs\.plan \}\}$/m);
  assert.match(jobs, /^ {6}runner: \$\{\{ steps\.route\.outputs\.runner \}\}$/m);
  assert.match(jobs, /^ {6}full_ci: \$\{\{ steps\.scope\.outputs\.full_ci \}\}$/m);
  assert.match(jobs, /^ {6}profile_ci: \$\{\{ steps\.profile\.outputs\.profile_ci \}\}$/m);
});

const githubStub = `#!/usr/bin/env bash
set -Eeuo pipefail

jq_filter=""
endpoint=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq)
      jq_filter="$2"
      shift 2
      ;;
    -H|--header)
      shift 2
      ;;
    /*)
      endpoint="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

filter_output() {
  if [[ -n "$jq_filter" ]]; then
    jq -r "$jq_filter"
  else
    cat
  fi
}

case "$endpoint" in
  */pulls/*)
    jq -cn \\
      --argjson author_id "\${TEST_PR_AUTHOR_ID:-34892728}" \\
      --argjson repository_id "\${TEST_REPOSITORY_ID:-1170821064}" \\
      --arg base_ref "\${TEST_BASE_REF:-master}" \\
      --arg base_sha "\${TEST_PR_BASE_SHA:-$EVENT_BASE_SHA}" \\
      --arg head_sha "\${TEST_PR_HEAD_SHA:-1111111111111111111111111111111111111111}" \\
      --arg merge_sha "\${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}" '{
        state: "open",
        user: {id: $author_id},
        base: {repo: {id: $repository_id}, ref: $base_ref, sha: $base_sha},
        head: {sha: $head_sha},
        merge_commit_sha: $merge_sha
      }' | filter_output
    ;;
  */git/ref/heads/*)
    jq -cn \\
      --arg sha "\${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}" '{object: {sha: $sha}}' | filter_output
    ;;
  */compare/*)
    [[ -z "\${TEST_COMPARE_FAIL:-}" ]] || exit 1
    default_files='[{"filename":"server/src/index.ts"}]'
    jq -cn \\
      --arg merge_base_sha "\${TEST_BASE_COMPARISON_MERGE_BASE_SHA:-$EVENT_BASE_SHA}" \\
      --arg status "\${TEST_BASE_COMPARISON_STATUS:-ahead}" \\
      --argjson files "\${TEST_COMPARE_FILES:-$default_files}" '{
        merge_base_commit: {sha: $merge_base_sha},
        status: $status,
        files: $files
      }' | filter_output
    ;;
  */contents/scripts/ci-profile/authorize.mjs*)
    [[ -z "\${TEST_CONTENTS_FAIL:-}" ]] || exit 1
    code="export function trustedOwnerIds() { return [\${TEST_TRUSTED_OWNER_ID:-34892728}]; }"
    encoded="$(printf '%s' "$code" | base64)"
    jq -cn --arg content "$encoded" '{content: $content}' | filter_output
    ;;
  */git/commits/*)
    commit_endpoint="\${endpoint%\\?*}"
    requested_sha="\${commit_endpoint##*/}"
    live_merge_sha="\${TEST_PR_MERGE_SHA:-4444444444444444444444444444444444444444}"
    synthetic_base_merge_sha="\${TEST_SYNTHETIC_BASE_MERGE_SHA:-}"
    if [[ "$requested_sha" == "$EVENT_MERGE_SHA" ]]; then
      tree_sha="\${TEST_EVENT_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}"
      base_sha="\${TEST_EVENT_MERGE_BASE_SHA:-$EVENT_BASE_SHA}"
      head_sha="\${TEST_EVENT_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}"
    elif [[ "$requested_sha" == "$live_merge_sha" ]]; then
      tree_sha="\${TEST_LIVE_MERGE_TREE_SHA:-5555555555555555555555555555555555555555}"
      base_sha="\${TEST_LIVE_MERGE_BASE_SHA:-$EVENT_BASE_SHA}"
      head_sha="\${TEST_LIVE_MERGE_HEAD_SHA:-$EVENT_HEAD_SHA}"
    elif [[ -n "$synthetic_base_merge_sha" && "$requested_sha" == "$synthetic_base_merge_sha" ]]; then
      tree_sha="\${TEST_SYNTHETIC_BASE_MERGE_TREE_SHA:-8888888888888888888888888888888888888888}"
      base_sha="\${TEST_SYNTHETIC_MASTER_PARENT_SHA:-9999999999999999999999999999999999999999}"
      head_sha="\${TEST_SYNTHETIC_BASE_REF_PARENT_SHA:-\${TEST_LIVE_BASE_REF_SHA:-$EVENT_BASE_SHA}}"
    else
      echo "unexpected merge commit: $requested_sha" >&2
      exit 1
    fi
    jq -cn \\
      --arg sha "$requested_sha" \\
      --arg tree_sha "$tree_sha" \\
      --arg base_sha "$base_sha" \\
      --arg head_sha "$head_sha" '{
        sha: $sha,
        tree: {sha: $tree_sha},
        parents: [{sha: $base_sha}, {sha: $head_sha}]
      }' | filter_output
    ;;
  */actions/runs/*)
    jq -cn \\
      --argjson actor_id "\${TEST_TRIGGERING_ACTOR_ID:-34892728}" \\
      --argjson repository_id "\${TEST_REPOSITORY_ID:-1170821064}" \\
      --argjson run_attempt "\${TEST_RUN_ATTEMPT:-\${RUN_ATTEMPT:-1}}" \\
      --arg event_name "\${TEST_EVENT_NAME:-pull_request}" '{
        triggering_actor: {id: $actor_id},
        repository: {id: $repository_id},
        run_attempt: $run_attempt,
        event: $event_name
      }' | filter_output
    ;;
  *)
    echo "unexpected gh endpoint: $endpoint" >&2
    exit 1
    ;;
esac`;

function stepScript(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing step: ${name}`);
  const body = workflow.slice(start);
  const runStart = body.indexOf("        run: |\n");
  assert.ok(runStart >= 0, `missing script: ${name}`);
  const script = body.slice(runStart + "        run: |\n".length).split("\n      - name:")[0];
  return script.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

function executeStep(name, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-routing-test-"));
  const output = path.join(directory, "output");
  try {
    const gh = path.join(directory, "gh");
    writeFileSync(gh, githubStub);
    chmodSync(gh, 0o700);
    const result = spawnSync("bash", ["-c", stepScript(name)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: output,
        AWS_CI_ENABLED: "true",
        TRUSTED_USER_IDS: "[34892728]",
        EVENT_NAME: "pull_request",
        EVENT_REPOSITORY: "paperclipai/paperclip",
        EVENT_REPOSITORY_ID: "1170821064",
        EVENT_ACTION: "synchronize",
        EVENT_PR_NUMBER: "12350",
        EVENT_PR_AUTHOR_ID: "34892728",
        EVENT_SENDER_ID: "34892728",
        EVENT_BASE_REPOSITORY_ID: "1170821064",
        EVENT_BASE_REF: "master",
        EVENT_BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        EVENT_HEAD_SHA: "1111111111111111111111111111111111111111",
        EVENT_MERGE_SHA: "2222222222222222222222222222222222222222",
        RUN_ID: "123456789",
        ...overrides,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "each step must emit exactly one decision");
    return Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const awsRunner = "runs-on/fleet=paperclip-public-pr-x64/env=public-ci";
const stackedBase = {
  EVENT_BASE_REF: "trusted-stack-base",
  TEST_BASE_REF: "trusted-stack-base",
  TEST_PR_BASE_SHA: "7777777777777777777777777777777777777777",
  TEST_LIVE_BASE_REF_SHA: "7777777777777777777777777777777777777777",
  TEST_SYNTHETIC_BASE_MERGE_SHA: "8888888888888888888888888888888888888888",
  TEST_EVENT_MERGE_BASE_SHA: "8888888888888888888888888888888888888888",
  TEST_LIVE_MERGE_BASE_SHA: "8888888888888888888888888888888888888888",
};

const routeCases = [
  ["allowlisted PR", {}, awsRunner],
  ["allowlisted profile label", { EVENT_ACTION: "labeled", EVENT_LABEL_NAME: "profile-ci" }, awsRunner],
  ["unrelated label", { EVENT_ACTION: "labeled", EVENT_LABEL_NAME: "documentation" }],
  ["validated stacked base", stackedBase, awsRunner],
  ["lagging PR API base snapshot", { TEST_PR_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, awsRunner],
  ["disabled AWS", { AWS_CI_ENABLED: "false" }],
  ["missing AWS variables", { AWS_CI_ENABLED: "", TRUSTED_USER_IDS: "" }],
  ["unlisted author", { EVENT_PR_AUTHOR_ID: "99999999" }],
  ["unlisted sender", { EVENT_SENDER_ID: "99999999" }],
  ["unlisted rerun actor", { TEST_TRIGGERING_ACTOR_ID: "99999999" }],
  ["author not in CI CODEOWNERS", { TEST_TRUSTED_OWNER_ID: "99999999" }],
  ["missing CODEOWNERS resolver", { TEST_CONTENTS_FAIL: "1" }],
  ["missing base", { EVENT_BASE_REF: "" }],
  ["wrong base repository", { EVENT_BASE_REPOSITORY_ID: "999999999" }],
  ["replaced base ancestry", { TEST_BASE_COMPARISON_MERGE_BASE_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  ["stale head", { TEST_PR_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["changed merge head", { TEST_LIVE_MERGE_HEAD_SHA: "3333333333333333333333333333333333333333" }],
  ["stacked base with wrong parent", { ...stackedBase, TEST_SYNTHETIC_BASE_REF_PARENT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  ["changed merge tree", { TEST_LIVE_MERGE_TREE_SHA: "6666666666666666666666666666666666666666" }],
  ["wrong repository", { EVENT_REPOSITORY_ID: "999999999" }],
  ["malformed allowlist", { TRUSTED_USER_IDS: '["34892728"]' }],
  ["manual dispatch", { EVENT_NAME: "workflow_dispatch" }],
  ["unsupported PR action", { EVENT_ACTION: "closed" }],
  ["malformed commit SHA", { EVENT_HEAD_SHA: "invalid" }],
];

for (const [name, env, expected = "ubuntu-24.04"] of routeCases) {
  test(`runner decision: ${name}`, () => {
    assert.equal(executeStep("Validate PR identity and select runner", env).runner, expected);
  });
}

const scopeCases = [
  ["ordinary PR", null, "master", "true"],
  ["top stack PR", { position: 11, size: 11, base: { ref: "master" } }, "stack-10", "true"],
  ["lowest unmerged PR", { position: 1, size: 11, base: { ref: "master" } }, "master", "true"],
  ["middle stack PR", { position: 6, size: 11, base: { ref: "master" } }, "stack-5", "false"],
  ["malformed position", { position: "invalid", size: 11, base: { ref: "master" } }, "stack-5", "true"],
  ["out-of-range position", { position: 12, size: 11, base: { ref: "master" } }, "stack-5", "true"],
  ["missing stack base", { position: 6, size: 11 }, "stack-5", "true"],
  ["empty metadata", {}, "master", "true"],
];

for (const [name, stack, base, expected] of scopeCases) {
  test(`scope decision: ${name}`, () => {
    assert.equal(executeStep("Select PR CI scope", {
      STACK_JSON: JSON.stringify(stack), PR_BASE_REF: base,
    }).full_ci, expected);
  });
}

const files = (...paths) => JSON.stringify(paths.map((filename) => ({ filename })));

test("profile-ci overrides both middle-stack and release-notes-only skips", () => {
  for (const overrides of [
    { STACK_JSON: JSON.stringify({ position: 2, size: 3, base: { ref: "master" } }), PR_BASE_REF: "stack-1" },
    { STACK_JSON: "null", PR_BASE_REF: "master", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") },
  ]) {
    assert.equal(executeStep("Select PR CI scope", { ...overrides, PROFILE_CI: "false" }).full_ci, "false");
    assert.equal(executeStep("Select PR CI scope", { ...overrides, PROFILE_CI: "true" }).full_ci, "true");
  }
});

const manyReleaseNotes = JSON.stringify(Array.from({ length: 300 }, (_, index) => ({
  filename: `releases/beta/v2026.1012.${index}-beta.0.md`,
})));

const pathScopeCases = [
  ["stable release notes", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "false"],
  ["beta release notes draft", { TEST_COMPARE_FILES: files("releases/beta/v2026.1012.1-beta.0.md") }, "false"],
  ["stable and beta notes", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md", "releases/beta/v2026.1012.1-beta.0.md") }, "false"],
  ["removed release notes", { TEST_COMPARE_FILES: JSON.stringify([{ filename: "releases/beta/v2026.1006.0-beta.0.md", status: "removed" }]) }, "false"],
  ["release notes and code", { TEST_COMPARE_FILES: files("releases/v2026.1015.0.md", "server/src/index.ts") }, "true"],
  ["code renamed into releases", { TEST_COMPARE_FILES: JSON.stringify([{ filename: "releases/v2026.1015.0.md", previous_filename: "scripts/release.sh" }]) }, "true"],
  ["non-markdown file in releases", { TEST_COMPARE_FILES: files("releases/beta/v2026.1012.1-beta.0.json") }, "true"],
  ["nested releases directory", { TEST_COMPARE_FILES: files("releases/beta/drafts/v2026.1012.1-beta.0.md") }, "true"],
  ["markdown outside releases", { TEST_COMPARE_FILES: files("doc/RELEASING.md") }, "true"],
  ["file entry without a name", { TEST_COMPARE_FILES: JSON.stringify([{ status: "modified" }]) }, "true"],
  ["empty diff", { TEST_COMPARE_FILES: "[]" }, "true"],
  ["possibly truncated file list", { TEST_COMPARE_FILES: manyReleaseNotes }, "true"],
  ["compare lookup failure", { TEST_COMPARE_FAIL: "1", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
  ["non-PR event", { EVENT_NAME: "workflow_dispatch", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
  ["malformed head SHA", { EVENT_HEAD_SHA: "invalid", TEST_COMPARE_FILES: files("releases/v2026.1015.0.md") }, "true"],
];

for (const [name, env, expected] of pathScopeCases) {
  test(`path scope decision: ${name}`, () => {
    assert.equal(executeStep("Select PR CI scope", {
      STACK_JSON: "null", PR_BASE_REF: "master", ...env,
    }).full_ci, expected);
  });
}

test("path scope keeps full CI for the top PR in a stack that touches code", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 11, size: 11, base: { ref: "master" } }),
    PR_BASE_REF: "stack-10",
  }).full_ci, "true");
});

test("path scope keeps full CI for release notes on top of code-changing stacked PRs", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 11, size: 11, base: { ref: "master" } }),
    PR_BASE_REF: "stack-10",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "true");
});

test("path scope keeps full CI for release notes with malformed stack metadata", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 0, size: 2, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "true");
});

test("path scope skips full CI for the lowest PR in a stack that only touches release notes", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 1, size: 3, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "false");
});

test("path scope skips full CI for a single-PR stack that only touches release notes", () => {
  assert.equal(executeStep("Select PR CI scope", {
    STACK_JSON: JSON.stringify({ position: 1, size: 1, base: { ref: "master" } }),
    PR_BASE_REF: "master",
    TEST_COMPARE_FILES: files("releases/v2026.1015.0.md"),
  }).full_ci, "false");
});

test("gate job unconditionally selects ubuntu-latest with CODEOWNERS comment", () => {
  const placement = jobs.match(/^ {4}runs-on: (.+)$/m)?.[1];
  assert.equal(placement, "ubuntu-latest", "gate runs-on must be static ubuntu-latest");
  assert.doesNotMatch(placement, /\$\{\{/);
  assert.match(jobs, /# No AWS capacity is allocated until current CI CODEOWNERS are verified\./);
  assert.match(jobs, /# A cached numeric allowlist alone can outlive removal from CODEOWNERS\./);
});

test("plan step falls back when full CI is not requested", () => {
  assert.deepEqual(executeStep("Plan affected CI tasks from trusted definitions", {
    FULL_CI: "false",
  }), { plan: "" });
});

test("plan step falls back when head SHA is invalid", () => {
  assert.deepEqual(executeStep("Plan affected CI tasks from trusted definitions", {
    FULL_CI: "true",
    EVENT_HEAD_SHA: "not-a-sha",
  }), { plan: "" });
});

test("plan step stays off outside the upstream repository", () => {
  assert.deepEqual(executeStep("Plan affected CI tasks from trusted definitions", {
    FULL_CI: "true",
    EVENT_REPOSITORY: "redesignhealth/paperclip",
  }), { plan: "" });
});

test("plan step stays off when the repository is unknown", () => {
  assert.deepEqual(executeStep("Plan affected CI tasks from trusted definitions", {
    FULL_CI: "true",
    EVENT_REPOSITORY: "",
  }), { plan: "" });
});
