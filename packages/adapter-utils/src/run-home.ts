/**
 * Per-run isolated home directory (TECH-7095).
 *
 * Model/agent CLIs read credentials and config from HOME / XDG_* (`~/.claude`, `~/.codex`,
 * `~/.hermes/.env`, `~/.config/gh`, ...). When they run with the server user's home, an
 * unbound run can silently authenticate with whatever login the host happens to have. A run
 * home is a fresh, owner-only directory tree that becomes the child's HOME/XDG/TMPDIR, so a
 * run only ever sees credentials Paperclip explicitly placed there.
 *
 * Limit (not claimed solved): this is path isolation, not a sandbox. A child running as the
 * same OS user can still read other files and /proc/<pid>/environ by absolute path.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUN_HOME_PREFIX = "paperclip-run-home-";
/** Created inside every run home. The sweep only removes `paperclip-run-home-*` dirs that carry it. */
export const RUN_HOME_MARKER = ".paperclip-run-home";
/** Managed AI runtime homes: `paperclip-ai-<companyId>-<grantId>-<random>`; matched strictly (two UUIDs). */
const MANAGED_AI_HOME_PATTERN = /^paperclip-ai-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

const SUBDIRS = ["config", "data", "cache", "state", "tmp", "runtime", "provider"] as const;

const registered = new Set<string>();

export interface RunHome {
  /** Root of the run home; also the child's HOME. */
  path: string;
  /** Directory managed AI runtimes place provider config/auth in (CODEX_HOME etc.). */
  providerDir: string;
  /** HOME/XDG/TMPDIR bindings. Apply LAST so adapter or agent env cannot redirect them. */
  env: Record<string, string>;
  /**
   * Subset for runs that execute on a REMOTE/sandbox target: only the locations the adapters
   * already remap (HOME, XDG config/data). The temp/cache/state/runtime paths are controller-local
   * and would point at directories that do not exist on the target.
   */
  remoteEnv: Record<string, string>;
  /** Idempotent. Safe to call from success, failure, timeout and abort paths. */
  cleanup: () => Promise<void>;
}

export function isRegisteredRunHome(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  for (const root of registered) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

export async function createRunHome(
  input: { prefix?: string; root?: string } = {},
): Promise<RunHome> {
  const root = input.root ?? os.tmpdir();
  const created = await mkdtemp(path.join(root, input.prefix ?? RUN_HOME_PREFIX));
  // mkdtemp already creates 0700; chmod anyway so a permissive umask or a pre-existing
  // directory can never leave the home readable by other local users.
  await chmod(created, 0o700);
  for (const dir of SUBDIRS) await mkdir(path.join(created, dir), { mode: 0o700 });
  await writeFile(path.join(created, RUN_HOME_MARKER), "", { mode: 0o600 });
  registered.add(created);
  const env: Record<string, string> = {
    HOME: created,
    USERPROFILE: created,
    XDG_CONFIG_HOME: path.join(created, "config"),
    XDG_DATA_HOME: path.join(created, "data"),
    XDG_CACHE_HOME: path.join(created, "cache"),
    XDG_STATE_HOME: path.join(created, "state"),
    // The server's XDG_RUNTIME_DIR holds agent/keyring/dbus sockets; never hand it down.
    XDG_RUNTIME_DIR: path.join(created, "runtime"),
    APPDATA: path.join(created, "config"),
    LOCALAPPDATA: path.join(created, "data"),
    TMPDIR: path.join(created, "tmp"),
    TEMP: path.join(created, "tmp"),
    TMP: path.join(created, "tmp"),
  };
  let cleaned: Promise<void> | null = null;
  return {
    path: created,
    providerDir: path.join(created, "provider"),
    env,
    remoteEnv: {
      HOME: env.HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
    },
    cleanup: () => {
      cleaned ??= (async () => {
        try {
          await rm(created, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } finally {
          registered.delete(created);
        }
      })();
      return cleaned;
    },
  };
}

/**
 * Remove stale Paperclip-owned run homes (a server crash skips the per-run `finally`, which can
 * leave decrypted provider auth files in the temp directory). Only directories owned by this
 * user, matching a Paperclip prefix, older than `maxAgeMs`, and not live in this process.
 */
export async function sweepStaleRunHomes(input: {
  maxAgeMs: number;
  root?: string;
  now?: number;
}): Promise<{ removed: number }> {
  const root = input.root ?? os.tmpdir();
  const now = input.now ?? Date.now();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed };
  }
  for (const name of entries) {
    const isRunHome = name.startsWith(RUN_HOME_PREFIX);
    if (!isRunHome && !MANAGED_AI_HOME_PATTERN.test(name)) continue;
    const full = path.join(root, name);
    if (isRegisteredRunHome(full)) continue;
    try {
      // lstat: never follow a symlink that merely has a Paperclip-looking name.
      const info = await lstat(full);
      if (!info.isDirectory()) continue;
      if (uid !== null && info.uid !== uid) continue;
      // `paperclip-run-home-*` can collide with other tools' dirs (e.g. run scratch for an issue
      // prefix "HOME"), so require the marker this module writes. Age is measured from it, since a
      // directory's own mtime does not move when files change deeper inside.
      let ageMs = now - info.mtimeMs;
      if (isRunHome) {
        const marker = await stat(path.join(full, RUN_HOME_MARKER)).catch(() => null);
        if (!marker) continue;
        ageMs = now - marker.mtimeMs;
      }
      if (ageMs < input.maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best effort: a concurrently removed or unreadable entry is not a sweep failure.
    }
  }
  return { removed };
}
