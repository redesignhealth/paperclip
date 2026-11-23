// `submit`: send the resolution diff for review and wait for the verdict, with a round cap.
//
// The review path TECH-9784 picked is the rh-mcp service (`argus_start_review` / `argus_get_review`), which is an
// agent tool, not something a script can call. So `submit` does everything around the call, and the call itself is
// either run by a command you supply (`--review-cmd`, which must print the final `argus_get_review` JSON), or done by
// the agent from the payload `submit` writes, after which `submit --verdict <file>` checks and records the result.
//
// The payload and the checks on the verdict are the interface written into TECH-9826. Rounds are counted from git:
// one note on `refs/notes/upstream-sync-review` per submitted head on the PR's first-parent chain.
//
// Exit codes: 0 APPROVE, 1 BLOCKING (findings), 2 error (the CLI's code for any thrown error), 4 round cap reached
// (hand to a person), 7 too large (split request), 8 review halted or failed (not a verdict), 9 verdict does not
// match this head/diff, 10 awaiting the review. A round is counted only when a verdict for this head arrives.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "../lib/args.mjs";
import { git, gitOut } from "../lib/git.mjs";
import { runShell } from "../lib/shell.mjs";
import { computeResolutionDiff } from "./resolution-diff.mjs";

export const NOTES_REF = "refs/notes/upstream-sync-review";
export const DEFAULT_MAX_ROUNDS = 3; // TECH-9804
const SIZE_HALTS = /^scope_|too_large|input_chars|input_size|diff_size|size_limit/i;

/** Submitted heads on the first-parent chain base..head, from the notes ref. */
export function submittedRounds(cwd, base, head) {
  const chain = new Set(gitOut(cwd, ["rev-list", "--first-parent", `${base}..${head}`], { allowFail: true }).split("\n").filter(Boolean));
  const listed = git(cwd, ["notes", `--ref=${NOTES_REF}`, "list"], { allowFail: true }).stdout.split("\n").filter(Boolean);
  const rounds = [];
  for (const line of listed) {
    const [, commit] = line.split(" ");
    if (!chain.has(commit)) continue;
    const text = git(cwd, ["notes", `--ref=${NOTES_REF}`, "show", commit], { allowFail: true }).stdout;
    try {
      rounds.push({ commit, ...JSON.parse(text) });
    } catch {
      rounds.push({ commit });
    }
  }
  return rounds;
}

export function buildPayload({ repo, pr, result }) {
  return {
    review_kind: "supplied_diff",
    repo,
    pr,
    head_sha: result.head,
    base_sha: result.base,
    diff: result.document,
    diff_digest: result.digest,
  };
}

/** Check a verdict (the JSON `argus_get_review` returns) against this head and diff. Returns { exit, reason, verdict }. */
export function judgeVerdict(verdict, { head, digest }) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return { exit: 9, reason: "the verdict is not a JSON object" };
  const sha = verdict.head_sha ?? verdict.sha;
  if (sha !== head) return { exit: 9, reason: `verdict is for ${sha}, not ${head}` };
  switch (verdict.status) {
    case "completed":
      if (verdict.review_kind !== "supplied_diff") return { exit: 9, reason: `review_kind is ${verdict.review_kind}, not supplied_diff` };
      if (verdict.diff_digest !== digest) return { exit: 9, reason: `diff_digest ${verdict.diff_digest} does not match ${digest}` };
      if (verdict.verdict === "APPROVE") return { exit: 0, reason: "APPROVE", counted: true };
      if (verdict.verdict === "BLOCKING") return { exit: 1, reason: "BLOCKING", findings: verdict.findings ?? [], counted: true };
      return { exit: 9, reason: `unknown verdict ${verdict.verdict}` };
    case "halted":
      // A halt carries no verdict, so only the head is bound. It still used a round.
      return SIZE_HALTS.test(String(verdict.halt_reason))
        ? { exit: 7, reason: `halted: ${verdict.halt_reason}; split the work`, counted: true }
        : { exit: 8, reason: `halted: ${verdict.halt_reason}`, counted: true };
    default:
      return { exit: 8, reason: `review ${verdict.status}${verdict.error_class ? ` (${verdict.error_class})` : ""}; not a verdict` };
  }
}

const NOTES_REMOTE_REF = "refs/notes/upstream-sync-review-remote";
const NOTES_ENV = { GIT_COMMITTER_NAME: "upstream-sync", GIT_COMMITTER_EMAIL: "upstream-sync@localhost", GIT_AUTHOR_NAME: "upstream-sync", GIT_AUTHOR_EMAIL: "upstream-sync@localhost" };

/** Fold origin's notes into the local ones (union, so no round is ever dropped). */
function mergeRemoteNotes(cwd) {
  const fetched = git(cwd, ["fetch", "-q", "origin", `+${NOTES_REF}:${NOTES_REMOTE_REF}`], { allowFail: true });
  if (fetched.status !== 0) return; // origin has no notes yet
  const local = git(cwd, ["rev-parse", "--verify", "-q", NOTES_REF], { allowFail: true }).status === 0;
  if (!local) git(cwd, ["update-ref", NOTES_REF, NOTES_REMOTE_REF]);
  else git(cwd, ["notes", `--ref=${NOTES_REF}`, "merge", "-s", "union", NOTES_REMOTE_REF], { allowFail: true, env: NOTES_ENV });
}

