// Run the registered generators. Shared by `check` (compare, then restore) and `regenerate` (write and stage).
import { gitOut } from "./git.mjs";
import { BUILD_COMMAND, GENERATORS, generatorIsAffected } from "./mechanical.mjs";
import { runArgv, runShell, tail } from "./shell.mjs";

/** Generators whose outputs may be stale given the changed paths. */
export function affectedGenerators(changedPaths) {
  return GENERATORS.filter((g) => generatorIsAffected(g, changedPaths));
}

/** Paths that differ between `rev` and the work tree (staged and unstaged), for choosing generators mid-merge. */
export function changedAgainst(cwd, rev) {
  return gitOut(cwd, ["diff", "--name-only", "-z", rev], { allowFail: true }).split("\0").filter(Boolean);
}

/** Run each generator (after one TypeScript build when any needs it). Returns [{ id, ok, output }]. */
export function runGenerators(cwd, generators, { buildCmd, skipBuild = false } = {}) {
  const results = [];
  if (!skipBuild && generators.some((g) => g.build)) {
    const built = buildCmd ? runShell(cwd, buildCmd) : runArgv(cwd, BUILD_COMMAND);
    if (!built.ok) return [{ id: "build", ok: false, output: `build before generators failed:\n${tail(built.output)}` }];
  }
  for (const g of generators) {
    let failure = null;
    for (const argv of g.commands) {
      const r = runArgv(g.cwd === "." ? cwd : `${cwd}/${g.cwd}`, argv);
      if (!r.ok) {
        failure = `generator ${g.id} failed (${argv.join(" ")}):\n${tail(r.output, 1500)}`;
        break;
      }
    }
    results.push({ id: g.id, ok: !failure, output: failure ?? "" });
  }
  return results;
}
