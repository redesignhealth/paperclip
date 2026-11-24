import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { registerModelRelay } from "@paperclipai/adapter-utils/model-relay";
import { modelRelayRoutes, pinnedUpstreamBase } from "../routes/model-relay.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const KEY = "router-secret-key-0123456789";
const UPSTREAM = "https://api.router.example/v1";
const BODY = { model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "hi" }] };
const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

function build(opts: { actor?: Record<string, unknown>; fetchImpl?: typeof fetch; active?: boolean; register?: boolean } = {}) {
  if (opts.register !== false) disposers.push(registerModelRelay("run-1", { "ramp-router": { upstreamBaseUrl: UPSTREAM, apiKey: KEY } }));
  const fetchImpl = opts.fetchImpl ?? vi.fn(async () =>
    new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "x=1" } }));
  const assertActiveRun = vi.fn(async () => opts.active ?? true);
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", agentId: AGENT, companyId: COMPANY, runId: "run-1", ...opts.actor } as typeof req.actor;
    next();
  });
  app.use(express.json());
  app.use("/api", modelRelayRoutes({} as Db, { fetchImpl: fetchImpl as typeof fetch, assertActiveRun }));
  return { app, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, assertActiveRun };
}

const post = (app: express.Express, path = "/api/model-relay/ramp-router/chat/completions") =>
  request(app).post(path).set("content-type", "application/json").set("authorization", "Bearer pod-bridge-token").send(BODY);

describe("model relay (TECH-10174)", () => {
  it("forwards the request unchanged with the server-held key and passes the SSE stream through", async () => {
    const { app, fetchImpl } = build();
    const res = await post(app).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.text).toBe(SSE);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual(BODY);
    expect(JSON.stringify(res.headers)).not.toContain(KEY);
    expect(JSON.stringify(headers)).not.toContain("pod-bridge-token");
  });

  it("adds anthropic-version for the messages path only", async () => {
    const { app, fetchImpl } = build();
    await post(app, "/api/model-relay/ramp-router/messages").expect(200);
    await post(app).expect(200);
    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    expect((calls[0]![1].headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect((calls[1]![1].headers as Record<string, string>)["anthropic-version"]).toBeUndefined();
  });

  it("passes provider errors through with their status", async () => {
    const { app } = build({ fetchImpl: vi.fn(async () => new Response('{"error":"slow down"}', { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } })) as never });
    const res = await post(app).expect(429);
    expect(res.headers["retry-after"]).toBe("7");
  });

  it("refuses anything but the run JWT of a running run, without calling upstream", async () => {
    for (const actor of [{ source: "agent_key" }, { type: "board" }, { runId: undefined }]) {
      const { app, fetchImpl } = build({ actor });
      await post(app).expect(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const ended = build({ active: false });
    await post(ended.app).expect(403);
    expect(ended.fetchImpl).not.toHaveBeenCalled();
  });

  it("answers 404 when the run has no registered provider (entry gone after the run) or the path is not allowed", async () => {
    const none = build({ register: false });
    await post(none.app).expect(404);
    const { app, fetchImpl } = build();
    await post(app, "/api/model-relay/other/chat/completions").expect(404);
    await post(app, "/api/model-relay/ramp-router/models").expect(404);
    await request(app).get("/api/model-relay/ramp-router/chat/completions").expect(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a JSON body", async () => {
    const { app, fetchImpl } = build();
    await request(app).post("/api/model-relay/ramp-router/chat/completions").set("content-type", "text/plain").send("x").expect(415);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses redirects, a non-https upstream, and an upstream that echoes the key", async () => {
    const redirect = build({ fetchImpl: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as never });
    await post(redirect.app).expect(502);
    disposers.push(registerModelRelay("run-2", { "ramp-router": { upstreamBaseUrl: "http://api.router.example/v1", apiKey: KEY } }));
    const plain = build({ actor: { runId: "run-2" }, register: false });
    await post(plain.app).expect(404);
    expect(plain.fetchImpl).not.toHaveBeenCalled();
    const echo = build({ fetchImpl: vi.fn(async () => new Response(`oops ${KEY}`, { status: 200, headers: { "content-type": "text/event-stream" } })) as never });
    const res = await post(echo.app).expect(502);
    expect(JSON.stringify(res.body) + res.text).not.toContain(KEY);
  });

  it("never forwards a key split across two chunks", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ok ${KEY.slice(0, 10)}`));
        controller.enqueue(enc.encode(`${KEY.slice(10)} tail`));
        controller.close();
      },
    });
    const split = build({ fetchImpl: vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as never });
    // The stream is cut mid-response (the head was already sent), so the client sees an aborted request.
    const outcome = await post(split.app).then((res) => res.text, (err: Error) => `error:${err.message}`);
    expect(outcome).not.toContain(KEY.slice(0, 10));
  });

  it("serves the Messages API at a host-root upstream with the anthropic headers (Claude on Router)", async () => {
    disposers.push(registerModelRelay("run-1", { "ramp-router": { upstreamBaseUrl: UPSTREAM, apiKey: KEY }, "ramp-router-m1": { upstreamBaseUrl: "https://api.router.example", apiKey: KEY } }));
    const { app, fetchImpl } = build({ register: false });
    // The Anthropic SDK, given the relay base for the host-root upstream, posts to <base>/v1/messages with x-api-key.
    const res = await request(app).post("/api/model-relay/ramp-router-m1/v1/messages").set("content-type", "application/json").set("x-api-key", "pod-bridge-token").send(BODY).expect(200);
    expect(res.text).toBe(SSE);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.router.example/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(headers)).not.toContain("pod-bridge-token");
    // The /v1 provider base serves the Responses API for the non-Claude models.
    await post(app, "/api/model-relay/ramp-router/responses").expect(200);
    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe(`${UPSTREAM}/responses`);
  });

  it("serves the other inference paths and refuses an oversized request", async () => {
    const { app, fetchImpl } = build();
    await post(app, "/api/model-relay/ramp-router/completions").expect(200);
    await post(app, "/api/model-relay/ramp-router/responses").expect(200);
    const urls = (fetchImpl.mock.calls as Array<[string]>).map(([u]) => u);
    expect(urls).toEqual([`${UPSTREAM}/completions`, `${UPSTREAM}/responses`]);
  });

  it("answers 504 on an upstream timeout and 502 on a connection failure, without echoing details", async () => {
    const timeout = build({ fetchImpl: vi.fn(async () => { throw Object.assign(new Error(`took too long ${KEY}`), { name: "TimeoutError" }); }) as never });
    const t = await post(timeout.app).expect(504);
    expect(t.text).not.toContain(KEY);
    const down = build({ fetchImpl: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never });
    await post(down.app).expect(502);
  });

  it("pins the upstream base", () => {
    expect(pinnedUpstreamBase("https://api.router.example/v1/")).toBe("https://api.router.example/v1");
    for (const bad of ["http://a.example/v1", "https://u:p@a.example/v1", "https://a.example/v1?x=1", "https://a.example/v1#f", "nope"]) expect(pinnedUpstreamBase(bad)).toBeNull();
  });
});
