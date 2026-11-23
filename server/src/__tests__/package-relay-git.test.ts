import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PACKAGE_RELAY_GITHUB_REPOS_ENV, packageRelayGitRoutes, parseGithubRepoAllowlist } from "../routes/package-relay-git.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const TOKEN = "github-read-token-1";
const env = { [PACKAGE_RELAY_GITHUB_REPOS_ENV]: "RedesignHealth/rh-maiea" } as NodeJS.ProcessEnv;
const BASE = "/api/package-relay/github/redesignhealth/rh-maiea";
const REQ_BODY = Buffer.from("0032want 0123456789abcdef0123456789abcdef01234567\n00000009done\n");

function upstreamFor(url: string) {
  return url.includes("/info/refs")
    ? new Response(Buffer.from("001e# service=git-upload-pack\n0000"), { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } })
    : new Response(Buffer.from("PACKBYTES"), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
}

function build(opts: { actor?: Record<string, unknown>; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; optedIn?: string[]; token?: string | null } = {}) {
  const fetchImpl = opts.fetchImpl ?? vi.fn(async (url: string | URL | Request) => upstreamFor(String(url)));
  const isOptedIn = vi.fn(async (agentId: string, relay: string) => (opts.optedIn ?? [AGENT_A]).includes(agentId) && relay === "github");
  const resolveToken = vi.fn(async () => (opts.token === undefined ? TOKEN : opts.token));
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", agentId: AGENT_A, companyId: COMPANY, runId: "run-1", ...opts.actor } as typeof req.actor;
    next();
  });
  app.use("/api", packageRelayGitRoutes({} as Db, { env: opts.env ?? env, fetchImpl: fetchImpl as typeof fetch, isOptedIn, resolveToken }));
  return { app, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, isOptedIn, resolveToken };
}

const binary = (res: NodeJS.ReadableStream & { setEncoding?: unknown }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
const post = (app: express.Express, path = `${BASE}/git-upload-pack`) =>
  request(app).post(path).set("content-type", "application/x-git-upload-pack-request").buffer(true).parse(binary as never).send(REQ_BODY);

describe("git relay (TECH-9786)", () => {
  it("parses the repo allowlist and rejects any invalid entry", () => {
    expect([...parseGithubRepoAllowlist("A/b, c/d.e")!]).toEqual(["a/b", "c/d.e"]);
    for (const bad of [undefined, "", "  ", "a", "a/b/c", "a/b.git", "a/..", "-a/b", "a/b c", "a/b,x"]) expect(parseGithubRepoAllowlist(bad)).toBeNull();
  });

  it("relays info/refs and upload-pack to the allowlisted repo with the server-side token", async () => {
    const { app, fetchImpl } = build();
    const refs = await request(app).get(`${BASE}.git/info/refs?service=git-upload-pack`).expect(200);
    expect(refs.headers["content-type"]).toMatch(/application\/x-git-upload-pack-advertisement/);
    const pack = await post(app).expect(200);
    expect(pack.headers["content-type"]).toMatch(/application\/x-git-upload-pack-result/);
    expect(pack.body.toString()).toBe("PACKBYTES");
    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      "GET https://github.com/redesignhealth/rh-maiea.git/info/refs?service=git-upload-pack",
      "POST https://github.com/redesignhealth/rh-maiea.git/git-upload-pack",
    ]);
    for (const [, init] of calls) {
      expect(init.redirect).toBe("manual");
      const auth = (init.headers as Record<string, string>).authorization!;
      expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(`x-access-token:${TOKEN}`);
    }
    expect(Buffer.from(calls[1]![1].body as Uint8Array).equals(REQ_BODY)).toBe(true);
    expect(JSON.stringify(refs.headers)).not.toContain(TOKEN);
  });

  it("refuses pushes and any other service without calling GitHub", async () => {
    const { app, fetchImpl } = build();
    await request(app).get(`${BASE}/info/refs?service=git-receive-pack`).expect(403);
    await request(app).get(`${BASE}/info/refs`).expect(403);
    await request(app).post(`${BASE}/git-receive-pack`).set("content-type", "application/x-git-receive-pack-request").send(REQ_BODY).expect(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses repositories that are not on the allowlist, including look-alikes", async () => {
    const { app, fetchImpl } = build();
    for (const path of ["/api/package-relay/github/redesignhealth/other/info/refs?service=git-upload-pack", "/api/package-relay/github/evil/rh-maiea/info/refs?service=git-upload-pack", "/api/package-relay/github/redesignhealth/rh-maiea-x/info/refs?service=git-upload-pack", "/api/package-relay/github/redesignhealth/rh-maiea.git.git/info/refs?service=git-upload-pack"]) {
      await request(app).get(path).expect(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a git request body for upload-pack", async () => {
    const { app, fetchImpl } = build();
    await request(app).post(`${BASE}/git-upload-pack`).set("content-type", "application/json").send("{}").expect(415);
    await request(app).post(`${BASE}/git-upload-pack`).set("content-type", "application/x-git-upload-pack-request").expect(415);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses non-run callers and agents that have not opted in", async () => {
    const b = build({ actor: { agentId: AGENT_B } });
    await request(b.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(403);
    expect(b.fetchImpl).not.toHaveBeenCalled();
    for (const actor of [{ source: "agent_key" }, { runId: undefined }, { type: "board" }]) {
      const c = build({ actor });
      await request(c.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(403);
      expect(c.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("fails closed with 503 when not configured or invalid, and 403 when the company has no token", async () => {
    for (const repos of [undefined, "", "redesignhealth/rh-maiea,bad repo"]) {
      const off = build({ env: { [PACKAGE_RELAY_GITHUB_REPOS_ENV]: repos } as NodeJS.ProcessEnv });
      await request(off.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(503);
      await post(off.app).expect(503);
      expect(off.fetchImpl).not.toHaveBeenCalled();
    }
    const noToken = build({ token: null });
    await request(noToken.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(403);
    expect(noToken.fetchImpl).not.toHaveBeenCalled();
  });

  it("maps upstream failures without passing GitHub's body or redirects through", async () => {
    const redirect = build({ fetchImpl: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } })) as unknown as typeof fetch });
    const r = await request(redirect.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(502);
    expect(r.headers.location).toBeUndefined();
    for (const status of [401, 403, 404]) {
      const denied = build({ fetchImpl: vi.fn(async () => new Response("secret upstream body", { status })) as unknown as typeof fetch });
      const res = await request(denied.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(404);
      expect(JSON.stringify(res.body)).not.toContain("secret upstream body");
    }
    const html = build({ fetchImpl: vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
    await request(html.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(502);
    const boom = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error(`connect failed ${TOKEN}`), { name: "TypeError" }); }) as unknown as typeof fetch });
    const failed = await request(boom.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(502);
    expect(JSON.stringify(failed.body)).not.toContain(TOKEN);
    const timeout = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch });
    await request(timeout.app).get(`${BASE}/info/refs?service=git-upload-pack`).expect(504);
  });

  it("caps the response while reading", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4_000_000)); } });
    const big = build({ fetchImpl: vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } })) as unknown as typeof fetch });
    await post(big.app).expect(502);
  });
});
