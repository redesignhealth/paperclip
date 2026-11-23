// The resolution diff: the work in a sync PR that is ours, and nothing else. Format and digest are fixed so the
// merge gate, running this same script from master on the same head, gets the same digest as the builder.
//
// For every commit on the first-parent chain base..head, oldest first:
//   merge commit M (parents P1 = fork side, P2 = upstream): diff from the automatic merge of P1 and P2 (conflict
//     markers left in) to M's tree. A clean merge contributes nothing. Paths a script settles (lockfiles,
//     migrations, registered generated files) appear as one `mechanical` line with the new blob sha instead of
//     hunks, so the digest still binds them.
//   other commit F (a fix commit): diff from F's parent tree to F's tree, every path in full. A fix commit is our
//     own work; nothing in it is summarized.
// Every git call here must succeed: a failed call would otherwise yield a valid-looking digest of a partial diff.
import { createHash } from "node:crypto";
import { git, gitOut, mergeTree } from "./git.mjs";
import { classifyFile } from "./mechanical.mjs";

export const FORMAT = "upstream-sync-resolution-diff v1";
// The Argus review limits (TECH-9826): above either, the review halts and the work must be split.
// `chars` counts code points, as a Python `len()` does on the service side.
export const LIMITS = { changedLines: 5000, chars: 150000 };

// Pin every setting that can change diff output, so builder and gate agree whatever their git configuration says.
const PIN = [
  "-c", "core.quotepath=false",
  "-c", "core.autocrlf=false",
  "-c", "diff.renames=false",
  "-c", "diff.algorithm=default",
  "-c", "diff.indentHeuristic=true",
  "-c", "diff.noprefix=false",
  "-c", "diff.suppressBlankEmpty=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.interHunkContext=0",
  "-c", "diff.context=3",
  "-c", "diff.orderFile=/dev/null",
];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];

// A path is summarized (not shown) only when a script, not a person, owns its content.
const isSummarized = (cls) => cls.kind === "mechanical" && cls.action !== "needs-generator";

function treeDiff(cwd, from, to, { summarize }) {
  const raw = git(cwd, [...PIN, "diff-tree", "-r", "-z", "--no-renames", "--raw", "--full-index", from, to]).stdout;
  const parts = raw.split("\0");
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].split(" ");
    if (!parts[i].startsWith(":") || meta.length < 5) throw new Error(`unexpected diff-tree record: ${JSON.stringify(parts[i])}`);
    changes.push({ path: parts[i + 1], newBlob: meta[3], status: meta[4] });
  }
  const mechanical = [];
  const hunkPaths = [];
  for (const c of changes) {
    const cls = summarize ? classifyFile(c.path) : { kind: "real" };
    if (isSummarized(cls)) mechanical.push({ ...c, rule: cls.rule });
    else hunkPaths.push(c.path);
  }
  mechanical.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let diffText = "";
  if (hunkPaths.length > 0) {
    diffText = git(cwd, ["--literal-pathspecs", ...PIN, "diff", ...DIFF_FLAGS, from, to, "--", ...hunkPaths]).stdout;
  }
  return { mechanical, diffText };
}

const isChangedLine = (line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---");

/** Build the document for `head` against `base`. Returns { document, digest, files, changed_lines, chars, ... }. */
export function buildResolutionDiff(cwd, { head, base }) {
  const chain = gitOut(cwd, ["rev-list", "--first-parent", "--reverse", `${base}..${head}`]).split("\n").filter(Boolean);
  const emptyTree = gitOut(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
  const out = [`format: ${FORMAT}`, `base: ${base}`, `head: ${head}`];
  let files = 0;
  let changedLines = 0;
  let mechanicalFiles = 0;
  for (const sha of chain) {
    const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
    if (parents.length > 2) throw new Error(`commit ${sha} has ${parents.length} parents; octopus merges are not supported`);
    const tree = gitOut(cwd, ["rev-parse", `${sha}^{tree}`]);
    let from;
    let summarize = false;
    if (parents.length === 2) {
      out.push(`== commit ${sha} merge upstream ${parents[1]} ==`);
      const merged = mergeTree(cwd, parents[0], parents[1], { pin: true });
      from = merged.tree;
      summarize = true;
    } else {
      out.push(`== commit ${sha} own ==`);
      from = parents.length === 1 ? gitOut(cwd, ["rev-parse", `${parents[0]}^{tree}`]) : emptyTree;
    }
    const { mechanical, diffText } = treeDiff(cwd, from, tree, { summarize });
    for (const m of mechanical) {
      out.push(`mechanical ${m.rule} ${m.path} ${m.status === "D" ? "deleted" : m.newBlob}`);
      mechanicalFiles += 1;
    }
    if (diffText) {
      out.push(diffText.endsWith("\n") ? diffText.slice(0, -1) : diffText);
      files += (diffText.match(/^diff --git /gm) ?? []).length;
      changedLines += diffText.split("\n").filter(isChangedLine).length;
    }
  }
  const document = `${out.join("\n")}\n`;
  const chars = Array.from(document).length;
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
    mechanical_files: mechanicalFiles,
    changed_lines: changedLines,
    chars,
    digest,
    within_limits: exceeded.length === 0,
    exceeded,
    document,
  };
}
