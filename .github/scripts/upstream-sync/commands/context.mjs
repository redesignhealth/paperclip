// `context`: for each conflicted file, print what the model needs to resolve it with intent: the upstream PR's
// description, and our commits and tickets on the conflicting lines. Mechanical files are listed, not explained.
import { parseArgs } from "../lib/args.mjs";
import { git, gitOut, mergeTree, resolveRefs, syncPoint } from "../lib/git.mjs";
import { splitConflicts } from "../lib/mechanical.mjs";
import { runArgv } from "../lib/shell.mjs";
import { shortSha } from "../lib/walk.mjs";

const TICKET_RE = /\b[A-Z][A-Z0-9]{1,7}-\d+\b/g;
const PR_RE = /\(#(\d+)\)/g;

/** Our-side line ranges of each conflict block in a merged text (default or diff3 markers). */
export function oursRanges(text) {
  const ranges = [];
  let oursLine = 0;
  let state = "outside";
  let start = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ")) {
      state = "ours";
      start = oursLine + 1;
    } else if (state === "ours" && line.startsWith("||||||| ")) state = "base";
    else if ((state === "ours" || state === "base") && line.startsWith("=======")) {
      state = "theirs";
      ranges.push([start, Math.max(start, oursLine)]);
    } else if (state === "theirs" && line.startsWith(">>>>>>> ")) state = "outside";
    else if (state === "outside" || state === "ours") oursLine++;
  }
  return ranges;
}

/** Commits that last touched the given lines of `file` at `rev`, with subject and body ids. */
export function blameCommits(cwd, rev, file, [from, to]) {
  const r = git(cwd, ["blame", "--porcelain", "-L", `${from},${to}`, rev, "--", file], { allowFail: true });
  if (r.status !== 0) return [];
  const shas = [...new Set(r.stdout.split("\n").filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40)))];
  return shas.map((sha) => {
    const message = gitOut(cwd, ["log", "-1", "--format=%s%n%b", sha]);
    const ids = [...new Set(message.match(TICKET_RE) ?? [])];
    return { sha, subject: message.split("\n")[0], ids };
  });
}

export function gatherContext(cwd, opts, step) {
  const refs = resolveRefs(cwd, { ...opts, fetch: false });
  const base = syncPoint(cwd, refs.master, refs.upstream);
  const sha = step ?? gitOut(cwd, ["rev-list", "--first-parent", "--reverse", refs.upstream, `^${base}`]).split("\n")[0];
  const merged = mergeTree(cwd, refs.master, sha);
  const { mechanical, real } = splitConflicts(merged.files);
  const subject = gitOut(cwd, ["log", "-1", "--format=%s", sha]);
  const prNumber = [...subject.matchAll(PR_RE)].map((m) => Number(m[1])).pop() ?? null;

  let upstreamPr = null;
  if (opts.gh !== false && prNumber) {
    const r = runArgv(cwd, ["gh", "pr", "view", String(prNumber), "-R", opts.upstreamRepo ?? "paperclipai/paperclip", "--json", "title,body,url"]);
    if (r.ok) {
      try {
        upstreamPr = JSON.parse(r.output);
      } catch {
        /* leave null */
      }
    }
  }

  const files = real.map(({ path }) => {
    const blob = git(cwd, ["cat-file", "-p", `${merged.tree}:${path}`], { allowFail: true }).stdout;
    const ranges = oursRanges(blob);
    const ours = ranges.flatMap((range) => blameCommits(cwd, refs.master, path, range));
    const uniqueOurs = [...new Map(ours.map((c) => [c.sha, c])).values()];
    const theirs = gitOut(cwd, ["log", "--format=%h %s", `${base}..${sha}`, "--", path], { allowFail: true })
      .split("\n")
      .filter(Boolean);
    return { path, hunks: ranges.length, ours: uniqueOurs, theirs };
  });
  return { sha, subject, prNumber, upstreamPr, mechanical: mechanical.map((m) => ({ path: m.path, rule: m.rule })), files };
}

export function formatContext(c) {
  const lines = [`upstream ${shortSha(c.sha)}: ${c.subject}`];
  if (c.upstreamPr) lines.push(`  ${c.upstreamPr.url}`, `  title: ${c.upstreamPr.title}`, ...String(c.upstreamPr.body ?? "").split("\n").slice(0, 40).map((l) => `  | ${l}`));
  else if (c.prNumber) lines.push(`  (upstream PR #${c.prNumber} description not fetched)`);
  for (const f of c.files) {
    lines.push("", `== ${f.path} (${f.hunks} conflict hunk(s))`);
    lines.push("  our commits on the conflicting lines:");
    for (const o of f.ours) lines.push(`    ${o.sha.slice(0, 10)} ${o.subject}${o.ids.length ? `  [${o.ids.join(", ")}]` : ""}`);
    if (f.ours.length === 0) lines.push("    (none found)");
    lines.push("  upstream commits in this step touching the file:");
    for (const t of f.theirs) lines.push(`    ${t}`);
  }
  if (c.mechanical.length) {
    lines.push("", "settled by script, not for the model:");
    for (const m of c.mechanical) lines.push(`  ${m.path} (${m.rule})`);
  }
  return lines.join("\n");
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts, rest } = parseArgs(argv, { boolean: ["json", "gh"] });
  const c = gatherContext(cwd, opts, rest[0]);
  stdout.write(opts.json ? `${JSON.stringify(c, null, 2)}\n` : `${formatContext(c)}\n`);
  return 0;
}
