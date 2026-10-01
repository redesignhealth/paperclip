# Merge Gate Architecture & Operational Runbook (TECH-7014)

## Overview

The merge gate enforces two required check runs from the GitHub Actions application (App ID `15368`) on pull requests before merge:

1. **`ci-aggregate`**: Verifies that all CI workflows relevant to the pull request's changed files have completed with a `success` conclusion.
2. **`argus-gate`**: Verifies that the centralized Argus code-review storage service contains an `APPROVE` verdict recorded for the pull request's exact current head commit SHA.

Both checks run under default-branch execution context via `workflow_run` (chained off `Merge Gate Trigger` and repo CI workflows) or manual `workflow_dispatch`. Untrusted code from pull requests is never checked out or executed.

---

## Operational Behavior & Lifecycle

### Triggers & Settle Window
- **`Merge Gate Trigger` (`.github/workflows/merge-gate-trigger.yml`)**:
  Fires on pull request events (`opened`, `synchronize`, `reopened`, `ready_for_review`) without path filtering. Holds a 30-second settle window to allow any path-filtered CI workflows to be dispatched concurrently before exiting.
- **`Merge Gate` (`.github/workflows/merge-gate.yml`)**:
  Triggers on `workflow_run` completion of `Merge Gate Trigger` or any of the repository's PR CI workflows (`PR`, `Docker Runner check`). Also supports manual re-trigger via `workflow_dispatch` with a `pr_number` input.
- **Pre-Success Settle & Re-sweep**:
  Before declaring `SUCCESS`, the aggregator waits 20 seconds and re-sweeps the GitHub Actions API to ensure no new workflows were dispatched in the interim and that all observed workflows remain green.

### Check Run Lifecycle
Upon invocation, `Merge Gate` resolves the exact live PR head SHA:
- If a newer commit has already landed on the PR (`workflow_run.head_sha != pr.head.sha`), the invocation exits cleanly as a skipped stale run without posting failing checks.
- On matching HEAD, it immediately publishes both `ci-aggregate` and `argus-gate` check runs with `status: in_progress`.
- Once evaluations complete, the checks are updated to `conclusion: success` or `conclusion: failure`.
- An `always()` cleanup step ensures that any aborted, timed out, or unhandled errors conclude the check runs with `conclusion: failure` (fail-closed).

---

## Deterministic Path Classifier

`.github/scripts/path_filter.py` parses workflow definitions from the default branch:
- **Root-anchored matching**: Uses GitHub Actions-compatible glob matching (`**` for recursive directories, `*` for segment characters, character classes `[...]`).
- **Unfiltered workflows**: Workflows without path filters (e.g. `PR`) are classified as `APPLICABLE (unfiltered)`.
- **Filtered workflows**: Evaluated against the PR's changed files list fetched from `/pulls/{number}/files`.
- **Indeterminate limit**: If a PR touches more than 300 files (`PATHS_FILTER_LIMIT`), filtered workflows fail-safe to `APPLICABLE (indeterminate_limit)`.
- **Zero changed files**: Unfiltered workflows remain applicable; filtered workflows are `NOT_APPLICABLE`.
- **Documentation-only changes**: For changes affecting only documentation, `PR` runs as an unfiltered check while filtered workflows (`Docker Runner check`) are classified as not applicable.

---

## Public-Log Safety & Masking

To prevent secret exposure in public workflow logs and check summaries:
- **SSM Secret Retrieval**: The API secret key `/general/prod/api-secret-key` is fetched with `--with-decryption` and immediately masked with `::add-mask::`.
- **Out-of-Process Argv Protection**: The API key is passed to `curl` via a temporary configuration file (`-K <config>`) mode `0600` and deleted immediately, keeping secret material out of `/proc` and process argument lists (`argv`).
- **Review Prose Suppression**: Argus storage response bodies and review prose are never echoed to standard output or workflow logs.
- **Summary Sanitization**: Public logs and check run annotations output only structured machine-readable reason codes (e.g. `EXACT_HEAD_APPROVE`, `MISSING_REVIEW`, `STALE_REVIEW`, `ALL_GREEN`, `ACTION_REQUIRED`) and actionable unblock instructions.

---

## Pending Approvals & Self-Healing

- If any workflow is awaiting human approval (`status: waiting`) or requires action (`conclusion: action_required`), `ci-aggregate` fails with actionable guidance.
- When an authorized reviewer approves the environment/job in GitHub Actions, the workflow resumes and finishes. Its completion triggers `workflow_run`, automatically re-evaluating the merge gate without requiring manual developer re-dispatch.

---

## Merge Conflicts

Pull requests with merge conflicts or dirty rebase states cannot be merged by GitHub. When a developer pushes a rebased or merge commit to resolve conflicts, the new head commit SHA triggers `Merge Gate Trigger`, invalidating any prior SHA-specific Argus approval and starting a fresh gate cycle.

---

## External Action Pin Mapping

All external actions in `.github/workflows/merge-gate.yml` are pinned to immutable 40-character commit SHAs with semantic tag annotations:

| Action | Pinned Commit SHA | Target Tag | Resolution Details |
|---|---|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | `v4.2.2` | Lightweight tag resolving directly to commit SHA. |
| `aws-actions/configure-aws-credentials` | `e3dd6a429d7300a6a4c196c26e071d42e0343502` | `v4.0.2` | Annotated tag `refs/tags/v4.0.2^{}` dereferenced commit object. |

Dependencies installed in runner environments pin `pyyaml==6.0.2`.

---

## Residual Risks

1. **PR Workflow Modification**:
   A pull request could modify workflow files in its own branch to disable checks. This is mitigated because `Merge Gate` runs exclusively from the default branch via `workflow_run`, parsing only default-branch workflow definitions. Additionally, Argus review reviews the entire PR diff and flags any weakening of CI or tests.
2. **Upstream Mutable Refs in Paperclip**:
   In `paperclip`, `pr.yml` references `paperclipai/paperclip/.github/workflows/pr-trusted.yml@master` (a mutable branch ref on the upstream repo). Any upstream change to `@master` takes effect on subsequent runs.
3. **IAM Secret Dependency**:
   Until the companion IAM role `rh-argus-gate-3` provisioned in `redesignhealth/rh-data-platform` is applied and the repository secret `AWS_ROLE_ARN_ARGUS_GATE` is populated, the `argus-gate` check will fail closed (`CREDENTIALS_UNAVAILABLE`).

---

## Live Gate Enablement Status

**Branch rulesets and required status checks are NOT enabled in this PR.**
The gate workflows and check publishers are deployed first to allow end-to-end verification without deadlocking active development. Branch protection rules will be applied in a coordinated administrative step once live runs succeed.
