// The sync PR body. It satisfies the fork's PR template check and carries the conflict log in a fixed format that
// a script (and the gate) can parse back.
export const LOG_BEGIN = "<!-- upstream-sync:conflict-log v1 -->";
export const LOG_END = "<!-- /upstream-sync:conflict-log -->";

/** entries: [{ path, kind: "real" | "mechanical", rule?, resolution }] */
export function formatConflictLog(entries) {
  const lines = [LOG_BEGIN];
  if (entries.length === 0) lines.push("none");
  for (const e of entries) {
    const cls = e.kind === "mechanical" ? `mechanical:${e.rule}` : "real";
    lines.push(`- ${e.path} | ${cls} | ${e.resolution ?? "unresolved"}`);
  }
  lines.push(LOG_END);
  return lines.join("\n");
}

export function parseConflictLog(body) {
  const start = body.indexOf(LOG_BEGIN);
  const end = start < 0 ? -1 : body.indexOf(LOG_END, start + LOG_BEGIN.length);
  if (start < 0 || end < 0) return null;
  const entries = [];
  for (const line of body.slice(start + LOG_BEGIN.length, end).split("\n")) {
    const m = line.match(/^- (.+?) \| (real|mechanical:[^|]+?) \| (.+)$/);
    if (!m) continue;
    const kind = m[2] === "real" ? "real" : "mechanical";
    const entry = { path: m[1], kind, resolution: m[3] };
    if (kind === "mechanical") entry.rule = m[2].slice("mechanical:".length);
    entries.push(entry);
  }
  return entries;
}

const short = (s) => s.slice(0, 10);
// Upstream subjects are untrusted text. "Fixes #12" in one would close an unrelated issue in the fork when the sync PR
// merges, and #12 means a different thing here than upstream. Defuse every #N and closing keyword.
export const safeSubject = (subject) => subject.replace(/\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b/gi, "$1\u200b").replace(/#(\d+)/g, "upstream#$1");

export function buildCleanStretchBody({ steps, base, conflictEntries = [], checkSummary }) {
  const first = steps[0];
  const last = steps[steps.length - 1];
  const list = steps.map((s) => `- \`${short(s.sha)}\` ${safeSubject(s.subject)}`).join("\n");
  return [
    "## Thinking Path",
    "",
    "> - Paperclip is the open source app people use to manage AI agents for work",
    "> - This fork stays current by merging upstream one first-parent commit (one upstream PR) at a time",
    `> - Upstream merges cleanly for ${steps.length} commit(s) after the sync point \`${short(base)}\``,
    "> - A script merged that clean stretch with no model call and ran the checks after every step",
    "> - This pull request carries that stretch, so the fork moves forward without a model step",
    "",
    "## What Changed",
    "",
    `Merges ${steps.length} upstream commit(s), \`${short(first.sha)}\` to \`${short(last.sha)}\`, as one merge commit per upstream commit. The fork's \`pnpm-lock.yaml\` is kept as is.`,
    "",
    list,
    "",
    "## Conflict log",
    "",
    formatConflictLog(conflictEntries),
    "",
    `<!-- upstream-sync:range ${first.sha}..${last.sha} -->`,
    "",
    "## Verification",
    "",
    checkSummary ?? "Typecheck and the changed tests ran after every merged step.",
    "",
    "## Risks",
    "",
    "A clean text merge can still be wrong (both sides bumping the same count). The checks run after each step to catch that. The merge gate checks everything again.",
    "",
    "## Model Used",
    "",
    "None. This pull request was produced by the upstream-sync scripts with no model call.",
    "",
    "",
  ].join("\n");
}

export function buildCleanStretchTitle(steps) {
  const first = steps[0];
  const last = steps[steps.length - 1];
  return `chore(upstream-sync): merge ${steps.length} upstream commit(s) ${short(first.sha)}..${short(last.sha)}`;
}
