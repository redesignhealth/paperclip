# Merge Gate Architecture & Operational Runbook (TECH-7014)

## Overview

The merge gate enforces two required check runs from the GitHub Actions application (App ID `15368`) on pull requests before merge:

1. **`ci-aggregate`**: Verifies that all CI workflows relevant to the pull request's changed files, branch targets, and labels have completed with a `success` conclusion.
2. **`argus-gate`**: Verifies that the centralized Argus code-review storage service contains an `APPROVE` verdict recorded for the pull request's exact current head commit SHA.

Both checks run under default-branch execution context via `workflow_run` (chained off `Merge Gate Trigger`, `PR`, `Docker Runner check`, and `Storybook Visual`) or manual `workflow_dispatch`. Untrusted code from pull requests is never checked out or executed.

---

## Operational Behavior & Lifecycle

### Triggers & Settle Window
- **`Merge Gate Trigger` (`.github/workflows/merge-gate-trigger.yml`)**:
  Fires on pull request events (`opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`, `unlabeled`) without path filtering. Holds a 30-second settle window to allow concurrently dispatched CI workflows to initialize before the Merge Gate sweeps. The `labeled` and `unlabeled` triggers ensure carrier events for label-gated CI workflows (such as `Storybook Visual`).
- **SHA-Preserving Carrier Events**:
  Events such as `ready_for_review`, `labeled`, and `unlabeled` are SHA-preserving: they re-evaluate the merge gate without altering the head commit SHA. Workflows that trigger strictly on code changes (such as `Storybook Visual` or `PR`) do not need to re-execute on these events; the gate re-evaluates previously completed runs for the current head SHA.
- **`Merge Gate` (`.github/workflows/merge-gate.yml`)**:
  Triggers on `workflow_run` completion across four chained workflows:
  - `Merge Gate Trigger`
  - `PR`
  - `Docker Runner check`
  - `Storybook Visual`
  Also supports manual re-trigger via `workflow_dispatch` with a required `pr_number` input and optional `sha`.
- **Pre-Success Settle & Re-sweep**:
  Before declaring `SUCCESS`, the aggregator waits 20 seconds and re-sweeps the GitHub Actions API up to 3 times to ensure no new workflows were dispatched in the interim, that the workflow set has not drifted, and that all observed workflows remain green.

### Concurrency Namespaces
The `Merge Gate` workflow defines distinct concurrency groups:
- `workflow_dispatch`: `merge-gate-pr-${{ inputs.pr_number }}`
- `workflow_run`: `merge-gate-sha-${{ github.event.workflow_run.head_sha }}`

These namespaces are intentionally disjoint. Per-SHA concurrency on `workflow_run` isolates gate evaluations per commit, ensuring concurrent pushes do not abort in-flight commit verifications, while per-PR concurrency on `workflow_dispatch` serializes manual developer re-checks for the same pull request.

### Check Run Lifecycle & Verification
1. Target PR and head SHA are resolved via canonical `.github/scripts/pr_resolve.py` using strict default-branch, fork, and head SHA validation.
2. **Pre-init Stale-HEAD Handling**: If a newer commit has landed on the pull request before initialization, the run exits cleanly as stale (`skip=true`) without creating or writing failing check runs.
3. On matching live HEAD, both `ci-aggregate` and `argus-gate` check runs are opened as `in_progress` before network evaluation begins. Check IDs are immediately persisted to `/tmp/merge_gate_checks.json`.
4. **Post-init Synchronize Race Handling**: If live HEAD moves during evaluation (detected by `--expected-sha` check in `path_filter.py`), the step aborts and the `always()` cleanup step marks open checks as `failure` (`ABORTED`), ensuring no stale conclusion is published for the wrong commit.
5. The classifier and aggregator evaluate CI runs, and Argus review storage is queried.
6. Check runs are concluded with `conclusion: success` or `conclusion: failure`.
7. An `always()` cleanup step ensures that any aborted run concludes open checks as `failure` (fail-closed).
8. A final terminal step re-verifies check run conclusions and fails the workflow job if either check did not conclude with `success`.

---

## Deterministic Path Classifier & Label Gating

