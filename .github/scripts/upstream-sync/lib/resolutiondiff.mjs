// The resolution diff: the work in a sync PR that is ours, and nothing else. Format and digest are fixed so the
// merge gate, running this same script from master on the same head, gets the same digest as the builder.
//
// For every commit on the first-parent chain base..head, oldest first:
//   merge commit M (parents P1 = fork side, P2 = upstream): diff from the automatic merge of P1 and P2 (conflict
//     markers left in) to M's tree. A clean merge contributes nothing.
//   other commit F: diff from F's parent tree to F's tree.
// Paths that a script settles (lockfiles, migrations, generated files) appear as one `mechanical` line with the new
// blob sha instead of hunks, so the digest still binds them. Everything else appears as a unified diff.
import { createHash } from "node:crypto";
import { git, gitOut, mergeTree } from "./git.mjs";
import { classifyFile } from "./mechanical.mjs";

export const FORMAT = "upstream-sync-resolution-diff v1";
// The Argus review limits (TECH-9826): above either, the review halts and the work must be split.
export const LIMITS = { changedLines: 5000, chars: 150000 };

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];

function treeDiff(cwd, from, to) {
  const raw = git(cwd, ["-c", "core.quotepath=false", "diff-tree", "-r", "-z", "--no-renames", "--raw", "--full-index", from, to], { allowFail: true }).stdout;
  const parts = raw.split("\0");
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].split(" ");
    if (meta.length < 5) continue;
    changes.push({ path: parts[i + 1], newBlob: meta[3], status: meta[4] });
  }
  const mechanical = [];
  const hunkPaths = [];
  for (const c of changes) {
    const cls = classifyFile(c.path);
    if (cls.kind === "mechanical") mechanical.push({ ...c, rule: cls.rule });
    else hunkPaths.push(c.path);
  }
  mechanical.sort((a, b) => (a.path < b.path ? -1 : 1));
  let diffText = "";
  if (hunkPaths.length > 0) {
    diffText = git(cwd, ["--literal-pathspecs", "-c", "core.quotepath=false", "diff", ...DIFF_FLAGS, from, to, "--", ...hunkPaths], { allowFail: true }).stdout;
  }
  return { mechanical, diffText };
}

const isChangedLine = (line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---");

/** Build the document for `head` against `base`. Returns { document, digest, files, changedLines, chars, ... }. */
export function buildResolutionDiff(cwd, { head, base }) {
  const chain = gitOut(cwd, ["rev-list", "--first-parent", "--reverse", `${base}..${head}`], { allowFail: true }).split("\n").filter(Boolean);
  const out = [`format: ${FORMAT}`, `base: ${base}`, `head: ${head}`];
  let files = 0;
  let changedLines = 0;
  const mechanicalFiles = [];
  for (const sha of chain) {
    const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
    if (parents.length > 2) throw new Error(`commit ${sha} has ${parents.length} parents; octopus merges are not supported`);
    const tree = gitOut(cwd, ["rev-parse", `${sha}^{tree}`]);
    let from;
    if (parents.length === 2) {
      out.push(`== commit ${sha} merge upstream ${parents[1]} ==`);
      from = mergeTree(cwd, parents[0], parents[1]).tree;
    } else {
      out.push(`== commit ${sha} own ==`);
      from = parents.length === 1 ? gitOut(cwd, ["rev-parse", `${parents[0]}^{tree}`]) : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    }
    const { mechanical, diffText } = treeDiff(cwd, from, tree);
    for (const m of mechanical) {
      out.push(`mechanical ${m.rule} ${m.path} ${m.status === "D" ? "deleted" : m.newBlob}`);
      mechanicalFiles.push(m.path);
    }
    if (diffText) {
      const text = diffText.endsWith("\n") ? diffText.slice(0, -1) : diffText;
      out.push(text);
      files += (diffText.match(/^diff --git /gm) ?? []).length;
      changedLines += diffText.split("\n").filter(isChangedLine).length;
    }
  }
  const document = `${out.join("\n")}\n`;
  const chars = document.length;
  const digest = `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`;
  const exceeded = [];
  if (changedLines > LIMITS.changedLines) exceeded.push(`changed_lines ${changedLines} > ${LIMITS.changedLines}`);
  if (chars > LIMITS.chars) exceeded.push(`chars ${chars} > ${LIMITS.chars}`);
  return {
    format: FORMAT,
    base,
    head,
    commits: chain.length,
    files,
    mechanical_files: mechanicalFiles.length,
    changed_lines: changedLines,
    chars,
    digest,
    within_limits: exceeded.length === 0,
    exceeded,
    document,
  };
}
