import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  resolveCommsBoardProvisionerConfig,
  composeCommsBoardIdentity,
  mintCommsBoardCredential,
  registerCommsBoardAgent,
} from "../services/comms-board-provisioner-client.js";
import {
  managedConnectionMatch,
  managedConnectionRole,
  readCommsBoardBindingReference,
  installAppliesToAgent,
  stripReservedDefaultMcpMetadata,
} from "../services/default-mcp-spec.js";
import { defaultMcpBackoffMs } from "../services/default-mcp-setup.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_AGENT_ID,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  boardResponse,
  clientConfig,
  downstreamFetch,
  ownershipResponse,
} from "./helpers/comms-board-downstream.js";

describe("comms board identity recipe", () => {
  it("composes a '::'-free token base and a fixed `base::key` board sub", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(composeCommsBoardIdentity(id, "research-bot")).toEqual({
      baseSub: `paperclip-agent-${id}`,
      agentKey: "research-bot",
      boardSub: `paperclip-agent-${id}::research-bot`,
    });
    expect(composeCommsBoardIdentity(id, "")!.agentKey).toBe("agent-11111111");
    expect(composeCommsBoardIdentity(id, "bad::key")!.agentKey).toBe("agent-11111111");
    expect(composeCommsBoardIdentity(id, "x")!.baseSub).not.toContain("::");
  });
});

describe("registerCommsBoardAgent (comms_admin_register over JSON-RPC)", () => {
  const request = { boardSub: "paperclip-agent-1::key", displayName: "Agent (1)", ownerEmail: "owner@redesignhealth.com" };

  it("calls tools/call with the admin bearer and captures the returned board agent UUID", async () => {
    const fetchImpl = downstreamFetch();
    const out = await registerCommsBoardAgent(clientConfig, request, fetchImpl);
    expect(out).toEqual({ ok: true, boardAgentId: BOARD_AGENT_ID, boardSub: request.boardSub });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BOARD_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${BOARD_ADMIN_TOKEN}`);
    expect((init.headers as Record<string, string>).accept).toBe("application/json, text/event-stream");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comms_admin_register" } });
    expect(body.params.arguments).toEqual({
      sub: "paperclip-agent-1::key",
      owner_sub: "owner@redesignhealth.com",
      owner_email: "owner@redesignhealth.com",
      display_name: "Agent (1)",
      is_shared: false,
    });
  });

  it("parses an SSE-framed response", async () => {
    const out = await registerCommsBoardAgent(clientConfig, request, vi.fn(async () => boardResponse(request.boardSub, { sse: true })));
    expect(out).toMatchObject({ ok: true, boardAgentId: BOARD_AGENT_ID });
  });

  it.each([
    ["already_registered", () => boardResponse("s", { isError: true, payload: { error_code: "already_registered" } }), "board_conflict"],
    ["access_denied", () => boardResponse("s", { isError: true, payload: { error_code: "access_denied" } }), "board_rejected"],
    ["identity_fork_detected", () => boardResponse("s", { isError: true, payload: { error_code: "identity_fork_detected" } }), "board_failed"],
    ["HTTP 403", () => boardResponse("s", { status: 403 }), "board_rejected"],
    ["HTTP 500", () => boardResponse("s", { status: 500 }), "board_unknown"],
    ["HTTP 404 (client error before the tool ran)", () => boardResponse("s", { status: 404 }), "board_failed"],
    ["missing agent_id", () => boardResponse(request.boardSub, { payload: { sub: request.boardSub } }), "board_unknown"],
    ["non-UUID agent_id", () => boardResponse(request.boardSub, { payload: { agent_id: "nope", sub: request.boardSub } }), "board_unknown"],
    ["sub mismatch", () => boardResponse("other", { payload: { agent_id: BOARD_AGENT_ID, sub: "other" } }), "board_unknown"],
    ["response id mismatch", () => boardResponse(request.boardSub, { id: 7 }), "board_unknown"],
    ["JSON-RPC error (tool never ran)", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), { status: 200 }), "board_failed"],
  ])("fails visibly on %s", async (_label, respond, reason) => {
    const fetchImpl = vi.fn(async () => respond());
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable on timeout without retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("registerCommsBoardAgent SSE framing (reply matched by request id)", () => {
  const request = { boardSub: "paperclip-agent-1::key", displayName: "Agent (1)", ownerEmail: "owner@redesignhealth.com" };
  const reply = (id = 1, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify({ agent_id: BOARD_AGENT_ID, sub: request.boardSub }) }], isError: false },
    ...extra,
  });
  const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const run = (body: string) => registerCommsBoardAgent(clientConfig, request, vi.fn(async () => sse(body)));

  it("skips a comment preamble, keep-alives and notifications before the id-1 reply", async () => {
    const body = [
      ": connected",
      "",
      "event: ping",
      "data:",
      "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}`,
      "",
      `data: ${JSON.stringify(reply(99))}`, // a reply to some other request
      "",
      `event: message\ndata: ${JSON.stringify(reply(1))}`,
      "",
    ].join("\n");
    expect(await run(body)).toEqual({ ok: true, boardAgentId: BOARD_AGENT_ID, boardSub: request.boardSub });
  });

  it("handles CRLF and CR line endings and joins several data lines with a newline (one leading space removed)", async () => {
    const json = JSON.stringify(reply(1), null, 1); // multi-line JSON
    const lines = json.split("\n").map((line, i) => `data:${i % 2 === 0 ? " " : ""}${line}`);
    expect(await run(`${lines.join("\r\n")}\r\n\r\n`)).toMatchObject({ ok: true });
    expect(await run(`${lines.join("\r")}\r\r`)).toMatchObject({ ok: true });
  });

  it("preserves a matching JSON-RPC error as board_failed, even after notifications", async () => {
    const notification = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`;
    const error = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid" } })}\n\n`;
    expect(await run(notification + error)).toEqual({ ok: false, reason: "board_failed" });
  });

  it.each([
    ["only a notification", `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n\n`],
    ["only another id", `data: ${JSON.stringify(reply(2))}\n\n`],
    ["only comments / keep-alives", ": keep-alive\n\n: keep-alive\n\n"],
    ["non-JSON data", "data: not-json\n\n"],
    ["an empty stream", ""],
  ])("fails closed as an UNKNOWN outcome on %s (never guessing the id, never retrying)", async (_label, body) => {
    const fetchImpl = vi.fn(async () => sse(body));
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an oversized body is not scanned and is an unknown outcome", async () => {
    const huge = `: ${"x".repeat(1_100_000)}\n\ndata: ${JSON.stringify(reply(1))}\n\n`;
    expect(await run(huge)).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("a plain JSON reply for another id is still an unknown outcome", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(reply(5)), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await registerCommsBoardAgent(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "board_unknown" });
  });
});