`.github/scripts/path_filter.py` parses workflow definitions from the default branch:
- **Root-anchored matching**: Uses GitHub Actions-compatible glob matching (`**` for directory trees using segment-safe matching, `*` for segment characters, character classes `[...]` with negated classes `[^/...]` confined to path segments and safe hyphen escaping).
- **Leading & trailing slash normalization**: Leading slashes and `./` prefixes are normalized away; trailing directory slashes (e.g. `scripts/` or `scripts/**/`) normalize to directory subtree matches (`^scripts/.*$`), matching both direct and nested children.
- **Ordered branch filter evaluation**: Evaluates ordered branch patterns including negations (e.g. `['**', '!master']`). Workflows whose branch patterns exclude the default branch are classified as `NOT_APPLICABLE (branches_exclude_default)`, preventing deadlock without triggering unmodeled fallback.
- **Renamed file handling**: Evaluates both `filename` and `previous_filename` while reconciling collected entry counts to PR changed files metadata.
- **Unfiltered workflows**: Workflows without path filters (e.g. `PR`) are classified as `APPLICABLE (unfiltered)`.
- **Filtered workflows**: Evaluated against the PR's changed files list fetched from `/pulls/{number}/files`.
- **Indeterminate limit**: If a PR touches more than 300 files (`PATHS_FILTER_LIMIT`), filtered workflows fail-safe to `APPLICABLE (indeterminate_limit)`.
- **Zero changed files**: Unfiltered workflows remain applicable; filtered workflows are `NOT_APPLICABLE`.
- **Documentation-only changes**: For changes affecting only documentation, `PR` runs as an unfiltered check while filtered workflows (`Docker Runner check`) are classified as not applicable.

### Label-Gated Workflow Handling (`Storybook Visual`)
In `paperclip`, `Storybook Visual` is an on-demand visual regression workflow gated by the `storybook-visual` PR label (`contains(github.event.pull_request.labels.*.name, 'storybook-visual')`). To ensure deterministic coverage without deadlocks:
1. `Merge Gate Trigger` carries `labeled` and `unlabeled` pull request events so adding/removing labels re-evaluates the merge gate.
2. `Storybook Visual` is registered in `workflow_run.workflows` in `merge-gate.yml`.
3. `path_filter.py` models its applicability based on live PR labels: when the `storybook-visual` label is present, it is classified as applicable and required to succeed; when absent, it is classified as not applicable (`label_not_present`).
4. **Classifier-Aware Aggregation**: In `ci_aggregate.py`, workflows classified as `label_not_present` are partitioned:
   - Non-failing completed runs (`success`, `skipped`, `neutral`) are ignored.
   - Non-completed runs (`in_progress`, `queued`, `waiting`) are ignored so they never deadlock.
   - Completed non-success runs (`failure`, `cancelled`, `timed_out`, etc.) are retained as failures for the current head SHA.
5. **Label Failure Retention & Operator Remedy**:
   - Removing a label after a failed workflow run does NOT clear the failure for that commit SHA; the failure is retained to prevent bypassing failed checks by simply untagging labels.
   - **Operator Remedy**: If a label-gated workflow failed for the current head SHA, operators can:
     a) Re-add the label, fix the underlying issue, and re-run the workflow until it passes on that SHA; or
     b) Push a new commit to the PR without the label (since failure retention is scoped strictly to the commit SHA where the failure occurred).
6. Other non-applicable runs that are skipped are safely ignored; however, any unexpected active run for a non-applicable workflow triggers `CLASSIFIER_DRIFT` failure. Unknown workflows remain strictly fail-closed: any completed unknown workflow - even if successful - is treated as classifier/workflow-set drift.
7. **Set Transport**: In production, the gate workflow uses `--classification-file /tmp/path_filter.json` to transport sets directly via structured JSON, eliminating shell quoting and delimiter ambiguities. Legacy comma-delimited CLI flags are deprecated because comma delimiters cannot safely represent workflow names containing embedded commas.

---

## Public-Log Safety & Masking

To prevent secret exposure in public workflow logs and check summaries:
- **SSM Secret Retrieval**: The API secret key `/general/prod/api-secret-key` is fetched with `--with-decryption` and immediately masked with `::add-mask::`.
- **Secure File Creation (`umask 077`)**: The temporary curl configuration file and diagnostic logs are created in an ephemeral directory (`mktemp -d`) with `umask 077` and deleted on EXIT via trap, preventing process or filesystem snooping on shared runners.
- **Diagnostic Logging**: Stderr from `aws ssm get-parameter` is captured privately to a log file; sanitized summary diagnostics are emitted via workflow warnings without exposing credentials.
- **Review Prose Suppression**: Argus storage response bodies and review prose are never echoed to standard output or workflow logs.
- **Summary Sanitization**: Public logs and check run annotations output only structured machine-readable reason codes (e.g. `EXACT_HEAD_APPROVE`, `VERDICT_BLOCKING`, `INVALID_VERDICT_ENUM`, `NON_TERMINAL_ROUND`, `ALL_GREEN`, `ACTION_REQUIRED`) and actionable unblock instructions. Raw unexpected strings from responses are never interpolated into public output.

---

## Pending Approvals & Bounded Recovery

- **Evaluation Priority Order**:
  `ACTION_REQUIRED > NON_SUCCESS_CONCLUSION > CLASSIFIER_DRIFT > MISSING_APPLICABLE_RUNS > RUN_IN_PROGRESS (PENDING) > ALL_GREEN`.
