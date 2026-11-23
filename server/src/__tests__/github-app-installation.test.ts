import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_APP_TOKEN_PERMISSIONS,
  mintGitHubAppInstallationToken,
  normalizeAppRepositories,
  readGitHubAppConfig,
  resetGitHubAppCachesForTest,
} from "../services/github-app-installation.js";

// Throwaway key generated at test time; never written to disk.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
  PAPERCLIP_GITHUB_APP_ID: "12345",
  PAPERCLIP_GITHUB_APP_INSTALLATION_ID: "678",
  PAPERCLIP_GITHUB_APP_PRIVATE_KEY: privateKey,
} as NodeJS.ProcessEnv;

const T0 = Date.parse("2026-01-01T00:00:00Z");
const MINUTE = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetch(tokens: string[] = ["ghs_test_token_1", "ghs_test_token_2"]) {
  let n = 0;
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({
      url: String(url), method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers?.authorization ?? null,
    });
    if (String(url).endsWith("/app")) return json({ slug: "rh-code-factory" });
    return json({ token: tokens[n++ % tokens.length], expires_at: new Date(T0 + 60 * MINUTE).toISOString() }, 201);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("GitHub App installation credentials", () => {
  beforeEach(() => resetGitHubAppCachesForTest());

  it("requests exactly the scoped repositories and contents/pull_requests write", async () => {
    const { fetchImpl, calls } = makeFetch();
    const result = await mintGitHubAppInstallationToken({
      repositories: ["redesignhealth/zeta", "redesignhealth/alpha"], env, fetchImpl, now: () => T0,
    });
    expect(result).toMatchObject({ ok: true, value: { token: "ghs_test_token_1", identity: { userId: "12345", login: "rh-code-factory[bot]" } } });
    const mint = calls.find((call) => call.url.endsWith("/access_tokens"))!;
    expect(mint.url).toBe("https://api.github.com/app/installations/678/access_tokens");
    expect(mint.method).toBe("POST");
    expect(mint.body).toEqual({
      repositories: ["alpha", "zeta"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(GITHUB_APP_TOKEN_PERMISSIONS).toEqual({ contents: "write", pull_requests: "write" });
    expect(mint.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it.each([
    ["empty list", []],
    ["missing list", undefined],
    ["non-array", "redesignhealth/repo"],
    ["non-string entry", ["redesignhealth/ok", 42]],
    ["blank entry", ["redesignhealth/ok", "  "]],
    ["owner only", ["redesignhealth/"]],
    ["path traversal", ["redesignhealth/.."]],
  ])("refuses to mint an unscoped token: %s", async (_label, repositories) => {
    const { fetchImpl } = makeFetch();
    const result = await mintGitHubAppInstallationToken({ repositories, env, fetchImpl, now: () => T0 });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(normalizeAppRepositories(repositories)).toBeNull();
  });

  it.each([
    ["no env", {}],
    ["no key", { ...env, PAPERCLIP_GITHUB_APP_PRIVATE_KEY: "" }],
    ["no installation id", { ...env, PAPERCLIP_GITHUB_APP_INSTALLATION_ID: undefined }],
    ["no app id", { ...env, PAPERCLIP_GITHUB_APP_ID: undefined }],
  ])("is unavailable with a redacted reason when env is missing: %s", async (_label, badEnv) => {
    const { fetchImpl } = makeFetch();
    const result = await mintGitHubAppInstallationToken({
      repositories: ["o/r"], env: badEnv as NodeJS.ProcessEnv, fetchImpl, now: () => T0,
    });
    expect(result).toEqual({ ok: false, error: "The GitHub App installation is not configured on this server" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tolerates a PEM with literal \\n sequences", () => {
    const flat = privateKey.trim().replace(/\n/g, "\\n");
    const config = readGitHubAppConfig({ ...env, PAPERCLIP_GITHUB_APP_PRIVATE_KEY: flat });
    expect(config?.privateKey).toBe(privateKey.trim());
  });

  it("caches per repo set and re-mints within 5 minutes of expiry", async () => {
    const { fetchImpl, calls } = makeFetch();
    const mint = (repositories: string[], now: number) =>
      mintGitHubAppInstallationToken({ repositories, env, fetchImpl, now: () => now });
    const mints = () => calls.filter((call) => call.url.endsWith("/access_tokens")).length;
    const first = await mint(["o/a"], T0);
    expect(await mint(["o/a"], T0 + 54 * MINUTE)).toEqual(first);
    expect(mints()).toBe(1);
    // Different repo set is a different cache entry.
    const other = await mint(["o/b"], T0 + 54 * MINUTE);
    expect(other).toMatchObject({ ok: true, value: { token: "ghs_test_token_2" } });
    expect(mints()).toBe(2);
    // 55 minutes in: within 5 minutes of expiry, so mint again.
    await mint(["o/a"], T0 + 55 * MINUTE);
    expect(mints()).toBe(3);
  });

  it("never leaks the key, JWT, or token through failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const failing = vi.fn(async () => json({ message: "Bad credentials ghs_secret_in_body" }, 401)) as unknown as typeof fetch;
    const result = await mintGitHubAppInstallationToken({ repositories: ["o/r"], env, fetchImpl: failing, now: () => T0 });
    expect(result).toEqual({ ok: false, error: "GitHub App installation credentials are temporarily unavailable" });
    const bad = await mintGitHubAppInstallationToken({
      repositories: ["o/r"], env: { ...env, PAPERCLIP_GITHUB_APP_PRIVATE_KEY: "not-a-key-SENTINEL" }, fetchImpl: failing, now: () => T0,
    });
    const text = JSON.stringify([result, bad, spy.mock.calls, log.mock.calls]);
    expect(text).not.toMatch(/ghs_secret|SENTINEL|BEGIN|Bearer/);
    spy.mockRestore();
    log.mockRestore();
  });
});
