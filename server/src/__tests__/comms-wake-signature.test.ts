import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMMS_WAKE_TIMESTAMP_TOLERANCE_SECONDS,
  parseCommsWakeSecret,
  signCommsWake,
  verifyCommsWakeSignature,
} from "../services/comms-wake-signature.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = String(NOW_MS / 1000);
const key = randomBytes(32);
const otherKey = randomBytes(32);
const webhookId = "6f1d0c5e-6f43-4c70-9a8e-1f6a3d2b9c11";
const rawBody = Buffer.from(JSON.stringify({ eventId: webhookId, name: "comms.wake" }));

function header(k = key, id = webhookId, ts = NOW_S, body = rawBody) {
  return `v1,${signCommsWake({ key: k, webhookId: id, timestamp: ts, rawBody: body })}`;
}

function verify(overrides: Partial<Parameters<typeof verifyCommsWakeSignature>[0]> = {}) {
  return verifyCommsWakeSignature({
    key,
    webhookId,
    timestamp: NOW_S,
    signatureHeader: header(),
    rawBody,
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe("comms wake signature verification", () => {
  it("accepts a valid signature", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("rejects a signature made with a different secret", () => {
    expect(verify({ signatureHeader: header(otherKey) })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects an altered body, id and timestamp", () => {
    expect(verify({ rawBody: Buffer.from(`${rawBody.toString()} `) }).ok).toBe(false);
    expect(verify({ webhookId: "6f1d0c5e-6f43-4c70-9a8e-1f6a3d2b9c12" }).ok).toBe(false);
    expect(verify({ timestamp: String(Number(NOW_S) + 1) }).ok).toBe(false);
  });

  it("accepts when one of several signatures is valid", () => {
    const signatureHeader = `v1,${randomBytes(32).toString("base64")} ${header()} v1,${randomBytes(32).toString("base64")}`;
    expect(verify({ signatureHeader })).toEqual({ ok: true });
  });

  it("ignores entries of other versions", () => {
    const good = header().slice("v1,".length);
    expect(verify({ signatureHeader: `v2,${good}` }).ok).toBe(false);
    expect(verify({ signatureHeader: `v2,${good} ${header()}` })).toEqual({ ok: true });
  });

  it("rejects a stale timestamp in either direction and accepts the edge of the window", () => {
    const tolerance = COMMS_WAKE_TIMESTAMP_TOLERANCE_SECONDS;
    for (const ts of [String(Number(NOW_S) - tolerance - 1), String(Number(NOW_S) + tolerance + 1)]) {
      expect(verify({ timestamp: ts, signatureHeader: header(key, webhookId, ts) })).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    }
    const edge = String(Number(NOW_S) - tolerance);
    expect(verify({ timestamp: edge, signatureHeader: header(key, webhookId, edge) })).toEqual({ ok: true });
  });

  it("rejects malformed headers", () => {
    for (const signatureHeader of [
      "",
      "garbage",
      "v1",
      "v1,",
      "v1,not base64!",
      `v1:${header().slice(3)}`,
      `v1,${"A".repeat(5000)}`,
      Array.from({ length: 11 }, () => header()).join(" "),
    ]) {
      expect(verify({ signatureHeader }).ok, signatureHeader.slice(0, 20)).toBe(false);
    }
    // A truncated but otherwise valid signature must not throw.
    expect(verify({ signatureHeader: header().slice(0, 20) }).ok).toBe(false);
  });

  it("rejects missing or malformed id, timestamp and signature headers", () => {
    expect(verify({ webhookId: undefined })).toEqual({ ok: false, reason: "missing_header" });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing_header" });
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: "missing_header" });
    expect(verify({ timestamp: "12.5" })).toEqual({ ok: false, reason: "malformed_timestamp" });
    expect(verify({ timestamp: "abc" })).toEqual({ ok: false, reason: "malformed_timestamp" });
  });
});

describe("comms wake secret parsing", () => {
  it("decodes whsec_ secrets into key bytes", () => {
    expect(parseCommsWakeSecret(`whsec_${key.toString("base64")}`)?.equals(key)).toBe(true);
  });

  it("rejects secrets without the prefix or with invalid base64", () => {
    expect(parseCommsWakeSecret(key.toString("base64"))).toBeNull();
    expect(parseCommsWakeSecret("whsec_")).toBeNull();
    expect(parseCommsWakeSecret("whsec_!!!")).toBeNull();
  });
});
