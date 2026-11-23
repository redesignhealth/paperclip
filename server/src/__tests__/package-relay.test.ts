import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  PACKAGE_RELAY_GITEA_PACKAGES_ENV,
  PACKAGE_RELAY_GITEA_URL_ENV,
  normalizePackageName,
  packageRelayRoutes,
} from "../routes/package-relay.js";

const GITEA = "https://gitea.example.ts.net/api/packages/rh/pypi";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const TOKEN = "gitea-read-token-1";
const env = { [PACKAGE_RELAY_GITEA_URL_ENV]: GITEA, [PACKAGE_RELAY_GITEA_PACKAGES_ENV]: "rh-auth, rh_lib" } as NodeJS.ProcessEnv;

const INDEX = `<!DOCTYPE html><html><body>
<a href="${GITEA}/files/rh-auth/1.2.0/rh_auth-1.2.0-py3-none-any.whl#sha256=0123456789abcdef0123456789abcdef" data-requires-python="&gt;=3.10">rh_auth-1.2.0-py3-none-any.whl</a><br>
<a href="https://evil.example.com/rh_auth-9.9.9-py3-none-any.whl#sha256=bad">evil</a><br>
<a data-original-href="${GITEA}/files/rh-auth/3.0.0/rh_auth-3.0.0-py3-none-any.whl" href="https://evil.example.com/x.whl">sneaky</a><br>
<a href="${GITEA}/files/rh-auth/%E0%A4%A/rh_auth-3.0.0-py3-none-any.whl">malformed</a><br>
<a href="${GITEA}/files/other-pkg/1.0.0/other_pkg-1.0.0-py3-none-any.whl">other</a><br>
</body></html>`;

function build(opts: { actor?: Record<string, unknown>; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; optedIn?: string[]; token?: string | null } = {}) {
  const fetchImpl = opts.fetchImpl ?? vi.fn(async (url: string | URL | Request) =>
    String(url).includes("/simple/")
      ? new Response(INDEX, { status: 200, headers: { "content-type": "text/html" } })
      : new Response(Buffer.from("WHEELBYTES"), { status: 200, headers: { "content-type": "application/octet-stream" } }));
  const isOptedIn = vi.fn(async (agentId: string, relay: string) => (opts.optedIn ?? [AGENT_A]).includes(agentId) && relay === "gitea");
  const resolveToken = vi.fn(async () => (opts.token === undefined ? TOKEN : opts.token));
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", agentId: AGENT_A, companyId: COMPANY, runId: "run-1", ...opts.actor } as typeof req.actor;
    next();
  });
  app.use("/api", packageRelayRoutes({} as Db, { env: opts.env ?? env, fetchImpl: fetchImpl as typeof fetch, isOptedIn, resolveToken }));
  return { app, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, isOptedIn, resolveToken };
}

const BASE = "/api/package-relay/gitea";

