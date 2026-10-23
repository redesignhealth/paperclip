/**
 * Per-run isolated home directory (TECH-7102).
 *
 * Agent CLIs read credentials and config from HOME / XDG_* (`~/.hermes/.env`, `~/.config/gh`, ...).
 * Running with the server user's home lets a run silently authenticate with whatever the host
 * holds. A run home is a fresh, owner-only directory tree that becomes the child's
 * HOME/XDG/TMPDIR, so a run only sees what Paperclip explicitly placed there.
 *
 * Limit (not claimed solved): this is path isolation, not a sandbox. A child running as the same
 * OS user can still read other files and /proc/<pid>/environ by absolute path. A server crash
 * skips `cleanup`, so a leftover home can remain in the temp directory.
 */
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUN_HOME_PREFIX = "paperclip-run-home-";

const SUBDIRS = ["config", "data", "cache", "state", "tmp", "runtime"] as const;

export interface RunHome {
  /** Root of the run home; also the child's HOME. */
  path: string;
  /** HOME/XDG/TMPDIR bindings. Apply LAST so adapter or agent env cannot redirect them. */
  env: Record<string, string>;
  /** Idempotent. Safe to call from success, failure, timeout and abort paths. */
  cleanup: () => Promise<void>;
}

export async function createRunHome(input: { prefix?: string; root?: string } = {}): Promise<RunHome> {
  const created = await mkdtemp(path.join(input.root ?? os.tmpdir(), input.prefix ?? RUN_HOME_PREFIX));
  try {
    // mkdtemp already creates 0700; chmod anyway so a permissive umask can never leave it readable.
    await chmod(created, 0o700);
    for (const dir of SUBDIRS) {
      const sub = path.join(created, dir);
      await mkdir(sub, { mode: 0o700 });
      // mkdir's mode is masked by the umask; chmod so a restrictive umask cannot leave fewer bits.
      await chmod(sub, 0o700);
    }
  } catch (error) {
    await rm(created, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const env: Record<string, string> = {
    HOME: created,
    USERPROFILE: created,
    XDG_CONFIG_HOME: path.join(created, "config"),
    XDG_DATA_HOME: path.join(created, "data"),
    XDG_CACHE_HOME: path.join(created, "cache"),
    XDG_STATE_HOME: path.join(created, "state"),
    // The server's XDG_RUNTIME_DIR holds agent/keyring/dbus sockets; never hand it down.
    XDG_RUNTIME_DIR: path.join(created, "runtime"),
    // Search-path variables: point them at the run home too so XDG-following tools cannot fall
    // back to inherited host directories.
    XDG_CONFIG_DIRS: path.join(created, "config"),
    XDG_DATA_DIRS: path.join(created, "data"),
    APPDATA: path.join(created, "config"),
    LOCALAPPDATA: path.join(created, "data"),
    TMPDIR: path.join(created, "tmp"),
    TEMP: path.join(created, "tmp"),
    TMP: path.join(created, "tmp"),
  };
  let cleaned = false;
  return {
    path: created,
    env,
    // Idempotent once it has succeeded. A failed removal is NOT memoised, so a later call retries.
    cleanup: async () => {
      if (cleaned) return;
      await rm(created, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      cleaned = true;
    },
  };
}
