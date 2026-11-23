// `check`: run the gate's checks locally, after every step including clean ones (condition 3 of the sync go
// decision, TECH-9825). A merge that applies cleanly can still be wrong, so a clean step gets the same checks.
//   1. lockfile    pnpm-lock.yaml is unchanged from master (CI owns lockfile updates)
//   2. generated   every generator the step could affect is re-run; any difference from the committed file fails
//   3. convergent  both sides made the same numeric edit (the trial's wrong-but-clean merges); their tests are forced in
//   4. typecheck   the workspace typecheck
//   5. tests       the step's changed tests, sibling tests of changed sources, and tests that mention a convergent file
// The model never edits generated files: a hand edit differs from generator output, so step 2 fails it.
import { parseArgs } from "../lib/args.mjs";
import { git, gitOut, isWorkingTreeClean, revParse } from "../lib/git.mjs";
import { convergentNumericEdits } from "../lib/convergent.mjs";
import { BUILD_COMMAND, GENERATORS, generatorIsAffected } from "../lib/mechanical.mjs";
import { runArgv, runShell, shq, tail } from "../lib/shell.mjs";
import { changedInStep, selectTests } from "../lib/testselect.mjs";

export const CHECK_FLAGS = { boolean: ["json", "keepGoing", "generated"] };

const step = (name, status, detail = "") => ({ name, status, detail });

function mergesSince(cwd, since, head) {
  if (!since) return [head];
  return gitOut(cwd, ["rev-list", "--merges", "--first-parent", `${since}..${head}`], { allowFail: true })
    .split("\n")
    .filter(Boolean);
}

function checkLockfile(cwd, masterRev) {
  if (!masterRev) return step("lockfile", "skip", "master ref not resolvable");
  const r = git(cwd, ["diff", "--quiet", masterRev, "HEAD", "--", "pnpm-lock.yaml"], { allowFail: true });
  return r.status === 0
    ? step("lockfile", "pass")
    : step("lockfile", "fail", "pnpm-lock.yaml differs from master. A PR must not edit it; restore master's copy.");
}

function checkGenerated(cwd, changed, buildCmd) {
  const affected = GENERATORS.filter((g) => generatorIsAffected(g, changed));
  if (affected.length === 0) return step("generated", "pass", "no generator affected");
  const problems = [];
  const statusOf = () =>
    git(cwd, ["status", "--porcelain", "-z"], { allowFail: true })
      .stdout.split("\0")
      .filter(Boolean)
      .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  const untrackedBefore = new Set(statusOf().filter((d) => d.code === "??").map((d) => d.path));
  if (affected.some((g) => g.build)) {
    const built = buildCmd ? runShell(cwd, buildCmd) : runArgv(cwd, BUILD_COMMAND);
    if (!built.ok) return step("generated", "fail", `build before generators failed:\n${tail(built.output)}`);
  }
  for (const g of affected) {
    for (const argv of g.commands) {
      const r = runArgv(g.cwd === "." ? cwd : `${cwd}/${g.cwd}`, argv);
      if (!r.ok) {
        problems.push(`generator ${g.id} failed (${argv.join(" ")}):\n${tail(r.output, 1500)}`);
        break;
      }
    }
  }
  // Files that already sat untracked before the generators ran are not ours to judge or delete.
  const dirty = statusOf().filter((d) => !(d.code === "??" && untrackedBefore.has(d.path)));
  for (const d of dirty) problems.push(`stale generated file ${d.path}: it differs from generator output; regenerate it, never edit it`);
  // Leave the tree as found: the check must not mutate what it checks.
  if (dirty.length > 0) {
    git(cwd, ["checkout", "--", ...dirty.filter((d) => d.code !== "??").map((d) => d.path)], { allowFail: true });
    for (const d of dirty.filter((x) => x.code === "??")) git(cwd, ["clean", "-fdq", "--", d.path], { allowFail: true });
  }
  return problems.length ? step("generated", "fail", problems.join("\n")) : step("generated", "pass", `${affected.map((g) => g.id).join(", ")} match`);
}