- **Actionable Failures**: If any workflow is awaiting human approval (`status: waiting`) or requires action (`conclusion: action_required`), `ci-aggregate` fails immediately with actionable guidance. When approved and completed, `workflow_run` automatically re-evaluates the merge gate.
- **Bounded In-Progress Polling**: In-progress runs are polled every 15 seconds up to a monotonic deadline (`pending_timeout_s = 300`). If workflows remain in-progress when the deadline expires, the check concludes with terminal failure `PENDING_TIMEOUT`.
- **Bounded Settle Re-sweeps**: Before declaring success, the aggregator performs up to 3 settle re-sweeps (`max_settle_resweeps = 3`, 20s interval). If the workflow set continuously drifts without stabilizing, the check concludes with terminal failure `WORKFLOW_SET_DRIFT_TIMEOUT`.
- **Recovery Path**: If a check terminates with `PENDING_TIMEOUT` or `WORKFLOW_SET_DRIFT_TIMEOUT`, developers can recover by manually re-triggering the gate via **Actions -> Merge Gate -> Run workflow** (providing `pr_number`) once runs finish, or by pushing a new commit.

---

## Merge Conflicts & Synchronize Races

- **Merge Conflicts**: Pull requests with merge conflicts or dirty rebase states cannot be merged by GitHub. When a developer pushes a rebased or merge commit to resolve conflicts, the new head commit SHA triggers `Merge Gate Trigger`, invalidating any prior SHA-specific Argus approval and starting a fresh gate cycle.
- **Synchronize Race Protection**: The path classifier compares the live PR head SHA against the expected SHA at job start (`--expected-sha`). If a push occurs mid-run, the classifier aborts the stale invocation before conclusions can be published for the wrong commit.

---

## External Action Pin Mapping

All external actions in `.github/workflows/merge-gate.yml` are pinned to immutable 40-character commit SHAs with semantic tag annotations:

| Action | Pinned Commit SHA | Target Tag | Resolution Details |
|---|---|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | `v4.2.2` | Lightweight tag resolving directly to commit SHA. |
| `aws-actions/configure-aws-credentials` | `e3dd6a429d7300a6a4c196c26e071d42e0343502` | `v4.0.2` | Annotated tag `refs/tags/v4.0.2^{}` dereferenced commit object. |
| `actions/github-script` | `60a0d83039c74a4aee543508d2ffcb1c3799cdea` | `v7.0.1` | Commit SHA for v7.0.1 release tag. |

Dependencies installed in runner environments pin `pyyaml==6.0.2`.

---

## Argus Reviewer Configuration (`.argus/bench.toml`)

The repository root includes `.argus/bench.toml`, which configures the review model platform and alias for Argus code reviews. In accordance with platform policy:
- **Durable Review Signoff Record**:
  - Reviewer: Dan Costanza (`@dancostanza`)
  - Date: 2026-10-01
  - Approved configuration triple in `.argus/bench.toml`:
    - `platform = "gemini"`
    - `model = "gemini-mini"`
     - `caching = "auto"`
  - Model alias `gemini-mini` canonically resolves to `gemini-3.8-flash` in the Argus platform model registry.
- `.github/CODEOWNERS` covers `.argus/**` matching the maintainer set (`@cryppadotta @devinfoley @nickyleach @forgottendev`). CODEOWNERS maintenance and Argus self-config review preflight signoff are separate controls. CODEOWNERS is advisory until a live ruleset enables enforcement; it does not imply a required human review count, configure branch protection, or claim bench signoff is complete.

---

## Gate Reason Codes & Nonsecret IAM Identifiers

### Check Run Reason Codes

