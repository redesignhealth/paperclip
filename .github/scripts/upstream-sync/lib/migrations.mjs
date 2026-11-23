// Migration numbers are settled by script (condition 1 of the sync go decision). An upstream migration whose number
// is not above the fork's highest is renumbered to follow it; the journal gets matching entries and upstream's
// newest snapshot moves to the new number. The fork's own migrations never move: deployed databases already ran them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitOut } from "./git.mjs";
import { MIGRATION_JOURNAL, MIGRATION_SNAPSHOT_RE } from "./mechanical.mjs";

export const MIGRATIONS_DIR = "packages/db/src/migrations";
const META = `${MIGRATIONS_DIR}/meta`;
const KEEP_SNAPSHOTS = 5; // matches the db package's `prune:snapshots`
const pad = (n) => String(n).padStart(4, "0");
const numberOf = (name) => Number(name.slice(0, 4));

export function listMigrationNames(cwd, rev) {
  return gitOut(cwd, ["ls-tree", "--name-only", `${rev}:${MIGRATIONS_DIR}`], { allowFail: true })
    .split("\n")
    .filter((f) => /^\d{4}_.+\.sql$/.test(f));
}

/**
 * Plan the renumbering. `masterNames` are the fork's migration files, `added` the upstream step's new ones (file
 * names, no directory). Returns [{ from, to }] for every added file, in order. `to === from` when no change is needed.
 */
export function planRenumber(masterNames, added) {
  const used = new Set(masterNames.map(numberOf));
  let next = Math.max(-1, ...used) + 1;
  const plan = [];
  for (const from of [...added].sort()) {
    const n = numberOf(from);
    if (n >= next && !used.has(n)) {
      plan.push({ from, to: from });
      used.add(n);
      next = n + 1;
    } else {
      plan.push({ from, to: `${pad(next)}_${from.slice(5)}` });
      used.add(next);
      next += 1;
    }
  }
  return plan;
}

/** Append upstream's journal entries for the planned files to the fork's journal, with fresh idx and rising `when`. */
export function mergeJournal(masterJournalText, theirsJournalText, plan) {
  const ours = JSON.parse(masterJournalText);
  const theirs = JSON.parse(theirsJournalText);
  const tagMap = new Map(plan.map((p) => [p.from.replace(/\.sql$/, ""), p.to.replace(/\.sql$/, "")]));
  const entries = [...ours.entries];
  // idx is not the array position: the real journal has gaps (and one repeated idx), so continue from the highest.
  let idx = Math.max(-1, ...entries.map((e) => e.idx ?? -1));
  let when = Math.max(0, ...entries.map((e) => e.when ?? 0));
  for (const entry of theirs.entries) {
    if (!tagMap.has(entry.tag)) continue;
    when = Math.max(when + 1, entry.when ?? 0);
    idx += 1;
    entries.push({ ...entry, idx, tag: tagMap.get(entry.tag), when });
  }
  return `${JSON.stringify({ ...ours, entries }, null, 2)}\n`;
}

const show = (cwd, rev, path) => git(cwd, ["show", `${rev}:${path}`], { allowFail: true });

/**
 * Settle migrations inside a merge in progress (`git merge --no-commit`). Returns { plan, actions }.
 *  - upstream's added migration files are renamed to follow the fork's highest number
 *  - _journal.json = the fork's journal plus upstream's entries for those files
 *  - snapshots = the fork's snapshots plus upstream's newest added snapshot at its new number, pruned to the latest 5
 */
export function settleMigrations(cwd, { master, base, theirs }) {
  const actions = [];
  const masterNames = listMigrationNames(cwd, master);
  const known = new Set([...listMigrationNames(cwd, base), ...masterNames]);
  const added = listMigrationNames(cwd, theirs).filter((n) => !known.has(n));
  const plan = planRenumber(masterNames, added);

  for (const { from, to } of plan) {
    if (from === to) continue;
    git(cwd, ["mv", "-f", `${MIGRATIONS_DIR}/${from}`, `${MIGRATIONS_DIR}/${to}`]);
    actions.push(`renumbered ${from} -> ${to}`);
  }

  if (plan.length > 0) {
    const merged = mergeJournal(show(cwd, master, MIGRATION_JOURNAL).stdout, show(cwd, theirs, MIGRATION_JOURNAL).stdout, plan);
    writeFileSync(join(cwd, MIGRATION_JOURNAL), merged);
    git(cwd, ["add", "--", MIGRATION_JOURNAL]);
    actions.push(`journal: fork entries plus ${plan.length} upstream entr${plan.length === 1 ? "y" : "ies"}`);
  } else {
    git(cwd, ["checkout", master, "--", MIGRATION_JOURNAL], { allowFail: true });
    actions.push("journal: fork copy (upstream added no migration)");
  }

  // Snapshots: start from the fork's set, then bring in upstream's newest added snapshot under its new number.
  const inIndex = gitOut(cwd, ["ls-files", "--", META]).split("\n").filter((p) => MIGRATION_SNAPSHOT_RE.test(p));
  const masterSnaps = new Set(
    gitOut(cwd, ["ls-tree", "-r", "--name-only", master, "--", META]).split("\n").filter((p) => MIGRATION_SNAPSHOT_RE.test(p)),
  );
  for (const p of inIndex) if (!masterSnaps.has(p)) git(cwd, ["rm", "-f", "-q", "--", p]);
  for (const p of masterSnaps) git(cwd, ["checkout", master, "--", p]);
  if (plan.length > 0) {
    const last = plan[plan.length - 1];
    const source = `${META}/${last.from.slice(0, 4)}_snapshot.json`;
    const snap = show(cwd, theirs, source);
    if (snap.status === 0) {
      const target = `${META}/${last.to.slice(0, 4)}_snapshot.json`;
      writeFileSync(join(cwd, target), snap.stdout);
      git(cwd, ["add", "--", target]);
      actions.push(`snapshot: upstream's ${source.split("/").pop()} carried as ${target.split("/").pop()} (upstream's schema only: confirm with the db generator)`);
    }
  }
  const snaps = gitOut(cwd, ["ls-files", "--", META]).split("\n").filter((p) => MIGRATION_SNAPSHOT_RE.test(p)).sort();
  for (const p of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS))) git(cwd, ["rm", "-f", "-q", "--", p]);
  return { plan, actions };
}
