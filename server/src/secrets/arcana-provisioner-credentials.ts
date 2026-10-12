/**
 * Boot-time snapshot of the Arcana provisioner control-plane settings (TECH-7252), the same
 * early-capture / re-scrub pattern as the comms-board provisioner (TECH-7228).
 *
 * - The FIRST capture is the only authoritative source; later values are never adopted.
 * - The provisioning signing key variable is deleted from `env` on EVERY capture/scrub call.
 * - The endpoint URL is frozen in the same snapshot so a later environment change cannot redirect
 *   tokens minted from the key to another host. It is not a secret, so it stays in `env`.
 * - Values are trimmed; blank is missing. Nothing here logs or exposes token values.
 */
import { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_KEY_ENV, ARCANA_URL_ENV } from "@paperclipai/shared/arcana-provisioner-env";

// Canonical names live in @paperclipai/shared so the CLI `.env` preload reserves exactly these keys.
export { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_KEY_ENV, ARCANA_URL_ENV };

/** Trimmed values, or null when missing/blank. Never validated here. */
export interface ArcanaProvisionerSnapshot {
  readonly arcanaUrl: string | null;
  readonly provisionKey: string | null;
  /** The Arcana MCP endpoint for the static template (TECH-7253). Frozen with the rest; not a secret. */
  readonly mcpUrl: string | null;
}

const EMPTY_SNAPSHOT: ArcanaProvisionerSnapshot = Object.freeze({ arcanaUrl: null, provisionKey: null, mcpUrl: null });

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
    provisionKey: readTrimmed(env, ARCANA_PROVISION_KEY_ENV),
    mcpUrl: readTrimmed(env, ARCANA_MCP_URL_ENV),
  });
}

let captured: ArcanaProvisionerSnapshot = EMPTY_SNAPSHOT;
let didCapture = false;

/** Captures (first call only) and always scrubs the provision key. Returns only whether both were present. */
export function captureAndScrubArcanaProvisionerCredentials(env: NodeJS.ProcessEnv = process.env): { configured: boolean } {
  if (!didCapture) {
    didCapture = true;
    captured = arcanaSnapshotFromEnv(env);
  }
  delete env[ARCANA_PROVISION_KEY_ENV];
  return { configured: captured.arcanaUrl !== null && captured.provisionKey !== null };
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
