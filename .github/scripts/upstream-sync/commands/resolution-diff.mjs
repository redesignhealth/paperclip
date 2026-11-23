// `resolution-diff`: print our own work in a sync PR and its digest. The gate runs this same script from master on
// the same head; the two digests must be equal.
//   resolution-diff [--head <rev>] [--base <rev>] [--master <ref>] [--out <file>] [--json] [--digest]
// No flag: the document on stdout. --json: the numbers (without the document). --digest: just the digest.
import { writeFileSync } from "node:fs";
import { parseArgs } from "../lib/args.mjs";
import { gitOut, revParse } from "../lib/git.mjs";
import { buildResolutionDiff } from "../lib/resolutiondiff.mjs";

export function resolveHeadBase(cwd, opts) {
  const head = revParse(cwd, opts.head ?? "HEAD");
  if (!head) throw new Error(`cannot resolve head ${opts.head ?? "HEAD"}`);
  const masterRef = opts.master || process.env.UPSTREAM_SYNC_MASTER_REF || "origin/master";
  let base = null;
  if (opts.base) {
    base = revParse(cwd, opts.base);
    if (!base) throw new Error(`cannot resolve --base ${opts.base}`);
  } else {
    const master = revParse(cwd, masterRef);
    if (!master) throw new Error(`cannot resolve ${masterRef}; pass --base or --master`);
    base = gitOut(cwd, ["merge-base", head, master], { allowFail: true });
    if (!base) throw new Error(`${masterRef} and ${head} share no history`);
  }
  return { head, base };
}

export function computeResolutionDiff(cwd, opts = {}) {
  return buildResolutionDiff(cwd, resolveHeadBase(cwd, opts));
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts } = parseArgs(argv, { boolean: ["json", "digest"] });
  const result = computeResolutionDiff(cwd, opts);
  if (opts.out) writeFileSync(opts.out, result.document);
  if (opts.digest) stdout.write(`${result.digest}\n`);
  else if (opts.json) {
    const { document, ...numbers } = result;
    stdout.write(`${JSON.stringify(numbers, null, 2)}\n`);
  } else if (!opts.out) stdout.write(result.document);
  return 0;
}
