/**
 * Platform-default Ramp Router API key (TECH-7959). A 1:1 clone of platform-default-openai-key.ts.
 *
 * The deployment injects the key as PAPERCLIP_DEFAULT_ROUTER_API_KEY. The name is deliberately NOT
 * RAMP_ROUTER_*: the Hermes adapter treats every RAMP_ROUTER_* name except the canonical key as an
 * endpoint override, and the child-env allowlist never forwards either name, so the server's own key
 * can never reach an agent process except through the per-company managed secret bound at create.
 */
export const PAPERCLIP_DEFAULT_ROUTER_API_KEY = "PAPERCLIP_DEFAULT_ROUTER_API_KEY";

/**
 * Operator flag for the boot-time rotation reconcile of managed platform Router secrets. Frozen at
 * the first capture (like the key itself); only the exact value "true" (case-insensitive, trimmed)
 * enables it. Default off.
 */
export const PAPERCLIP_PLATFORM_ROUTER_RECONCILE = "PAPERCLIP_PLATFORM_ROUTER_RECONCILE";

let captured: string | null = null;
let didCapture = false;
let isInvalid = false;
let reconcileEnabled = false;

function isPrintableNonWhitespaceAscii(str: string): boolean {
  if (str.length < 20 || str.length > 512) {
    return false;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // ASCII 33 ('!') through 126 ('~') are printable non-whitespace characters
    if (code < 33 || code > 126) {
      return false;
    }
  }
  return true;
}

/**
 * Captures and scrubs the platform default Ramp Router API key from process environment.
 *
 * Security & Lifecycle Guarantees:
 * - Always deletes `PAPERCLIP_DEFAULT_ROUTER_API_KEY` from `env` unconditionally.
 * - Captures only on the FIRST call: trims and validates printable non-whitespace
 *   ASCII characters with length 20..512. Missing or invalid values resolve to null.
 *   The reconcile flag is frozen on that same first call.
 * - Idempotent: subsequent calls delete any newly-repopulated env entry but do NOT
 *   adopt it (the initial capture remains frozen).
 * - Never logs or exposes raw key values, lengths, hashes, or fingerprints.
 */
export function captureAndScrubPlatformDefaultRouterKey(
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; invalid: boolean } {
  const raw = env[PAPERCLIP_DEFAULT_ROUTER_API_KEY];
  if (PAPERCLIP_DEFAULT_ROUTER_API_KEY in env) {
    delete env[PAPERCLIP_DEFAULT_ROUTER_API_KEY];
  }

  if (!didCapture) {
    didCapture = true;
    reconcileEnabled = env[PAPERCLIP_PLATFORM_ROUTER_RECONCILE]?.trim().toLowerCase() === "true";
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (isPrintableNonWhitespaceAscii(trimmed)) {
        captured = trimmed;
        isInvalid = false;
      } else {
        captured = null;
        isInvalid = true;
      }
    } else {
      captured = null;
      isInvalid = false;
    }
  }

  return {
    configured: captured !== null,
    invalid: isInvalid,
  };
}

/**
 * Returns the captured platform default Ramp Router API key, or null if not configured or invalid.
 * Internal backend use only.
 */
export function readPlatformDefaultRouterKey(): string | null {
  return captured;
}

/** Whether the boot-time reconcile flag was set at the first capture. Never reads `process.env`. */
export function isPlatformRouterReconcileEnabled(): boolean {
  return reconcileEnabled;
}

/**
 * Resets the captured state. Strictly for targeted tests.
 */
export function __resetForTests(): void {
  captured = null;
  didCapture = false;
  isInvalid = false;
  reconcileEnabled = false;
}
