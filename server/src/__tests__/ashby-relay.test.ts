import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS } from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import {
  ASHBY_RELAY_API_KEY_ENV,
  ASHBY_RELAY_BASE_URL_ENV,
  ASHBY_RELAY_DEADLINE_MS,
  ASHBY_RELAY_OPERATIONS_ENV,
  ASHBY_RELAY_SECRET_KEY,
  ASHBY_RELAY_WRITE_OPERATIONS_ENV,
  ASHBY_UPSTREAM_ORIGIN,
  KNOWN_ASHBY_RELAY_READ_OPERATIONS,
  KNOWN_ASHBY_RELAY_WRITE_OPERATIONS,
  ashbyRelayRoutes,
  parseAshbyRelayConfig,
  parseOperations,
  resolveAshbyToken,
  validateApiKey,
} from "../routes/ashby-relay.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const API_KEY = "ashby-secret-key-xyz-123";

const defaultEnv = {
  [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM_ORIGIN,
} as NodeJS.ProcessEnv;

function build(
  opts: {
    actor?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    optedIn?: string[];
    token?: string | null;
    runActive?: boolean;
    resolveToken?: (companyId: string) => Promise<string | null>;
    assertActiveRun?: (input: { companyId: string; agentId: string; runId: string }) => Promise<boolean>;
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
  const resolveToken =
    opts.resolveToken ??
    vi.fn(async () => (opts.token === undefined ? API_KEY : opts.token));
  const assertActiveRun =
    opts.assertActiveRun ??
    vi.fn(async () => (opts.runActive === undefined ? true : opts.runActive));

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
      assertActiveRun,
    }),
  );

  return {
    app,
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    isOptedIn,
    resolveToken,
    assertActiveRun,
  };
}

const BASE = "/api/ashby-relay";