/** Returns { ok, steps, risks, tests }. `opts`: since, master, typecheckCmd, testCmd, keepGoing, generated. */
export function runCheck(cwd, opts = {}) {
  const head = revParse(cwd, "HEAD");
  const steps = [];
  const out = (ok) => ({ ok, head, since: opts.since ?? "HEAD^1", steps, risks, tests });
  const risks = [];
  let tests = { nodeTest: [], vitest: [] };

  if (!isWorkingTreeClean(cwd)) {
    steps.push(step("worktree", "fail", "tracked files have uncommitted changes; commit them before check"));
    return out(false);
  }
  const since = opts.since ?? (revParse(cwd, "HEAD^1") ? "HEAD^1" : null);
  const changed = since ? changedInStep(cwd, head, since) : [];

  const masterRev = revParse(cwd, opts.master || process.env.UPSTREAM_SYNC_MASTER_REF || "origin/master");
  steps.push(checkLockfile(cwd, masterRev));

  if (opts.generated !== false) steps.push(checkGenerated(cwd, changed, opts.buildCmd));
  else steps.push(step("generated", "skip", "disabled"));

  const convergent = mergesSince(cwd, opts.since && opts.since !== "HEAD^1" ? opts.since : null, head).flatMap((m) =>
    convergentNumericEdits(cwd, m),
  );
  for (const c of convergent) {
    risks.push(`both sides made the same numeric edit at ${c.file}:${c.line} ("${c.from}" -> "${c.to}"); git merged it clean, the right value may be different`);
  }
  steps.push(step("convergent", "pass", convergent.length ? `${convergent.length} risk(s); their tests are forced in` : "none"));

  const failedSoFar = () => steps.some((s) => s.status === "fail");
  const heavy = (name, fn) => {
    if (failedSoFar() && !opts.keepGoing) steps.push(step(name, "skip", "an earlier check failed"));
    else steps.push(fn());
  };

  heavy("typecheck", () => {
    const line = opts.typecheckCmd ?? process.env.UPSTREAM_SYNC_TYPECHECK_CMD ?? "pnpm typecheck";
    const r = runShell(cwd, line);
    return r.ok ? step("typecheck", "pass") : step("typecheck", "fail", tail(r.output));
  });

  tests = selectTests(cwd, changed, convergent);
  heavy("tests", () => {
    const total = tests.nodeTest.length + tests.vitest.length;
    if (total === 0) return step("tests", "pass", "no tests selected");
    const override = opts.testCmd ?? process.env.UPSTREAM_SYNC_TEST_CMD;
    const runs = override
      ? [`${override} ${[...tests.nodeTest, ...tests.vitest].map(shq).join(" ")}`]
      : [
          tests.vitest.length ? `pnpm exec vitest run --passWithNoTests ${tests.vitest.map(shq).join(" ")}` : null,
          tests.nodeTest.length ? `node --test ${tests.nodeTest.map(shq).join(" ")}` : null,
        ].filter(Boolean);
    for (const line of runs) {
      const r = runShell(cwd, line);
      if (!r.ok) return step("tests", "fail", tail(r.output));
    }
    return step("tests", "pass", `${total} test file(s)`);
  });

  return out(!failedSoFar());
}

export function formatCheck(result) {
  const lines = [`check of ${result.head.slice(0, 10)} (changes since ${result.since}): ${result.ok ? "PASS" : "FAIL"}`];
  for (const s of result.steps) lines.push(`  ${s.status.toUpperCase().padEnd(4)} ${s.name}${s.detail ? `: ${s.detail.split("\n")[0]}` : ""}`);
  for (const r of result.risks) lines.push(`  RISK ${r}`);
  for (const s of result.steps.filter((x) => x.status === "fail" && x.detail.includes("\n"))) {
    lines.push(`--- ${s.name} output ---`, s.detail);
  }
  return lines.join("\n");
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts } = parseArgs(argv, CHECK_FLAGS);
  const result = runCheck(cwd, opts);
  stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCheck(result)}\n`);
  return result.ok ? 0 : 1;
}
