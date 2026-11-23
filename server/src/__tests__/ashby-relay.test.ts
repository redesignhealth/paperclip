import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  ASHBY_RELAY_BASE_URL_ENV,
  ASHBY_RELAY_OPERATIONS_ENV,
  ASHBY_RELAY_WRITE_OPERATIONS_ENV,
  ashbyRelayRoutes,
  parseAshbyRelayConfig,
  parseOperations,
  parseOptIn,
} from "../routes/ashby-relay.js";

const ASHBY_UPSTREAM = "https://api.ashbyhq.com";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const API_KEY = "ashby-secret-key-xyz-123";

const defaultEnv = {
  [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM,
} as NodeJS.ProcessEnv;

function build(
  opts: {
    actor?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    optedIn?: string[];
    token?: string | null;
  } = {},
) {
  const fetchImpl =
    opts.fetchImpl ??
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const op = String(url).split("/").pop();
      return new Response(JSON.stringify({ success: true, results: [{ id: "res-1", op }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

  const isOptedIn = vi.fn(async (agentId: string) =>
    (opts.optedIn ?? [AGENT_A]).includes(agentId),
  );
  const resolveToken = vi.fn(async () =>
    opts.token === undefined ? API_KEY : opts.token,
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      source: "agent_jwt",
      agentId: AGENT_A,
      companyId: COMPANY,
      runId: "run-1",
      ...opts.actor,
    } as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    ashbyRelayRoutes({} as Db, {
      env: opts.env ?? defaultEnv,
      fetchImpl: fetchImpl as typeof fetch,
      isOptedIn,
      resolveToken,
    }),
  );

  return {
    app,
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    isOptedIn,
    resolveToken,
  };
}

const BASE = "/api/ashby-relay";

describe("ashby relay (TECH-9966)", () => {
  it("parses opt-in and operation allowlists", () => {
    expect(parseOptIn("on")).toEqual(["on"]);
    expect(parseOptIn({ value: "ON, True" })).toEqual(["on", "true"]);
    expect(parseOptIn(undefined)).toEqual([]);

    const readOps = parseOperations(undefined, ["job.list"]);
    expect(readOps).toEqual(new Set(["job.list"]));

    const customOps = parseOperations("candidate.search, candidate.info");
    expect(customOps).toEqual(new Set(["candidate.search", "candidate.info"]));

    expect(parseOperations("invalid op name")).toBeNull();
    expect(parseOperations("..%2fsecret")).toBeNull();
    expect(parseOperations("candidate/search")).toBeNull();
  });

  it("fails closed with 503 when unconfigured or invalid URL/operations", async () => {
    // Unset base URL -> 503
    const unconfigured = build({ env: {} as NodeJS.ProcessEnv });
    await request(unconfigured.app).post(`${BASE}/job.list`).send({}).expect(503);
    expect(unconfigured.fetchImpl).not.toHaveBeenCalled();

    // HTTP only URL -> 503
    const httpOnly = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "http://api.ashbyhq.com" } as NodeJS.ProcessEnv,
    });
    await request(httpOnly.app).post(`${BASE}/job.list`).send({}).expect(503);

    // URL with search params or credentials -> 503
    const badUrl = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://user:pass@api.ashbyhq.com?query=1" } as NodeJS.ProcessEnv,
    });
    await request(badUrl.app).post(`${BASE}/job.list`).send({}).expect(503);

    // Invalid operation name in PAPERCLIP_ASHBY_RELAY_OPERATIONS -> 503
    const badOps = build({
      env: {
        [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM,
        [ASHBY_RELAY_OPERATIONS_ENV]: "job.list, invalid op",
      } as NodeJS.ProcessEnv,
    });
    await request(badOps.app).post(`${BASE}/job.list`).send({}).expect(503);

    // Invalid operation name in PAPERCLIP_ASHBY_RELAY_WRITE_OPERATIONS -> 503
    const badWriteOps = build({
      env: {
        [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM,
        [ASHBY_RELAY_WRITE_OPERATIONS_ENV]: "candidate.create;bad",
      } as NodeJS.ProcessEnv,
    });
    await request(badWriteOps.app).post(`${BASE}/job.list`).send({}).expect(503);
  });

  it("forwards allowed read operations with Basic auth header (apiKey:)", async () => {
    const { app, fetchImpl } = build();
    const res = await request(app)
      .post(`${BASE}/job.list`)
      .send({ status: "Open" })
      .expect(200);

    expect(res.body).toEqual({ success: true, results: [{ id: "res-1", op: "job.list" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASHBY_UPSTREAM}/job.list`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");

    const authHeader = (init.headers as Record<string, string>).authorization;
    expect(authHeader).toBe(`Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`);

    const bodyText = Buffer.from(init.body as Uint8Array).toString("utf8");
    expect(JSON.parse(bodyText)).toEqual({ status: "Open" });

    // Ensure API key is never in the response
    expect(JSON.stringify(res.headers)).not.toContain(API_KEY);
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });

  it("handles empty request body by forwarding empty JSON object {}", async () => {
    const { app, fetchImpl } = build();
    await request(app).post(`${BASE}/candidate.search`).send().expect(200);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const bodyText = Buffer.from(init.body as Uint8Array).toString("utf8");
    expect(bodyText).toBe("{}");
  });

  it("refuses board users with 403", async () => {
    const board = build({ actor: { type: "board", source: "session" } });
    await request(board.app).post(`${BASE}/job.list`).send({}).expect(403);
    expect(board.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses agent API key callers without runId with 403", async () => {
    const agentKey = build({ actor: { source: "agent_key", runId: undefined } });
    await request(agentKey.app).post(`${BASE}/job.list`).send({}).expect(403);
    expect(agentKey.fetchImpl).not.toHaveBeenCalled();

    const missingRun = build({ actor: { runId: null } });
    await request(missingRun.app).post(`${BASE}/job.list`).send({}).expect(403);
  });

  it("refuses opted-out agents with 403", async () => {
    const optedOut = build({ actor: { agentId: AGENT_B }, optedIn: [AGENT_A] });
    await request(optedOut.app).post(`${BASE}/job.list`).send({}).expect(403);
    expect(optedOut.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses callers when company has no secret with 403", async () => {
    const noSecret = build({ token: null });
    await request(noSecret.app).post(`${BASE}/job.list`).send({}).expect(403);
    expect(noSecret.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses operations off the allowlist with 404", async () => {
    const { app, fetchImpl } = build();

    // Default allowlist has candidate.search, candidate.info, application.list, job.list
    // Any other operation, including candidate.create, is refused 404 by default
    await request(app).post(`${BASE}/candidate.create`).send({}).expect(404);
    await request(app).post(`${BASE}/candidate.addNote`).send({}).expect(404);
    await request(app).post(`${BASE}/unknown.operation`).send({}).expect(404);
    await request(app).post(`${BASE}/singleword`).send({}).expect(404);
    await request(app).post(`${BASE}/..%2fsecret`).send({}).expect(404);
    await request(app).post(`${BASE}/job..list`).send({}).expect(404);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows write operations only when explicitly opted in via PAPERCLIP_ASHBY_RELAY_WRITE_OPERATIONS", async () => {
    const withWrites = build({
      env: {
        [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM,
        [ASHBY_RELAY_WRITE_OPERATIONS_ENV]: "candidate.create, candidate.addNote",
      } as NodeJS.ProcessEnv,
    });

    // Allowed write operations
    await request(withWrites.app).post(`${BASE}/candidate.create`).send({ name: "Jane" }).expect(200);
    await request(withWrites.app).post(`${BASE}/candidate.addNote`).send({ note: "Hello" }).expect(200);

    // Default read operations are still allowed
    await request(withWrites.app).post(`${BASE}/job.list`).send({}).expect(200);

    // Unlisted write operation is still refused 404
    await request(withWrites.app).post(`${BASE}/candidate.uploadResume`).send({}).expect(404);
  });

  it("rejects non-JSON content-type with 415", async () => {
    const { app, fetchImpl } = build();
    await request(app)
      .post(`${BASE}/job.list`)
      .set("Content-Type", "text/plain")
      .send("raw text")
      .expect(415);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies with 413", async () => {
    const { app, fetchImpl } = build();
    const big = Buffer.alloc(10_000_001);
    const rawReq = request(app).post(`${BASE}/job.list`).set("Content-Type", "application/json");
    // Attach rawBody exceeding max
    (rawReq as unknown as { rawBody: Buffer }).rawBody = big;
    await rawReq.send(big.toString()).expect(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("handles upstream 3xx redirects with 502 without following or leaking location", async () => {
    const redirect = build({
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/redirect" },
          }),
      ) as unknown as typeof fetch,
    });

    const res = await request(redirect.app).post(`${BASE}/job.list`).send({}).expect(502);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toEqual({ detail: "ashby_relay_unavailable" });
  });

  it("handles upstream 404 and error codes without leaking upstream bodies or key", async () => {
    const upstreamNotFound = build({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ secretLeaked: API_KEY, error: "Internal DB error" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    const res404 = await request(upstreamNotFound.app).post(`${BASE}/candidate.info`).send({}).expect(404);
    expect(res404.body).toEqual({ detail: "not_found" });
    expect(JSON.stringify(res404.body)).not.toContain(API_KEY);
    expect(JSON.stringify(res404.body)).not.toContain("Internal DB error");

    const upstreamRateLimit = build({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "rate limit exceeded", token: API_KEY }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    const res429 = await request(upstreamRateLimit.app).post(`${BASE}/job.list`).send({}).expect(429);
    expect(res429.body).toEqual({ detail: "rate_limited" });
    expect(JSON.stringify(res429.body)).not.toContain(API_KEY);
  });

  it("rejects non-JSON upstream response with 502", async () => {
    const htmlResponse = build({
      fetchImpl: vi.fn(
        async () =>
          new Response("<html><body>Login Page</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch,
    });

    const res = await request(htmlResponse.app).post(`${BASE}/job.list`).send({}).expect(502);
    expect(res.body).toEqual({ detail: "ashby_relay_unavailable" });
    expect(res.text).not.toContain("Login Page");
  });

  it("rejects oversized upstream responses with 502", async () => {
    // Declared Content-Length > 10MB
    const bigDeclared = build({
      fetchImpl: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "999999999" },
          }),
      ) as unknown as typeof fetch,
    });
    await request(bigDeclared.app).post(`${BASE}/job.list`).send({}).expect(502);

    // Streaming chunks exceeding 10MB
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4_000_000));
      },
    });
    const bigStream = build({
      fetchImpl: vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });
    await request(bigStream.app).post(`${BASE}/job.list`).send({}).expect(502);
  });

  it("handles upstream timeouts with 504 and network errors with 502 without leaking credentials", async () => {
    const timeout = build({
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error(`Timeout contacting upstream with ${API_KEY}`), {
          name: "TimeoutError",
        });
      }) as unknown as typeof fetch,
    });

    const res504 = await request(timeout.app).post(`${BASE}/job.list`).send({}).expect(504);
    expect(res504.body).toEqual({ detail: "ashby_relay_timeout" });
    expect(JSON.stringify(res504.body)).not.toContain(API_KEY);

    const netErr = build({
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error(`ECONNREFUSED while using token ${API_KEY}`), {
          name: "TypeError",
        });
      }) as unknown as typeof fetch,
    });

    const res502 = await request(netErr.app).post(`${BASE}/job.list`).send({}).expect(502);
    expect(res502.body).toEqual({ detail: "ashby_relay_unavailable" });
    expect(JSON.stringify(res502.body)).not.toContain(API_KEY);
  });

  it("drops upstream response with 502 if the response body contains the API key (defense-in-depth)", async () => {
    const echoKey = build({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, leaked: API_KEY }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    const res = await request(echoKey.app).post(`${BASE}/job.list`).send({}).expect(502);
    expect(res.body).toEqual({ detail: "ashby_relay_unavailable" });
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });
});