| Check Run | Reason Code | Status | Meaning |
|---|---|---|---|
| `ci-aggregate` | `ALL_GREEN` | SUCCESS | All applicable CI workflows completed successfully. |
| `ci-aggregate` | `ZERO_RUNS_APPLICABLE` | SUCCESS | No CI workflows applicable for this change (e.g. documentation-only changes) and none observed. |
| `ci-aggregate` | `RUN_IN_PROGRESS` | PENDING | Applicable or non-applicable CI workflows are actively executing (`status: in_progress/queued`). |
| `ci-aggregate` | `ACTION_REQUIRED` | FAILURE | CI workflow requires human approval or manual intervention (`waiting` or `action_required`). |
| `ci-aggregate` | `NON_SUCCESS_CONCLUSION` | FAILURE | Applicable workflow or retained label-removed workflow run finished with a non-success conclusion (`failure`, `cancelled`, `timed_out`, etc.). |
| `ci-aggregate` | `CLASSIFIER_DRIFT` | FAILURE | Non-applicable workflow ran with non-skipped conclusion, or unknown completed workflow detected. |
| `ci-aggregate` | `MISSING_APPLICABLE_RUNS` | FAILURE | One or more applicable workflows have not executed for this head SHA. |
| `ci-aggregate` | `PENDING_TIMEOUT` | FAILURE | Timed out waiting for in-progress workflows to complete (`pending_timeout_s = 300`). |
| `ci-aggregate` | `WORKFLOW_SET_DRIFT_TIMEOUT` | FAILURE | Workflow set continuously drifted during settle window without stabilizing (`max_settle_resweeps = 3`). |
| `ci-aggregate` | `ABORTED` | FAILURE | Merge Gate step failed or was aborted before conclusion (fail-closed). |
| `ci-aggregate` | `VALIDATION_FAILED` | FAILURE | Workflow dispatch validation failed (closed PR, base branch mismatch, or invalid SHA). |
| `ci-aggregate` | `BOOTSTRAP_FAILURE` | FAILURE | Merge Gate failed during bootstrap before check runs were initialized. |
| `argus-gate` | `EXACT_HEAD_APPROVE` | SUCCESS | Argus recorded an APPROVE verdict for the exact PR head SHA in its newest completed review round. |
| `argus-gate` | `MISSING_REVIEW` | FAILURE | No Argus reviews exist for this pull request. |
| `argus-gate` | `STALE_REVIEW` | FAILURE | No Argus review records match the current exact head SHA. |
| `argus-gate` | `VERDICT_BLOCKING` | FAILURE | Argus recorded a BLOCKING verdict on this head SHA. |
| `argus-gate` | `NON_TERMINAL_ROUND` | FAILURE | Latest Argus review round is still in progress or not in `completed` stage. |
| `argus-gate` | `INVALID_VERDICT_ENUM` | FAILURE | Argus returned an unapproved or unrecognized verdict string. |
| `argus-gate` | `MISSING_OR_MALFORMED_TIMESTAMP` | FAILURE | Argus review lacks a valid authoritative ISO-8601 timestamp. |
| `argus-gate` | `MALFORMED_DATA` | FAILURE | Review storage returned non-JSON or invalid schema (expected canonical `{'rounds': [...]}`). |
| `argus-gate` | `EMPTY_SHA` / `INVALID_INPUT` | FAILURE | Head SHA is empty, malformed, or not strict 40-hex. |
| `argus-gate` | `CREDENTIALS_UNAVAILABLE` | FAILURE | AWS IAM role secret not configured. |
| `argus-gate` | `SSM_FETCH_FAILED` | FAILURE | Failed to retrieve API secret key from SSM Parameter Store. |
| `argus-gate` | `STORAGE_API_HTTP_*` | FAILURE | Argus storage endpoint returned non-200 HTTP code. |
| `argus-gate` | `EVALUATOR_CRASH` | FAILURE | Argus verdict evaluator crashed or emitted invalid output. |

### Nonsecret IAM Identifiers

- **Companion IAM Role**: `rh-argus-gate-3` in `redesignhealth/rh-data-platform#10081` (AWS Region: `us-east-1`).
- **SSM Parameter Path**: `/general/prod/api-secret-key` (SSM Parameter Store).
- **Repository Secret Name**: `AWS_ROLE_ARN_ARGUS_GATE`.

---

## Residual Risks

1. **PR Workflow Modification**:
   A pull request could modify workflow files in its own branch to disable checks. This is mitigated because `Merge Gate` runs exclusively from the default branch via `workflow_run`, parsing only default-branch workflow definitions. Additionally, Argus review reviews the entire PR diff and flags any weakening of CI or tests.
2. **Upstream Mutable Refs in Paperclip**:
   In `paperclip`, `pr.yml` references `paperclipai/paperclip/.github/workflows/pr-trusted.yml@master` (a mutable branch ref on the upstream repo). Any upstream change to `@master` takes effect on subsequent runs.
3. **IAM Secret Dependency**:
   Until the companion IAM role `rh-argus-gate-3` provisioned in `redesignhealth/rh-data-platform` is applied and the repository secret `AWS_ROLE_ARN_ARGUS_GATE` is populated, the `argus-gate` check will fail closed (`CREDENTIALS_UNAVAILABLE`).
4. **Truthful CODEOWNERS Interim Risk**:
   While `.github/CODEOWNERS` assigns `.argus/**` to `@cryppadotta @devinfoley @nickyleach @forgottendev`, branch protection rules requiring review from Code Owners are not yet active or enforced in branch protection for this repository in this PR. CODEOWNERS serves as an explicit attribution and audit record rather than an enforced branch protection gate until required reviews from Code Owners are administratively enabled.

---

## Live Gate Enablement Status

**Branch rulesets and required status checks are NOT enabled in this PR.**
The gate workflows and check publishers are deployed first to allow end-to-end verification without deadlocking active development. Branch protection rules will be applied in a coordinated administrative step once live runs succeed.
