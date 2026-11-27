# Machine merge policy

This repository uses a two-check merge policy for eligible pull requests. The policy is an
operator contract; the live ruleset and workflow runs must be verified before treating a pull
request as machine-approved.

## Required checks

- **`argus-gate`** must report `APPROVE` for the exact pull request and exact current head SHA.
  The newest completed Argus result is authoritative; missing, stale, malformed, revoked, or
  API-error data fails closed.
- **`ci-aggregate`** must report successful trusted CI for the exact current head SHA. It selects
  workflows from the trusted default-branch definitions and requires the selected run and jobs to
  succeed. Intentional skips are allowed only where the workflow defines them.

The checks are expected to be emitted by the RH PR Approval Gate App (`5166579`). A generic Actions
check is not equivalent. The gate may use PR metadata to support fork-based changes; that does not
make arbitrary commit SHAs, arbitrary workflows, or all fork credentials trusted. Qualification
comes from the verified PR, canonical workflow and head-SHA checks described above.

## Activation and current review guard

Activation is an administrative ruleset change, not an application deployment. Read the complete
live ruleset, add the App-bound checks, and preserve all unrelated repository policy. In particular,
preserve the existing repository-admin bypass actor (repository role 5, always); do not add a new
bypass, grant a new privilege, or enable an automatic merge or merge queue.

Human review remains the fallback until the App checks have been proven against positive, negative,
wrong-App, outage, revocation, and fork-SHA cases. Keep the current human requirement in place
while those checks are being validated. A temporary human-approved bootstrap is not evidence that
the machine gate is live.

## Factory auto-merge exception (TECH-11016)

The code factory's own pull requests merge without a person. This is the one narrow exception to
"do not enable an automatic merge". It is not the GitHub auto-merge setting (that stays off) and not
a merge queue: the `Factory Auto-Merge` workflow (`.github/workflows/factory-auto-merge.yml`) merges a
pull request with its own `GITHUB_TOKEN` only when all of these hold, and the ruleset stays fully in
force as the backstop (the workflow is not a bypass actor):

- the head branch is `factory/...` in this repository, the author is `rh-code-factory[bot]`, and the
  base is `master`;
- `argus-gate` and `ci-aggregate` are both green at the exact head SHA and were published by the
  RH PR Approval Gate App (`5166579`); a same-named check from another app does not count;
- the pull request is not a draft, its merge state is clean, and it touches none of the hold-list
  paths: anything under `.github/`, migrations and schema, auth and secrets code, release and image
  files (`docker/`, Dockerfiles, `releases/`, `skills-releases/`, `scripts/release*`), lockfiles,
  `pnpm-workspace.yaml`, env files, CODEOWNERS, `patches/`, `tools/upstream-sync/`, `FORK_OWNED.md`
  and this document. A person merges those.

Upstream-sync pull requests (`factory/sync...` and `factory/upstream-sync...`) are never merged by
it: they need merge commits, and the workflow always squashes. A merge made with `GITHUB_TOKEN` does
not start push-triggered workflows on `master` (no lockfile refresh, canary or image for that merge).

Operating it: set the repository variable `FACTORY_AUTO_MERGE_DISABLED` to `true` to stop all factory
merges at once. Dispatch the workflow with `dry_run=true` (and optionally `pr_number`) to see its
decisions without merging. Everything in this document about people's pull requests, the human
fallback, and rollback is unchanged.

## Rollback and boundary

If the machine gate is unavailable or disputed, set `FACTORY_AUTO_MERGE_DISABLED=true` and restore the human-review requirement first, then
investigate the App or CI path. Do not bypass branch protection or approve under another person's
credentials. This policy does not deploy infrastructure, change IAM, alter application behavior,
or claim that a green Argus-store record is a cryptographic attestation of execution.

The implementation must be checked against the live repository and workflow behavior before
publication of an activation receipt. Documentation of the intended contract must not be treated as
proof that every trusted path is implemented or currently enabled.