/** Push the notes without force; on a race, merge and push once more. Returns whether origin has them. */
function pushNotes(cwd) {
  const push = () => git(cwd, ["push", "-q", "origin", `${NOTES_REF}:${NOTES_REF}`], { allowFail: true }).status === 0;
  if (push()) return true;
  mergeRemoteNotes(cwd);
  return push();
}

function recordRound(cwd, head, digest, round) {
  git(cwd, ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify({ round, digest, at: new Date().toISOString() }), head], {
    env: NOTES_ENV,
  });
}

export async function submit(cwd, opts) {
  const result = computeResolutionDiff(cwd, opts);
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const summary = { head: result.head, base: result.base, digest: result.digest, changed_lines: result.changed_lines, chars: result.chars, files: result.files };

  if (!result.within_limits) {
    return { ...summary, exit: 7, status: "too-large", reason: `resolution diff is over the Argus limits (${result.exceeded.join(", ")}); split the work and plan a split request`, split_request: true };
  }

  const hasOrigin = git(cwd, ["remote", "get-url", "origin"], { allowFail: true }).status === 0;
  const syncing = opts.sync !== false && hasOrigin;
  // Rounds live in git notes so a fresh pod sees them. Merge the remote notes in (union) before counting: a plain
  // fetch would replace rounds that are recorded here but not pushed yet.
  if (syncing) mergeRemoteNotes(cwd);
  const history = submittedRounds(cwd, result.base, result.head);
  const already = history.find((r) => r.commit === result.head && r.digest === result.digest);
  const round = already ? already.round : history.length + 1;
  if (!already && round > maxRounds) {
    return { ...summary, exit: 4, status: "round-cap", round, reason: `${history.length} review round(s) used (cap ${maxRounds}); hand this PR to a person with the open findings` };
  }

  const payloadPath = resolve(opts.payload ?? `${gitOut(cwd, ["rev-parse", "--absolute-git-dir"])}/upstream-sync/submit-${result.head}.json`);
  if (!opts.verdict) {
    // Not when only judging a verdict: that would overwrite the payload the agent sent with one that lacks repo and pr.
    mkdirSync(dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, `${JSON.stringify(buildPayload({ repo: opts.repo ?? null, pr: opts.pr ?? null, result }))}\n`);
  }

  let verdictText = null;
  if (opts.verdict) verdictText = readFileSync(opts.verdict, "utf8");
  else if (opts.reviewCmd) {
    const r = runShell(cwd, opts.reviewCmd, { env: { UPSTREAM_SYNC_PAYLOAD: payloadPath } });
    if (!r.ok) return { ...summary, exit: 8, status: "review-command-failed", round, reason: r.output.slice(-2000), payload: payloadPath };
    // The verdict is the command's stdout (whole, or its last line); stderr noise is ignored.
    const stdout = r.stdout.trim();
    verdictText = stdout.startsWith("{") ? stdout : (stdout.split("\n").pop() ?? "");
  }
  if (verdictText === null) {
    return {
      ...summary,
      exit: 10,
      status: "awaiting-review",
      round,
      payload: payloadPath,
      reason: "call argus_start_review with the payload's fields (review_kind supplied_diff), wait, then run submit --verdict <argus_get_review JSON file>",
    };
  }
  let verdict;
  try {
    verdict = JSON.parse(verdictText);
  } catch {
    return { ...summary, exit: 9, status: "bad-verdict", round, reason: "the verdict is not JSON", payload: payloadPath };
  }
  const judged = judgeVerdict(verdict, { head: result.head, digest: result.digest });
  let notesSynced = true;
  if (judged.counted && !already) {
    recordRound(cwd, result.head, result.digest, round);
    if (syncing) notesSynced = pushNotes(cwd);
  }
  if (!notesSynced) judged.warning = "the round was recorded here but could not be pushed to origin; another pod would not see it, so check the round count by hand";
  return { ...summary, ...judged, status: judged.exit === 0 ? "approved" : judged.exit === 1 ? "blocking" : "stopped", round, ...(opts.verdict ? {} : { payload: payloadPath }) };
}

export function formatSubmit(r) {
  const lines = [`submit ${r.head.slice(0, 10)} (${r.changed_lines} changed lines, ${r.chars} chars, ${r.digest}): ${r.status}${r.round ? `, round ${r.round}` : ""}`];
  if (r.reason) lines.push(`  ${r.reason}`);
  if (r.payload) lines.push(`  payload: ${r.payload}`);
  if (r.warning) lines.push(`  WARNING ${r.warning}`);
  for (const f of r.findings ?? []) lines.push(`  ${f.severity} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.summary ?? ""}`);
  return lines.join("\n");
}

export async function run(argv, { cwd = process.cwd(), stdout = process.stdout } = {}) {
  const { opts } = parseArgs(argv, { boolean: ["json", "sync"], number: ["maxRounds", "pr"] });
  const r = await submit(cwd, opts);
  stdout.write(opts.json ? `${JSON.stringify(r, null, 2)}\n` : `${formatSubmit(r)}\n`);
  return r.exit;
}
