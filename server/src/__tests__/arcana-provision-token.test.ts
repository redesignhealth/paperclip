import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mintArcanaProvisionToken, provisionArcanaBrain } from "../services/arcana-provisioner-client.js";

const KEY = "synthetic-signing-key-0123456789abcdef0123456789";
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("mintArcanaProvisionToken", () => {
  it("builds the rh-auth service JWT Arcana verifies", () => {
    const token = mintArcanaProvisionToken(KEY, 1_700_000_000_500);
    const [h, c, sig] = token.split(".");
    expect(token).not.toMatch(/[=+/]/);
    expect(decode(h!)).toEqual({ alg: "HS256", kid: "paperclip-brain-provision", typ: "JWT" });
    expect(decode(c!)).toEqual({
      sub: "paperclip-brain-provisioner",
      iss: "rh-auth",
      aud: "arcana-brain",
      iat: 1_700_000_000,
      exp: 1_700_000_060,
      scopes: ["arc:brain:provision"],
      kind: "service",
    });
    expect(createHmac("sha256", KEY).update(`${h}.${c}`).digest("base64url")).toBe(sig);
    expect(createHmac("sha256", "other-key").update(`${h}.${c}`).digest("base64url")).not.toBe(sig);
  });

  it("stays well inside the 15 minute authority cap", () => {
    const claims = decode(mintArcanaProvisionToken(KEY, 5_000_000).split(".")[1]!);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(900);
  });

  it("mints a fresh token for every provision attempt and never leaks the key", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).authorization!);
      throw new Error(`network down ${KEY}`);
    });
    let clock = 1_700_000_000_000;
    const request = { agentPrincipalId: "p", companyId: "c", runtimeId: "r", exchangeKeyHash: "0".repeat(64) };
    const config = { arcanaUrl: "https://arcana.test", provisionKey: KEY };
    const first = await provisionArcanaBrain(config, request, fetchImpl, 1000, () => clock);
    clock += 120_000;
    const second = await provisionArcanaBrain(config, request, fetchImpl, 1000, () => clock);
    expect(first).toEqual({ ok: false, reason: "provisioner_failed", retryable: true });
    expect(second).toEqual(first);
    expect(seen[0]).not.toBe(seen[1]);
    expect(decode(seen[1]!.split(".")[1]!.replace("Bearer ", "")).iat).toBe(1_700_000_120);
    expect(JSON.stringify(first) + seen.join()).not.toContain(KEY);
  });
});
