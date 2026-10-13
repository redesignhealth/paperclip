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

## Rollback and boundary

If the machine gate is unavailable or disputed, restore the human-review requirement first, then
investigate the App or CI path. Do not bypass branch protection or approve under another person's
credentials. This policy does not deploy infrastructure, change IAM, alter application behavior,
or claim that a green Argus-store record is a cryptographic attestation of execution.

The implementation must be checked against the live repository and workflow behavior before
publication of an activation receipt. Documentation of the intended contract must not be treated as
proof that every trusted path is implemented or currently enabled.