describe("package relay (TECH-9786)", () => {
  it("normalizes PEP 503 names", () => {
    expect(normalizePackageName("RH_Lib.core")).toBe("rh-lib-core");
  });

  it("serves the index with only this registry's own file links, rewritten to the relay", async () => {
    const { app, fetchImpl } = build();
    const res = await request(app).get(`${BASE}/simple/rh-auth/`).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain('href="../../files/rh-auth/1.2.0/rh_auth-1.2.0-py3-none-any.whl#sha256=0123456789abcdef0123456789abcdef"');
    expect(res.text).toContain('data-requires-python="&gt;=3.10"');
    expect(res.text).not.toContain("evil.example.com");
    expect(res.text).not.toContain("3.0.0");
    expect(res.text).not.toContain("sneaky");
    expect(res.text).not.toContain("malformed");
    expect(res.text).not.toContain("other-pkg");
    expect(res.text).not.toContain(GITEA);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITEA}/simple/rh-auth/`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    const auth = (init.headers as Record<string, string>).authorization!;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(`paperclip-relay:${TOKEN}`);
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
    expect(res.text).not.toContain(TOKEN);
  });

  it("emits a fresh page: no <base>, no other tags, hostile fragments and duplicate hrefs dropped", async () => {
    const hostile = `<base href="https://evil.example.com/"><script>x</script>
<a href="${GITEA}/files/rh-auth/1.0.0/a-1.0.0.whl#sha256=0123456789abcdef0123456789abcdef" href="https://evil.example.com/dup" data-requires-python="&gt;=3.10">a-1.0.0.whl</a>
<a href="${GITEA}/files/rh-auth/1.1.0/a-1.1.0.whl#$&quot;&gt;&lt;script">bad fragment</a>
<a href="${GITEA}/files/rh-auth/1.2.0/a-1.2.0.whl" data-requires-python="&quot;&gt;&lt;img src=x">bad python</a>`;
    const { app } = build({ fetchImpl: vi.fn(async () => new Response(hostile, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
    const res = await request(app).get(`${BASE}/simple/rh-auth/`).expect(200);
    expect(res.text).not.toMatch(/<base|<script|evil\.example\.com|<img/i);
    expect(res.text).toContain('href="../../files/rh-auth/1.0.0/a-1.0.0.whl#sha256=0123456789abcdef0123456789abcdef"');
    expect(res.text).toContain('data-requires-python="&gt;=3.10"');
    expect(res.text).not.toContain("1.1.0");
    expect(res.text).toContain('href="../../files/rh-auth/1.2.0/a-1.2.0.whl"');
    expect(res.text).not.toContain("data-requires-python=\"&quot;");
  });

  it("serves a file for an allowed package", async () => {
    const { app, fetchImpl } = build();
    const res = await request(app).get(`${BASE}/files/rh_lib/2.0.0/rh_lib-2.0.0.tar.gz`).expect(200);
    expect(res.body.toString()).toBe("WHEELBYTES");
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(`${GITEA}/files/rh_lib/2.0.0/rh_lib-2.0.0.tar.gz`);
  });

  it("refuses packages that are not on the allowlist without calling the registry", async () => {
    const { app, fetchImpl } = build();
    await request(app).get(`${BASE}/simple/requests/`).expect(404);
    await request(app).get(`${BASE}/files/requests/1.0/requests-1.0.tar.gz`).expect(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses odd version and filename segments", async () => {
    const { app, fetchImpl } = build();
    await request(app).get(`${BASE}/files/rh-auth/1.0/..%2Fsecret`).expect(404);
    await request(app).get(`${BASE}/files/rh-auth/1.0/pkg.exe`).expect(404);
    await request(app).get(`${BASE}/files/rh-auth/%2e%2e/rh_auth-1.0.whl`).expect(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an agent that has not opted in, and non-run callers", async () => {
    const b = build({ actor: { agentId: AGENT_B } });
    await request(b.app).get(`${BASE}/simple/rh-auth/`).expect(403);
    expect(b.fetchImpl).not.toHaveBeenCalled();
    for (const actor of [{ source: "agent_key" }, { runId: undefined }, { type: "board" }]) {
      const c = build({ actor });
      await request(c.app).get(`${BASE}/simple/rh-auth/`).expect(403);
      expect(c.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("answers 404 (so the installer falls through to the default index) when not configured, and 403 when the company has no token", async () => {
    const off = build({ env: {} as NodeJS.ProcessEnv });
    await request(off.app).get(`${BASE}/simple/rh-auth/`).expect(404);
    expect(off.fetchImpl).not.toHaveBeenCalled();
    const httpOnly = build({ env: { ...env, [PACKAGE_RELAY_GITEA_URL_ENV]: "http://gitea.example.com/pypi" } as NodeJS.ProcessEnv });
    await request(httpOnly.app).get(`${BASE}/simple/rh-auth/`).expect(404);
    const noToken = build({ token: null });
    await request(noToken.app).get(`${BASE}/simple/rh-auth/`).expect(403);
    expect(noToken.fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows or passes through redirects and maps upstream failures", async () => {
    const redirect = build({ fetchImpl: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } })) as unknown as typeof fetch });
    const res = await request(redirect.app).get(`${BASE}/simple/rh-auth/`).expect(502);
    expect(res.headers.location).toBeUndefined();
    const missing = build({ fetchImpl: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch });
    await request(missing.app).get(`${BASE}/simple/rh-auth/`).expect(404);
    const boom = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error("connect failed to token " + TOKEN), { name: "TypeError" }); }) as unknown as typeof fetch });
    const failed = await request(boom.app).get(`${BASE}/simple/rh-auth/`).expect(502);
    expect(JSON.stringify(failed.body)).not.toContain(TOKEN);
    const timeout = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch });
    await request(timeout.app).get(`${BASE}/simple/rh-auth/`).expect(504);
  });

  it("caps the body while reading when content-length is missing", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4_000_000)); } });
    const big = build({ fetchImpl: vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch });
    await request(big.app).get(`${BASE}/files/rh-auth/1.0/rh_auth-1.0.whl`).expect(502);
  });

  it("rejects an oversized upstream body", async () => {
    const big = build({ fetchImpl: vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "999999999999" } })) as unknown as typeof fetch });
    await request(big.app).get(`${BASE}/files/rh-auth/1.0/rh_auth-1.0.whl`).expect(502);
  });
});
