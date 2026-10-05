export const PAPERCLIP_DEFAULT_OPENAI_API_KEY = "PAPERCLIP_DEFAULT_OPENAI_API_KEY";

let captured: string | null = null;
let didCapture = false;
let isInvalid = false;

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
 * Captures and scrubs the platform default OpenAI API key from process environment.
 *
 * Security & Lifecycle Guarantees:
 * - Always deletes `PAPERCLIP_DEFAULT_OPENAI_API_KEY` from `env` unconditionally.
 * - Captures only on the FIRST call: trims and validates printable non-whitespace
 *   ASCII characters with length 20..512. Missing or invalid values resolve to null.
 * - Idempotent: subsequent calls delete any newly-repopulated env entry but do NOT
 *   adopt it (the initial capture remains frozen).
 * - Never logs or exposes raw key values, lengths, hashes, or fingerprints.
 */
export function captureAndScrubPlatformDefaultOpenAiKey(
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; invalid: boolean } {
  const raw = env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];
  if (PAPERCLIP_DEFAULT_OPENAI_API_KEY in env) {
    delete env[PAPERCLIP_DEFAULT_OPENAI_API_KEY];
  }

  if (!didCapture) {
    didCapture = true;
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
 * Returns the captured platform default OpenAI API key, or null if not configured or invalid.
 * Internal backend use only.
 */
export function readPlatformDefaultOpenAiKey(): string | null {
  return captured;
}

/**
 * Resets the captured state. Strictly for targeted tests.
 */
export function __resetForTests(): void {
  captured = null;
  didCapture = false;
  isInvalid = false;
}