describe("mintCommsBoardCredential (ownership_api POST /agents)", () => {
  const request = { baseSub: "paperclip-agent-abc-123", ownerEmail: "owner@redesignhealth.com" };

  it("POSTs the token base with comms:read/write only, 30 days, and returns the token", async () => {
    const fetchImpl = downstreamFetch();
    const out = await mintCommsBoardCredential(clientConfig, request, fetchImpl);
    expect(out).toEqual({ ok: true, boardToken: BOARD_TOKEN, tokenExpiresAt: "2027-03-01T00:00:00+00:00" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OWNERSHIP_URL}/agents`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${OWNERSHIP_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      sub: "paperclip-agent-abc-123",
      owner_email: "owner@redesignhealth.com",
      scopes: ["comms:read", "comms:write"],
      expires_in_days: 30,
    });
  });

  it("refuses a token base containing '::' without calling the API", async () => {
    const fetchImpl = vi.fn();
    expect(await mintCommsBoardCredential(clientConfig, { ...request, baseSub: "base::key" }, fetchImpl)).toEqual({ ok: false, reason: "invalid_subject" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["null token", () => ownershipResponse("paperclip-agent-abc-123", { token: null }), "mint_unknown"],
    ["empty token", () => ownershipResponse("paperclip-agent-abc-123", { token: "" }), "mint_unknown"],
    ["sub mismatch", () => ownershipResponse("paperclip-agent-abc-123", { sub: "other" }), "mint_unknown"],
    ["409", () => ownershipResponse("s", {}, 409), "ownership_conflict"],
    ["403", () => ownershipResponse("s", {}, 403), "ownership_rejected"],
    ["500", () => ownershipResponse("s", {}, 500), "mint_unknown"],
    ["422", () => ownershipResponse("s", {}, 422), "ownership_failed"],
    ["502 gateway", () => ownershipResponse("s", {}, 502), "mint_unknown"],
    ["non-JSON 201", () => new Response("<html>", { status: 201 }), "mint_unknown"],
  ])("fails visibly on %s", async (_label, respond, reason) => {
    const fetchImpl = vi.fn(async () => respond());
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable on timeout without retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "mint_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("agent metadata reserved key", () => {
  const stored = { defaultMcp: { version: 1, entries: { a: 1 } }, other: true };
  it("discards caller-supplied defaultMcp and keeps the stored value", () => {
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: { forged: true }, x: 1 }, stored)).toEqual({
      x: 1,
      defaultMcp: stored.defaultMcp,
    });
  });
  it("does not let a null patch wipe the stored value", () => {
    expect(stripReservedDefaultMcpMetadata(null, stored)).toEqual({ defaultMcp: stored.defaultMcp });
    expect(stripReservedDefaultMcpMetadata(null, { other: true })).toBeNull();
  });
  it("drops a forged key when nothing is stored", () => {
    expect(stripReservedDefaultMcpMetadata({ defaultMcp: { forged: true } })).toEqual({});
    expect(stripReservedDefaultMcpMetadata(undefined, stored)).toBeUndefined();
  });
});


describe("effective install rule for default-MCP agents", () => {
  const entry = (over: Record<string, unknown>) => ({
    key: "k", templateKey: null, dedicated: false, enabled: false, templateConnectionId: null, connectionId: null, ownerUserId: null, ...over,
  });
  const state = (entries: Record<string, ReturnType<typeof entry>>) => ({ version: 1 as const, entries }) as never;
  const CO = "company-1";
  const conn = (over: Partial<{ id: string; companyId: string; name: string }> = {}) => ({ id: "c-any", companyId: CO, name: "other", ...over });

  const managed = state({
    comms: entry({ key: "comms", templateKey: "rh-comms-board", dedicated: true, templateConnectionId: "t1", connectionId: "d1" }),
    google: entry({ key: "google", templateKey: "rh-google-mcp", dedicated: false, templateConnectionId: "g1", connectionId: "g1" }),
    late: entry({ key: "late", templateKey: "rh-late-mcp", dedicated: false }), // template did not exist at creation
  });

  it("classifies by recorded id, the FROZEN template name (late-created templates) and dedicated name prefixes", () => {
    expect(managedConnectionRole(managed, CO, conn({ id: "d1" }))).toBe("managed"); // own, by STORED id
    expect(managedConnectionRole(managed, CO, conn({ id: "t1" }))).toBe("forbidden"); // dedicated entry's template
    expect(managedConnectionRole(managed, CO, conn({ id: "late-id", name: "rh-late-mcp" }))).toBe("managed"); // ordinary, template created later
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-comms-board:11111111-1111-1111-1111-111111111111" }))).toBe("forbidden"); // prefix never authorizes
    // A prefix only counts for a dedicated entry, and only with the ':' separator.
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-google-mcp:abc" }))).toBeNull();
    expect(managedConnectionRole(managed, CO, conn({ id: "x", name: "rh-comms-boardX" }))).toBeNull();
    expect(managedConnectionRole(managed, CO, conn())).toBeNull();
    expect(managedConnectionMatch(managed, CO, conn({ id: "t1" }))).toBe(true);
  });

  it("never matches another company's connection, no state, or a forged/empty state", () => {
    expect(managedConnectionMatch(managed, CO, conn({ id: "d1", companyId: "company-2" }))).toBe(false);
    expect(managedConnectionMatch(managed, CO, conn({ name: "rh-comms-board", companyId: "company-2" }))).toBe(false);
    expect(managedConnectionMatch(null, CO, conn({ id: "d1" }))).toBe(false);
    expect(managedConnectionMatch(state({ forged: entry({ key: "forged", templateKey: "", connectionId: null }) }), CO, conn({ name: "" }))).toBe(false);
  });

  it("a company-wide install never authorizes a managed connection; only an explicit agent install of the agent's OWN connection does", () => {
    const agent = { companyId: CO, state: managed };
    // Ordinary entry (Google) and a late-created ordinary template: explicit agent install works, company install does not.
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ id: "g1" }))).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ id: "g1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ name: "rh-late-mcp" }))).toBe(false);
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ name: "rh-late-mcp" }))).toBe(true);
    // Dedicated entry: the STORED own connection works with an explicit install...
    expect(installAppliesToAgent({ targetType: "agent" }, agent, conn({ id: "d1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn({ id: "d1" }))).toBe(false);
    // ...but the org template and any other agent's dedicated connection are never authorized, by any install.
    for (const forbidden of [conn({ id: "t1" }), conn({ name: "rh-comms-board" }), conn({ name: "rh-comms-board:another-agent" })]) {
      expect(managedConnectionRole(managed, CO, forbidden)).toBe("forbidden");
      expect(installAppliesToAgent({ targetType: "agent" }, agent, forbidden)).toBe(false);
      expect(installAppliesToAgent({ targetType: "company" }, agent, forbidden)).toBe(false);
    }
    // Unrelated connections and agents without default-MCP state are unchanged.
    expect(installAppliesToAgent({ targetType: "company" }, agent, conn())).toBe(true);
    expect(installAppliesToAgent({ targetType: "company" }, { companyId: CO, state: null }, conn({ id: "t1" }))).toBe(true);
    expect(installAppliesToAgent({ targetType: "agent" }, { companyId: CO, state: null }, conn({ id: "t1" }))).toBe(true);
  });
});

describe("retry backoff", () => {
  it("doubles from one minute and is capped at one hour", () => {
    expect([1, 2, 3, 4].map(defaultMcpBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(defaultMcpBackoffMs(7)).toBe(3_600_000);
    expect(defaultMcpBackoffMs(50)).toBe(3_600_000);
    expect(defaultMcpBackoffMs(0)).toBe(60_000);
  });
});

describe("read-only binding reference for the wake bridge", () => {
  const binding = (tokenExpiresAt: string | null) => ({
    boardAgentId: BOARD_AGENT_ID, baseSub: "paperclip-agent-1", agentKey: "k", boardSub: "paperclip-agent-1::k",
    secretId: "s1", secretVersion: "latest", connectionId: "c1", grantId: "g1", tokenExpiresAt,
  });
  const metadata = (state: string, tokenExpiresAt: string | null) => ({
    defaultMcp: { version: 1, entries: { "comms-board": { key: "comms-board", setup: { state }, binding: binding(tokenExpiresAt) } } },
  });

  it("is only available when ready, carries ids only, and stops advertising an expired token", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(readCommsBoardBindingReference(metadata("ready", future))).toEqual(binding(future));
    expect(readCommsBoardBindingReference(metadata("ready", null))).toEqual(binding(null));
    expect(readCommsBoardBindingReference(metadata("pending", future))).toBeNull();
    expect(readCommsBoardBindingReference(metadata("error", future))).toBeNull();
    expect(readCommsBoardBindingReference(metadata("ready", new Date(Date.now() - 1000).toISOString()))).toBeNull();
    expect(readCommsBoardBindingReference(null)).toBeNull();
    expect(JSON.stringify(readCommsBoardBindingReference(metadata("ready", future)))).not.toMatch(/token"|secret_ref|Bearer/i);
  });
});

describe("provisioner endpoint validation (resolveCommsBoardProvisionerConfig)", () => {
  const env = (over: Record<string, string | undefined> = {}) => ({
    [COMMS_BOARD_MCP_URL_ENV]: "https://board.example.test/team/mcp",
    [COMMS_BOARD_ADMIN_TOKEN_ENV]: "admin",
    [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: "https://ownership.tailnet.example/api/v1/",
    [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: "ownership",
    ...over,
  }) as NodeJS.ProcessEnv;

  it("accepts https on any host (private tailnets included) and keeps the full legitimate paths", () => {
    expect(resolveCommsBoardProvisionerConfig(env())).toEqual({
      ok: true,
      config: { boardMcpUrl: "https://board.example.test/team/mcp", boardAdminToken: "admin", ownershipApiUrl: "https://ownership.tailnet.example/api/v1", ownershipApiToken: "ownership" },
    });
  });

  it.each(["http://127.0.0.1:8080/mcp", "http://localhost/mcp", "http://[::1]:9000/mcp", "HTTP://LOCALHOST/mcp"])("allows plain HTTP only for the loopback host %s", (url) => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: url })).ok).toBe(true);
  });

  it.each([
    "http://board.example.test/mcp",
    "http://10.0.0.5/mcp",
    "http://127.0.0.1.evil.test/mcp",
    "https://user:pw@board.example.test/mcp",
    "https://user@board.example.test/mcp",
    "https://board.example.test/mcp?token=x",
    "https://board.example.test/mcp#frag",
    "ftp://board.example.test/mcp",
    "javascript:alert(1)",
    "not a url",
    "//board.example.test/mcp",
  ])("rejects %s as provisioner_config_invalid (either endpoint)", (url) => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: url }))).toEqual({ ok: false, reason: "provisioner_config_invalid" });
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: url }))).toEqual({ ok: false, reason: "provisioner_config_invalid" });
  });

  it("a missing setting is provisioner_not_configured (checked before validity)", () => {
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_ADMIN_TOKEN_ENV]: undefined }))).toEqual({ ok: false, reason: "provisioner_not_configured" });
    expect(resolveCommsBoardProvisionerConfig(env({ [COMMS_BOARD_MCP_URL_ENV]: "http://bad.test", [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: undefined }))).toEqual({ ok: false, reason: "provisioner_not_configured" });
  });
});

describe("redirects are never followed", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function redirectingServer() {
    const hits: Array<{ path: string; authorization: string | undefined }> = [];
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? "", authorization: req.headers.authorization });
      if (req.url === "/start" || req.url === "/agents") {
        res.writeHead(302, { location: "/leaked-target" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
  }

  it("sets redirect:error on both calls", async () => {
    const fetchImpl = downstreamFetch();
    await registerCommsBoardAgent(clientConfig, { boardSub: "s::k", displayName: "d", ownerEmail: "o@x.test" }, fetchImpl);
    await mintCommsBoardCredential(clientConfig, { baseSub: "paperclip-agent-1", ownerEmail: "o@x.test" }, fetchImpl);
    for (const call of fetchImpl.mock.calls) expect((call[1] as RequestInit).redirect).toBe("error");
  });

  it("a real 3xx on the board call is an unknown outcome: exactly one request, the redirect target (and the admin bearer) never reached", async () => {
    const { base, hits } = await redirectingServer();
    const out = await registerCommsBoardAgent({ ...clientConfig, boardMcpUrl: `${base}/start` }, { boardSub: "s::k", displayName: "d", ownerEmail: "o@x.test" });
    expect(out).toEqual({ ok: false, reason: "board_unknown" });
    expect(hits.map((h) => h.path)).toEqual(["/start"]);
  });

  it("a real 3xx on the mint call is an unknown outcome with a single POST (no re-POST, no follow)", async () => {
    const { base, hits } = await redirectingServer();
    const out = await mintCommsBoardCredential({ ...clientConfig, ownershipApiUrl: base }, { baseSub: "paperclip-agent-1", ownerEmail: "o@x.test" });
    expect(out).toEqual({ ok: false, reason: "mint_unknown" });
    expect(hits.map((h) => h.path)).toEqual(["/agents"]);
  });
});

describe("mint response contract (sub, active, owner_email, token)", () => {
  const request = { baseSub: "paperclip-agent-abc-123", ownerEmail: "Owner@RedesignHealth.com" };
  const reply = (over: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({
    sub: request.baseSub, owner_email: "owner@redesignhealth.com", active: true, token: "tok", token_expires_at: null, ...over,
  }), { status: 201, headers: { "content-type": "application/json" } }));

  it("accepts an exact-sub, active, case-insensitively owner-matched reply; a null expiry is legitimate", async () => {
    expect(await mintCommsBoardCredential(clientConfig, request, reply({}))).toEqual({ ok: true, boardToken: "tok", tokenExpiresAt: null });
  });

  it.each([
    ["missing sub", { sub: undefined }],
    ["wrong sub", { sub: "paperclip-agent-other" }],
    ["composed (::) sub", { sub: "paperclip-agent-abc-123::key" }],
    ["inactive", { active: false }],
    ["missing active", { active: undefined }],
    ["active as a string", { active: "true" }],
    ["missing owner_email", { owner_email: undefined }],
    ["different owner_email", { owner_email: "someone@redesignhealth.com" }],
    ["non-string owner_email", { owner_email: 7 }],
    ["empty token", { token: "" }],
    ["non-string token", { token: 5 }],
  ])("%s is an unknown outcome", async (_label, over) => {
    const fetchImpl = reply(over);
    expect(await mintCommsBoardCredential(clientConfig, request, fetchImpl)).toEqual({ ok: false, reason: "mint_unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
