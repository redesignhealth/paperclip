/**
 * Boot-time snapshot of the comms-board provisioner control-plane settings (TECH-7228).
 *
 * The two bearer credentials (board `comms:admin`, ownership `ownership:write`) used to be read lazily
 * from `process.env` whenever a default-MCP setup ran. That left them in the server's environment for
 * the whole process lifetime, where any default-env child helper inherits them, and where a later
 * `.env` load on writable storage could repopulate or replace them. This module applies the same
 * early-capture / re-scrub pattern as the platform default OpenAI key:
 *
 * - The FIRST capture is the only authoritative source. It runs from the first bootstrap import, before
 *   dotenv files, config parsing, instrumentation or any child spawn.
 * - Both token variables are deleted from `env` on EVERY capture/scrub call, whether or not the value is
 *   adopted. A value that appears later (including when the first capture saw nothing) is deleted and
 *   never adopted.
 * - The endpoint URLs are frozen in the same snapshot so a later environment change cannot redirect the
 *   bearer tokens to a different host. They are not secrets, so they are left in `env`.
 * - Values are trimmed; blank is treated as missing. Validation (endpoint shape, missing vs invalid)
 *   stays in `resolveCommsBoardProvisionerConfig`, unchanged.
 * - Nothing here logs or exposes token values, lengths, hashes or fingerprints.
 */
export const COMMS_BOARD_MCP_URL_ENV = "PAPERCLIP_COMMS_BOARD_MCP_URL";
export const COMMS_BOARD_ADMIN_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN";
export const COMMS_BOARD_OWNERSHIP_API_URL_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL";
export const COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV = "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN";

/** Trimmed values, or null when missing/blank. Never validated here. */
export interface CommsBoardProvisionerSnapshot {
  readonly boardMcpUrl: string | null;
  readonly boardAdminToken: string | null;
  readonly ownershipApiUrl: string | null;
  readonly ownershipApiToken: string | null;
}

const EMPTY_SNAPSHOT: CommsBoardProvisionerSnapshot = Object.freeze({
  boardMcpUrl: null,
  boardAdminToken: null,
  ownershipApiUrl: null,
  ownershipApiToken: null,
});

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pure conversion of an environment object into a frozen snapshot. Does not read or mutate process.env. */
export function snapshotFromEnv(env: NodeJS.ProcessEnv): CommsBoardProvisionerSnapshot {
  return Object.freeze({
    boardMcpUrl: readTrimmed(env, COMMS_BOARD_MCP_URL_ENV),
    boardAdminToken: readTrimmed(env, COMMS_BOARD_ADMIN_TOKEN_ENV),
    ownershipApiUrl: readTrimmed(env, COMMS_BOARD_OWNERSHIP_API_URL_ENV),
    ownershipApiToken: readTrimmed(env, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV),
  });
}

let captured: CommsBoardProvisionerSnapshot = EMPTY_SNAPSHOT;
let didCapture = false;

/**
 * Captures (first call only) and scrubs the comms-board provisioner credentials.
 *
 * Always deletes both token variables from `env`. Later calls never adopt new values.
 * Returns only whether all four settings were present at first capture.
 */
export function captureAndScrubCommsBoardProvisionerCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean } {
  if (!didCapture) {
    didCapture = true;
    captured = snapshotFromEnv(env);
  }
  delete env[COMMS_BOARD_ADMIN_TOKEN_ENV];
  delete env[COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];
  return {
    configured:
      captured.boardMcpUrl !== null &&
      captured.boardAdminToken !== null &&
      captured.ownershipApiUrl !== null &&
      captured.ownershipApiToken !== null,
  };
}

/**
 * The boot snapshot. Before any capture it is the empty (not configured) snapshot: this never falls
 * back to reading `process.env`, so a missing bootstrap cannot revive the lazy global lookup.
 * Internal backend use only.
 */
export function readCommsBoardProvisionerSnapshot(): CommsBoardProvisionerSnapshot {
  return captured;
}

/** Resets the captured state. Strictly for targeted tests. */
export function __resetForTests(): void {
  captured = EMPTY_SNAPSHOT;
  didCapture = false;
}
