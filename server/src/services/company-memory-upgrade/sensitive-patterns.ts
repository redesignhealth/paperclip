/**
 * Sensitive content detection for company memory upgrade census (TECH-8191).
 *
 * CRITICAL ARCHITECTURAL CONTRACT:
 * These functions count detection hits only.
 * They MUST NEVER emit, log, or return the matched sensitive text.
 */

export const SENSITIVE_FAMILIES = {
  privateKey: /-----BEGIN[ A-Z0-9_-]+PRIVATE KEY/i,
  bearerToken: /\bbearer\s+[a-zA-Z0-9_.\-~+/=]{20,}\b/i,
  apiKey: /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9]{10,}|pat_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})\b/i,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  creditCard: /\b(?:\d{4}[ -]?){3}\d{4}\b/,
  passwordAssignment: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
} as const;

export type SensitiveFamilyName = keyof typeof SENSITIVE_FAMILIES;

export interface SensitiveDetectionResult {
  isSensitive: boolean;
  matches: Record<SensitiveFamilyName, boolean>;
}

/**
 * Checks a text string against sensitive regex families.
 * Returns boolean match indicators without leaking the sensitive text.
 */
export function detectSensitiveFamilies(text: string | null | undefined): SensitiveDetectionResult {
  const matches: Record<SensitiveFamilyName, boolean> = {
    privateKey: false,
    bearerToken: false,
    apiKey: false,
    ssn: false,
    creditCard: false,
    passwordAssignment: false,
  };

  if (!text) {
    return { isSensitive: false, matches };
  }

  let isSensitive = false;

  for (const [family, regex] of Object.entries(SENSITIVE_FAMILIES) as Array<[SensitiveFamilyName, RegExp]>) {
    if (regex.test(text)) {
      matches[family] = true;
      isSensitive = true;
    }
  }

  return { isSensitive, matches };
}
