import { getState, setState } from "./db.mjs";
import { ensureMirror, isAncestor, listCommitsAfter, resolveCommit } from "./upstreamGit.mjs";
import { loadForkOwnedMatcher, touchesMigrations } from "./forkOwned.mjs";

export const MARKER_KEY = "upstream_synced_marker";
export const PAUSED_KEY = "detector_paused";

export async function getMarker(db, cfg) {
  return (await getState(db, MARKER_KEY)) ?? cfg.initialMarker;
}

// Pure DB part, separated so tests can feed synthetic commits.
export async function insertCommits(db, commits, matcher) {
  let inserted = 0;
  for (const c of commits) {
    const hits = matcher ? c.files.filter((f) => matcher.matches(f)) : [];
    const r = await db.query(
      `INSERT INTO upstream_sync_log
         (upstream_sha, upstream_pr, title, body, author, files, upstream_merged_at,
          fork_owned_hits, touches_migrations, reverts_sha, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       ON CONFLICT (upstream_sha) DO NOTHING`,
      [c.sha, c.pr, c.title, c.body || null, c.author, c.files, c.mergedAt, hits, touchesMigrations(c.files), c.revertsSha],
    );
    inserted += r.rowCount;
  }
  return inserted;
}

export async function detect(db, cfg, log = console.error) {
  if ((await getState(db, PAUSED_KEY)) === "true") {
    log("detector paused (upstream_sync_state.detector_paused=true); skipping");
    return { paused: true, inserted: 0, seen: 0 };
  }
  const tipRef = await ensureMirror(cfg);
  const tip = await resolveCommit(cfg.mirrorDir, tipRef);
  const marker = await resolveCommit(cfg.mirrorDir, await getMarker(db, cfg));
  if (!marker) throw new Error("marker commit not found in upstream mirror; refusing to guess (use `marker set`)");
  if (!(await isAncestor(cfg.mirrorDir, marker, tip))) {
    throw new Error(`marker ${marker.slice(0, 9)} is not an ancestor of upstream ${cfg.upstreamBranch} (force-push?). Fix with \`marker set\`.`);
  }
  const commits = await listCommitsAfter(cfg.mirrorDir, marker, tip, log);
  const matcher = loadForkOwnedMatcher(cfg.forkOwnedFile);
  const inserted = await insertCommits(db, commits, matcher);
  await setState(db, "last_detect_at", new Date().toISOString());
  await setState(db, "last_detect_tip", tip);
  return { paused: false, tip, marker, seen: commits.length, inserted };
}