describe("ashby relay (TECH-9966)", () => {
  it("proves upstream deadline has a safe margin before bridge default timeout", () => {
    expect(DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS).toBe(30_000);
    expect(ASHBY_RELAY_DEADLINE_MS).toBe(25_000);
    expect(DEFAULT_BRIDGE_RESPONSE_TIMEOUT_MS - ASHBY_RELAY_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("validates API keys strictly: trims whitespace, rejects blank and control chars/CRLF", () => {
    expect(validateApiKey("  secret-key  ")).toBe("secret-key");
    expect(validateApiKey("")).toBeNull();
    expect(validateApiKey("   ")).toBeNull();
    expect(validateApiKey(undefined)).toBeNull();
    expect(validateApiKey(null)).toBeNull();
    expect(validateApiKey("key-with-\r-cr")).toBeNull();
    expect(validateApiKey("key-with-\n-lf")).toBeNull();
    expect(validateApiKey("key-with-\0-nul")).toBeNull();
    expect(validateApiKey("key-with-\x1f-ctrl")).toBeNull();
  });

  it("parses operation allowlists", () => {
    const readOps = parseOperations(undefined, ["job.list"]);
    expect(readOps).toEqual(new Set(["job.list"]));

    const customOps = parseOperations("candidate.search, candidate.info");
    expect(customOps).toEqual(new Set(["candidate.search", "candidate.info"]));

    expect(parseOperations("invalid op name")).toBeNull();
    expect(parseOperations("..%2fsecret")).toBeNull();
    expect(parseOperations("candidate/search")).toBeNull();
  });

  it("pins exact https://api.ashbyhq.com origin with root path and rejects all other hosts/paths/ports/userinfo/queries", async () => {
    expect(parseAshbyRelayConfig({ [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM_ORIGIN })?.base).toBe(
      ASHBY_UPSTREAM_ORIGIN,
    );
    expect(parseAshbyRelayConfig({ [ASHBY_RELAY_BASE_URL_ENV]: `${ASHBY_UPSTREAM_ORIGIN}/` })?.base).toBe(
      ASHBY_UPSTREAM_ORIGIN,
    );

    // Unset base URL -> 503
    const unconfigured = build({ env: {} as NodeJS.ProcessEnv });
    await request(unconfigured.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);
    expect(unconfigured.fetchImpl).not.toHaveBeenCalled();

    // HTTP only URL -> 503
    const httpOnly = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "http://api.ashbyhq.com" } as NodeJS.ProcessEnv,
    });
    await request(httpOnly.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Different host -> 503
    const evilHost = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://evil.example.com" } as NodeJS.ProcessEnv,
    });
    await request(evilHost.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Custom port -> 503
    const customPort = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://api.ashbyhq.com:8443" } as NodeJS.ProcessEnv,
    });
    await request(customPort.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Path segment (non-root) -> 503
    const pathPrefix = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://api.ashbyhq.com/v1" } as NodeJS.ProcessEnv,
    });
    await request(pathPrefix.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Userinfo credentials in URL -> 503
    const userPass = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://user:pass@api.ashbyhq.com" } as NodeJS.ProcessEnv,
    });
    await request(userPass.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Query string in URL -> 503
    const withQuery = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://api.ashbyhq.com?q=1" } as NodeJS.ProcessEnv,
    });
    await request(withQuery.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // Hash fragment in URL -> 503
    const withHash = build({
      env: { [ASHBY_RELAY_BASE_URL_ENV]: "https://api.ashbyhq.com#frag" } as NodeJS.ProcessEnv,
    });
    await request(withHash.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);
  });

  it("intersects read operations strictly with known read-only set and rejects mutating operations without write opt-in", async () => {
    // candidate.create in read operations env MUST NOT be enabled
    const readWithMutation = build({
      env: {
        [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM_ORIGIN,
        [ASHBY_RELAY_OPERATIONS_ENV]: "candidate.create, job.list",
      } as NodeJS.ProcessEnv,
    });

    // job.list is known read-only, so it is allowed
    await request(readWithMutation.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(200);

    // candidate.create is a write operation, so it was filtered out from read allowlist -> 404
    await request(readWithMutation.app).post(`${BASE}/candidate.create`).set("Content-Type", "application/json").send({}).expect(404);
    expect(readWithMutation.fetchImpl).toHaveBeenCalledTimes(1);

    // Supported write operations: candidate.create, candidate.createNote, candidate.addTag, application.create, application.changeStage
    expect(KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.has("candidate.createNote")).toBe(true);
    expect(KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.has("candidate.addTag")).toBe(true);
    expect(KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.has("application.changeStage")).toBe(true);
    // Unsupported multipart operation is removed
    expect(KNOWN_ASHBY_RELAY_WRITE_OPERATIONS.has("candidate.uploadResume")).toBe(false);

    // candidate.createNote is only allowed when explicitly opted in via write env
    const withExplicitWrite = build({
      env: {
        [ASHBY_RELAY_BASE_URL_ENV]: ASHBY_UPSTREAM_ORIGIN,
        [ASHBY_RELAY_OPERATIONS_ENV]: "job.list",
        [ASHBY_RELAY_WRITE_OPERATIONS_ENV]: "candidate.createNote",
      } as NodeJS.ProcessEnv,
    });
    await request(withExplicitWrite.app)
      .post(`${BASE}/candidate.createNote`)
      .set("Content-Type", "application/json")
      .send({ note: "Interview feedback" })
      .expect(200);
  });

  it("requires actual active run scoped to agent/company, rejecting missing or terminal runs with 403", async () => {
    const missingRun = build({
      assertActiveRun: vi.fn(async () => false),
    });
    await request(missingRun.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
    expect(missingRun.assertActiveRun).toHaveBeenCalledWith({
      companyId: COMPANY,
      agentId: AGENT_A,
      runId: "run-1",
    });
    expect(missingRun.fetchImpl).not.toHaveBeenCalled();

    const terminalRun = build({
      runActive: false,
    });
    await request(terminalRun.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
    expect(terminalRun.fetchImpl).not.toHaveBeenCalled();

    const activeRun = build({
      runActive: true,
    });
    await request(activeRun.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(200);
    expect(activeRun.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves token via company secret first and falls back to PAPERCLIP_ASHBY_RELAY_API_KEY if absent", async () => {
    const mockDb = {} as Db;
    const mockSecrets = {
      getByKey: vi.fn(),
      resolveSecretValue: vi.fn(),
    } as unknown as ReturnType<typeof import("../services/secrets.js").secretService>;

    // 1. Company secret is present and active -> returns secret value
    mockSecrets.getByKey = vi.fn(async (_companyId: string, key: string) => {
      if (key === ASHBY_RELAY_SECRET_KEY) return { id: "sec-1", status: "active" };
      return null;
    }) as typeof mockSecrets.getByKey;
    mockSecrets.resolveSecretValue = vi.fn(async () => "company-secret-value") as typeof mockSecrets.resolveSecretValue;

    const tokenFromSecret = await resolveAshbyToken(
      mockDb,
      COMPANY,
      { [ASHBY_RELAY_API_KEY_ENV]: "env-fallback-key" } as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenFromSecret).toBe("company-secret-value");

    // 2. Company secret is absent (null) -> falls back to env key
    mockSecrets.getByKey = vi.fn(async () => null) as typeof mockSecrets.getByKey;
    const tokenFromEnv = await resolveAshbyToken(
      mockDb,
      COMPANY,
      { [ASHBY_RELAY_API_KEY_ENV]: "env-fallback-key" } as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenFromEnv).toBe("env-fallback-key");

    // 3. Company secret is inactive -> falls back to env key
    mockSecrets.getByKey = vi.fn(async () => ({ id: "sec-1", status: "disabled" })) as typeof mockSecrets.getByKey;
    const tokenInactive = await resolveAshbyToken(
      mockDb,
      COMPANY,
      { [ASHBY_RELAY_API_KEY_ENV]: "env-fallback-key" } as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenInactive).toBe("env-fallback-key");

    // 4. Secret lookup throws an error -> must rethrow and NOT fall through to env!
    mockSecrets.getByKey = vi.fn(async () => {
      throw new Error("DB connection failure");
    }) as typeof mockSecrets.getByKey;
    await expect(
      resolveAshbyToken(
        mockDb,
        COMPANY,
        { [ASHBY_RELAY_API_KEY_ENV]: "env-fallback-key" } as NodeJS.ProcessEnv,
        mockSecrets,
      ),
    ).rejects.toThrow("DB connection failure");

    // 5. Neither secret nor env key exists -> returns null
    mockSecrets.getByKey = vi.fn(async () => null) as typeof mockSecrets.getByKey;
    const tokenNeither = await resolveAshbyToken(
      mockDb,
      COMPANY,
      {} as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenNeither).toBeNull();

    // 6. Env key is blank or whitespace -> returns null
    const tokenBlank = await resolveAshbyToken(
      mockDb,
      COMPANY,
      { [ASHBY_RELAY_API_KEY_ENV]: "   " } as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenBlank).toBeNull();

    // 7. Env key has control characters / CRLF -> returns null
    const tokenControl = await resolveAshbyToken(
      mockDb,
      COMPANY,
      { [ASHBY_RELAY_API_KEY_ENV]: "bad\r\nkey" } as NodeJS.ProcessEnv,
      mockSecrets,
    );
    expect(tokenControl).toBeNull();

    // Route tests for resolveToken failure paths:
    // When resolveToken returns null -> route fails closed 503
    const noTokenApp = build({ resolveToken: async () => null });
    await request(noTokenApp.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);

    // When resolveToken throws -> route fails closed 503
    const errorTokenApp = build({
      resolveToken: async () => {
        throw new Error("Secret service timeout");
      },
    });
    await request(errorTokenApp.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);
  });

  it("forwards allowed read operations with Basic auth header (apiKey:)", async () => {
    const { app, fetchImpl } = build();
    const res = await request(app)
      .post(`${BASE}/job.list`)
      .set("Content-Type", "application/json")
      .send({ status: "Open" })
      .expect(200);

    expect(res.body).toEqual({ success: true, results: [{ id: "res-1", op: "job.list" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASHBY_UPSTREAM_ORIGIN}/job.list`);
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

  it("handles empty request body with JSON content-type by forwarding empty JSON object {}", async () => {
    const { app, fetchImpl } = build();
    await request(app)
      .post(`${BASE}/candidate.search`)
      .set("Content-Type", "application/json")
      .send()
      .expect(200);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const bodyText = Buffer.from(init.body as Uint8Array).toString("utf8");
    expect(bodyText).toBe("{}");
  });

  it("refuses board users with 403", async () => {
    const board = build({ actor: { type: "board", source: "session" } });
    await request(board.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
    expect(board.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses agent API key callers without runId with 403", async () => {
    const agentKey = build({ actor: { source: "agent_key", runId: undefined } });
    await request(agentKey.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
    expect(agentKey.fetchImpl).not.toHaveBeenCalled();

    const missingRun = build({ actor: { runId: null } });
    await request(missingRun.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
  });

  it("refuses opted-out agents with 403", async () => {
    const optedOut = build({ actor: { agentId: AGENT_B }, optedIn: [AGENT_A] });
    await request(optedOut.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(403);
    expect(optedOut.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses callers when neither secret nor env key exists with 503", async () => {
    const noSecret = build({ token: null });
    await request(noSecret.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(503);
    expect(noSecret.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses operations off the allowlist with 404", async () => {
    const { app, fetchImpl } = build();

    await request(app).post(`${BASE}/candidate.create`).set("Content-Type", "application/json").send({}).expect(404);
    await request(app).post(`${BASE}/candidate.createNote`).set("Content-Type", "application/json").send({}).expect(404);
    await request(app).post(`${BASE}/unknown.operation`).set("Content-Type", "application/json").send({}).expect(404);
    await request(app).post(`${BASE}/singleword`).set("Content-Type", "application/json").send({}).expect(404);
    await request(app).post(`${BASE}/..%2fsecret`).set("Content-Type", "application/json").send({}).expect(404);
    await request(app).post(`${BASE}/job..list`).set("Content-Type", "application/json").send({}).expect(404);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing or non-JSON content-type with 415", async () => {
    const { app, fetchImpl } = build();
    // Non-JSON content-type
    await request(app)
      .post(`${BASE}/job.list`)
      .set("Content-Type", "text/plain")
      .send("raw text")
      .expect(415);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Missing content-type
    await request(app)
      .post(`${BASE}/job.list`)
      .unset("Content-Type")
      .send("raw")
      .expect(415);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies with 413", async () => {
    const { app, fetchImpl } = build();
    const big = Buffer.alloc(10_000_001);
    const rawReq = request(app).post(`${BASE}/job.list`).set("Content-Type", "application/json");
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

    const res = await request(redirect.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);
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

    const res404 = await request(upstreamNotFound.app).post(`${BASE}/candidate.info`).set("Content-Type", "application/json").send({}).expect(404);
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

    const res429 = await request(upstreamRateLimit.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(429);
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

    const res = await request(htmlResponse.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);
    expect(res.body).toEqual({ detail: "ashby_relay_unavailable" });
    expect(res.text).not.toContain("Login Page");
  });

  it("rejects oversized upstream responses with 502", async () => {
    const bigDeclared = build({
      fetchImpl: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "999999999" },
          }),
      ) as unknown as typeof fetch,
    });
    await request(bigDeclared.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);

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
    await request(bigStream.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);
  });

  it("handles upstream timeouts with 504 and network errors with 502 without leaking credentials", async () => {
    const timeout = build({
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error(`Timeout contacting upstream with ${API_KEY}`), {
          name: "TimeoutError",
        });
      }) as unknown as typeof fetch,
    });

    const res504 = await request(timeout.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(504);
    expect(res504.body).toEqual({ detail: "ashby_relay_timeout" });
    expect(JSON.stringify(res504.body)).not.toContain(API_KEY);

    const netErr = build({
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error(`ECONNREFUSED while using token ${API_KEY}`), {
          name: "TypeError",
        });
      }) as unknown as typeof fetch,
    });

    const res502 = await request(netErr.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);
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

    const res = await request(echoKey.app).post(`${BASE}/job.list`).set("Content-Type", "application/json").send({}).expect(502);
    expect(res.body).toEqual({ detail: "ashby_relay_unavailable" });
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });
});
