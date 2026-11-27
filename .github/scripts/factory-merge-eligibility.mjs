/**
 * Eligibility check for factory auto-merge (.github/workflows/factory-auto-merge.yml,
 * TECH-11016, rolled out from rh-data-platform's TECH-9802). Pure function: the workflow
 * gathers PR facts and this decides.
 *
 * A PR is merged automatically ONLY if every condition holds. Anything else is left alone
 * (`action: "skip"`), left for a person with a comment (`action: "hold"`), or retried on the
 * next run (`action: "retry"`).
 *
 * Ownership needs ALL of: a `factory/` head branch in this repository, an author that is the
 * rh-code-factory GitHub App, and a base of master. Everything else is never touched.
 *
 * "Argus APPROVE at the head commit" and "CI green" are read from the `argus-gate` and
 * `ci-aggregate` check runs published by the RH PR Approval Gate App (5166579). Those checks
 * are the repo's required checks (ruleset "master: human review (bootstrap)"); the gate
 * publishes `argus-gate` success only for a service-run Argus APPROVE at the exact head SHA
 * (docs/merge-policy.md). A same-named check from any other app is ignored, so a forged check
 * cannot make a PR eligible.
 */

export const FACTORY_BOT_LOGIN = "rh-code-factory[bot]";
export const FACTORY_BRANCH_PREFIX = "factory/";
export const BASE_BRANCH = "master";
export const GATE_APP_ID = 5166579;
export const REQUIRED_CHECKS = ["argus-gate", "ci-aggregate"];

// Upstream-sync PRs must land as merge commits (squash would drop upstream ancestry and make
// every later sync conflict). This workflow always squashes, so a person (or a merge-commit
// path) handles them.
const SYNC_BRANCH = /^factory\/(upstream-)?sync([/-]|$)/i;

// Paths a person must merge: CI and workflow definitions, migrations and schema, auth and
// secrets code, release and image files, dependency lockfile, fork bookkeeping, sync tooling.
export const HOLD_PATH_PATTERNS = [
  // All of .github/: workflows, actions and the gate scripts themselves. A factory PR must
  // never change the rules that decide whether it merges.
  /^\.github\//,
  /(^|\/)(migrations?|drizzle)\//i,
  /^packages\/db\/src\/(migrations|schema)\//,
  /(^|\/)(auth|secrets?)([-_][^/]*)?\//i,
  /(^|\/)(auth|authn|authz|oauth|okta|secrets?)[^/]*\.(py|ts|tsx|js|mjs|cjs|json|ya?ml|sql)$/i,
  /(^|\/)Dockerfile[^/]*$/,
  /^docker\//,
  /^releases?\//,
  /^skills-releases\//,
  /^scripts\/release[^/]*$/,
  /^patches\//,
  /^tools\/upstream-sync\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^FORK_OWNED\.md$/,
  /^docs\/merge-policy\.md$/,
];

export function holdPaths(files) {
  return files.filter((f) => HOLD_PATH_PATTERNS.some((re) => re.test(f)));
}

export function isFactoryOwned(pr, repoFullName) {
  const headRef = pr?.head?.ref ?? "";
  return (
    headRef.startsWith(FACTORY_BRANCH_PREFIX) &&
    pr?.user?.login === FACTORY_BOT_LOGIN &&
    pr?.user?.type === "Bot" &&
    pr?.head?.repo?.full_name === repoFullName &&
    pr?.base?.ref === BASE_BRANCH
  );
}

/**
 * Every required check must have a completed `success` run at the head SHA from the gate App,
 * and the newest such run (a revocation publishes a newer one) must be that success.
 */
export function gateChecksGreen(checkRuns, required = REQUIRED_CHECKS, appId = GATE_APP_ID) {
  return required.every((name) => {
    const runs = (checkRuns ?? [])
      .filter((c) => c.name === name && c.app?.id === appId)
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    if (runs.length === 0) return false;
    const newest = runs[0];
    return newest.status === "completed" && newest.conclusion === "success";
  });
}

/**
 * @param {object} input
 * @param {object} input.pr          GitHub PR object (pulls.get)
 * @param {string} input.repo        "owner/name"
 * @param {string[]} input.files     changed file paths (including previous names of renames)
 * @param {object[]} input.checkRuns check runs for the head SHA
 * @param {boolean} input.disabled   global off switch (FACTORY_AUTO_MERGE_DISABLED=true)
 * @returns {{action: "merge"|"skip"|"hold"|"retry", reason: string, paths?: string[]}}
 */
export function evaluateFactoryPr({ pr, repo, files, checkRuns, disabled }) {
  if (disabled) return { action: "skip", reason: "off switch is on" };
  if (!isFactoryOwned(pr, repo)) return { action: "skip", reason: "not a factory-owned PR" };
  if (pr.state !== "open" || pr.merged) return { action: "skip", reason: "not open" };
  if (pr.draft) return { action: "skip", reason: "draft" };
  if (SYNC_BRANCH.test(pr.head.ref)) {
    return { action: "skip", reason: "upstream-sync PR: needs a merge commit, a person merges" };
  }

  const held = holdPaths(files);
  if (held.length > 0) {
    return { action: "hold", reason: "touches hold-list paths", paths: held };
  }

  if (!gateChecksGreen(checkRuns)) {
    return { action: "skip", reason: "argus-gate and ci-aggregate not both green from the gate App at head SHA" };
  }

  // Merge state is computed lazily by GitHub. Unknown means retry, not skip.
  if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeable_state === "unknown") {
    return { action: "retry", reason: "merge state unknown" };
  }
  if (pr.mergeable === false || pr.mergeable_state === "dirty") {
    return { action: "skip", reason: "merge conflicts" };
  }
  if (pr.mergeable_state === "behind" || pr.mergeable_state === "blocked") {
    return { action: "skip", reason: `merge state ${pr.mergeable_state}` };
  }
  return { action: "merge", reason: "all conditions hold", paths: [] };
}
