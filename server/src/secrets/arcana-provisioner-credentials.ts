/**
 * Boot-time snapshot of the Arcana provisioner control-plane settings (TECH-7252), the same
 * early-capture / re-scrub pattern as the comms-board provisioner (TECH-7228).
 *
 * - The FIRST capture is the only authoritative source; later values are never adopted.
 * - The bearer token variable is deleted from `env` on EVERY capture/scrub call.
 * - The endpoint URL is frozen in the same snapshot so a later environment change cannot redirect the
 *   bearer token to another host. It is not a secret, so it stays in `env`.
 * - Values are trimmed; blank is missing. Nothing here logs or exposes token values.
 */
export const ARCANA_URL_ENV = "PAPERCLIP_ARCANA_URL";
export const ARCANA_PROVISION_TOKEN_ENV = "PAPERCLIP_ARCANA_PROVISION_TOKEN";

/** Trimmed values, or null when missing/blank. Never validated here. */
export interface ArcanaProvisionerSnapshot {
  readonly arcanaUrl: string | null;
  readonly provisionToken: string | null;
}

const EMPTY_SNAPSHOT: ArcanaProvisionerSnapshot = Object.freeze({ arcanaUrl: null, provisionToken: null });

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pure conversion of an environment object into a frozen snapshot. Does not read or mutate process.env. */
export function arcanaSnapshotFromEnv(env: NodeJS.ProcessEnv): ArcanaProvisionerSnapshot {
  return Object.freeze({
    arcanaUrl: readTrimmed(env, ARCANA_URL_ENV),
    provisionToken: readTrimmed(env, ARCANA_PROVISION_TOKEN_ENV),
  });
}

let captured: ArcanaProvisionerSnapshot = EMPTY_SNAPSHOT;
let didCapture = false;

/** Captures (first call only) and always scrubs the provision token. Returns only whether both were present. */
export function captureAndScrubArcanaProvisionerCredentials(env: NodeJS.ProcessEnv = process.env): { configured: boolean } {
  if (!didCapture) {
    didCapture = true;
    captured = arcanaSnapshotFromEnv(env);
  }
  delete env[ARCANA_PROVISION_TOKEN_ENV];
  return { configured: captured.arcanaUrl !== null && captured.provisionToken !== null };
}

/** The boot snapshot (empty before any capture; never falls back to reading `process.env`). */
export function readArcanaProvisionerSnapshot(): ArcanaProvisionerSnapshot {
  return captured;
}

/** Resets the captured state. Strictly for targeted tests. */
export function __resetArcanaProvisionerForTests(): void {
  captured = EMPTY_SNAPSHOT;
  didCapture = false;
}
