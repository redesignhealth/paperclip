import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks (v1) verification for comms board wake events.
 *
 * Signed string: `${webhook-id}.${webhook-timestamp}.${raw body}`.
 * Key: the base64-decoded bytes after the `whsec_` prefix of the secret.
 * Header: space-separated `v1,<base64 HMAC-SHA256>` entries; any match accepts.
 *
 * Nothing here logs or returns the secret or the signature header. Failure
 * reasons are coarse codes so a caller cannot learn which check failed from
 * anything but its own logs.
 */

export const COMMS_WAKE_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";
const MAX_SIGNATURE_HEADER_LENGTH = 4096;
const MAX_SIGNATURE_ENTRIES = 10;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const UNIX_SECONDS_PATTERN = /^\d{1,12}$/;

export type CommsWakeSignatureFailure =
  | "missing_header"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "malformed_signature"
  | "signature_mismatch";

export type CommsWakeSignatureResult =
  | { ok: true }
  | { ok: false; reason: CommsWakeSignatureFailure };

/** Decodes a `whsec_<base64>` secret into HMAC key bytes. Returns null when the secret is not in that form. */
export function parseCommsWakeSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(SECRET_PREFIX)) return null;
  const encoded = trimmed.slice(SECRET_PREFIX.length);
  if (!BASE64_PATTERN.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

function digest(key: Buffer, webhookId: string, timestamp: string, rawBody: Buffer): Buffer {
  return createHmac("sha256", key).update(`${webhookId}.${timestamp}.`).update(rawBody).digest();
}

/** Computes the base64 `v1` signature for a webhook. Exposed so tests share the one implementation. */
export function signCommsWake(input: {
  key: Buffer;
  webhookId: string;
  timestamp: string;
  rawBody: Buffer;
}): string {
  return digest(input.key, input.webhookId, input.timestamp, input.rawBody).toString("base64");
}

function candidateSignatures(header: string): Buffer[] | null {
  if (header.length === 0 || header.length > MAX_SIGNATURE_HEADER_LENGTH) return null;
  const entries = header.split(" ").filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > MAX_SIGNATURE_ENTRIES) return null;
  const candidates: Buffer[] = [];
  for (const entry of entries) {
    const comma = entry.indexOf(",");
    if (comma < 0) continue;
    // Other signature versions may sit beside v1; only v1 is accepted.
    if (entry.slice(0, comma) !== "v1") continue;
    const encoded = entry.slice(comma + 1);
    if (!BASE64_PATTERN.test(encoded)) continue;
    candidates.push(Buffer.from(encoded, "base64"));
  }
  return candidates.length > 0 ? candidates : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cheap request checks that need no secret: headers present and well formed (`webhook-id` a uuid, timestamp an
 * integer, at least one `v1,` entry) and the timestamp inside the tolerance window. Run before the signing secret is
 * read from the vault so unauthenticated junk never causes an audited secret read.
 */
export function precheckCommsWakeHeaders(input: {
  webhookId: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  nowMs?: number;
  toleranceSeconds?: number;
}): CommsWakeSignatureFailure | null {
  if (!input.webhookId || !input.timestamp || !input.signatureHeader) return "missing_header";
  if (!UUID_PATTERN.test(input.webhookId)) return "missing_header";
  if (!UNIX_SECONDS_PATTERN.test(input.timestamp)) return "malformed_timestamp";
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? COMMS_WAKE_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(input.timestamp)) > tolerance) return "stale_timestamp";
  if (!candidateSignatures(input.signatureHeader)) return "malformed_signature";
  return null;
}

export function verifyCommsWakeSignature(input: {
  key: Buffer;
  webhookId: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowMs?: number;
  toleranceSeconds?: number;
}): CommsWakeSignatureResult {
  if (!input.webhookId || !input.timestamp || !input.signatureHeader) {
    return { ok: false, reason: "missing_header" };
  }
  if (!UNIX_SECONDS_PATTERN.test(input.timestamp)) {
    return { ok: false, reason: "malformed_timestamp" };
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? COMMS_WAKE_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(input.timestamp)) > tolerance) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const candidates = candidateSignatures(input.signatureHeader);
  if (!candidates) return { ok: false, reason: "malformed_signature" };

  const expected = digest(input.key, input.webhookId, input.timestamp, input.rawBody);
  let matched = false;
  for (const candidate of candidates) {
    // timingSafeEqual throws on unequal lengths, so compare lengths first.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}
