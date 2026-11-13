import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  setupPluginApiWebSocketServer,
  resetWebSocketSlotsForTest,
  createGuardedWebSocketProxyForTesting,
} from "../realtime/plugin-api-ws.js";

// fork(TECH-8283 F1): Support options-object call shape for pinned DNS requests
vi.mock("node:https", () => ({
  request: (urlOrOpts: unknown, opts?: object) => {
    if (urlOrOpts instanceof URL || typeof urlOrOpts === "string") {
      const local = new URL(urlOrOpts); local.protocol = "http:";
      return httpRequest(local, opts);
    }
    const { servername, ...rest } = (urlOrOpts ?? {}) as Record<string, unknown>;
    return httpRequest(rest, opts);
  },
}));

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";

const mockAccess = vi.hoisted(() => ({ decide: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("../services/authorization.js", () => ({ authorizationService: () => mockAccess }));

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function manifest(apiRoutes: NonNullable<PaperclipPluginManifestV1["apiRoutes"]>): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.scoped-api-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Scoped API Test",
    description: "Test plugin for scoped API routes",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["api.routes.register", "http.outbound"],
    entrypoints: { worker: "dist/worker.js" },
    apiRoutes,
  };
}

async function createApp(input: {
  actor: Record<string, unknown>;
  plugin?: Record<string, unknown> | null;
  workerRunning?: boolean;
  workerResult?: unknown;
  db?: unknown;
  useProductionProxy?: boolean;
  wsOptions?: {
    allowPrivateNetwork?: boolean;
    upgradeDeadlineMs?: number;
    handshakeDeadlineMs?: number;
    watchIntervalMs?: number;
    lifetimeMs?: number;
    lookup?: unknown;
  };
}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(input.workerRunning ?? true),
    call: vi.fn().mockImplementation(() => (typeof input.workerResult === "function" ? input.workerResult() : Promise.resolve(input.workerResult ?? { status: 200, body: { ok: true } }))),
  };

  mockRegistry.getById.mockResolvedValue(input.plugin ?? null);
  mockRegistry.getByKey.mockResolvedValue(input.plugin ?? null);

  // fork(TECH-8283 Finding 3): Integration harness uses explicit test factory only in test runtime
  const proxyWs = input.useProductionProxy
    ? undefined
    : createGuardedWebSocketProxyForTesting({
        allowPrivateNetwork: input.wsOptions?.allowPrivateNetwork ?? true,
        lookup: input.wsOptions?.lookup as never,
        handshakeDeadlineMs: input.wsOptions?.handshakeDeadlineMs,
      });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = input.actor as typeof req.actor; next(); });
  app.use(
    "/api",
    pluginRoutes(
      (input.db ?? {}) as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      { workerManager, wsOptions: input.wsOptions, proxyWs } as never,
    ),
  );
  app.use(errorHandler);

  return { app, workerManager };
}

describe("plugin scoped API routes", { timeout: 30_000 }, () => {
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const agentId = "33333333-3333-4333-8333-333333333333";
  const peerAgentId = "33333333-3333-4333-8333-333333333334";
  const runId = "44444444-4444-4444-8444-444444444444";
  const issueId = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    resetWebSocketSlotsForTest();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      adoptedFromRunId: null,
    });
  });

  it("dispatches a board GET route with params, query, actor, and company context", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: { status: 201, body: { handled: true } },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}&view=compact`)
      .set("Authorization", "Bearer should-not-forward");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ handled: true });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "summary.get",
      method: "GET",
      params: { companySlug: "acme" },
      query: { companyId, view: "compact" },
      companyId,
      actor: expect.objectContaining({ actorType: "user", actorId: "user-1" }),
    }));
    expect(workerManager.call.mock.calls[0]?.[2].headers.authorization).toBeUndefined();
  });

  it("only forwards allowlisted response headers from plugin routes", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: {
        status: 200,
        body: { handled: true },
        headers: {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          location: "https://example.invalid",
          "x-request-id": "plugin-request",
        },
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBe("plugin-request");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  });

  it("enforces agent checkout ownership before dispatching issue-scoped POST routes", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({ step: "next" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, agentId, runId);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "issue.advance",
      params: { issueId },
      body: { step: "next" },
      actor: expect.objectContaining({ actorType: "agent", agentId, runId }),
      companyId,
    }));
  });

  it("allows non-assignee agents on in-progress required checkout routes without claiming checkout ownership", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId: peerAgentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({ step: "next" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "issue.advance",
      params: { issueId },
      body: { step: "next" },
      actor: expect.objectContaining({ actorType: "agent", agentId: peerAgentId, runId }),
      companyId,
    }));
  });

  it("rejects checkout-protected agent routes without a run id before worker dispatch", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "required-for-agent-in-progress",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({});

    expect(res.status).toBe(401);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects checkout-protected agent routes when the active checkout belongs to another run", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "issue.advance",
        method: "POST",
        path: "/issues/:issueId/advance",
        auth: "agent",
        capability: "api.routes.register",
        checkoutPolicy: "always-for-agent",
        companyResolution: { from: "issue", param: "issueId" },
      },
    ]);
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const conflict = new Error("Issue run ownership conflict") as Error & { status?: number };
    conflict.status = 409;
    mockIssueService.assertCheckoutOwner.mockRejectedValue(conflict);
    const { app, workerManager } = await createApp({
      actor: {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/api/issues/${issueId}/advance`)
      .send({});

    expect(res.status).toBe(409);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("returns a clear error for disabled plugins without worker dispatch", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "disabled",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("disabled");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("returns a clear error when a ready plugin has no running worker", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerRunning: false,
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("worker is not running");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects manifest routes that try to claim core API paths", () => {
    const result = pluginManifestV1Schema.safeParse(manifest([
      {
        routeKey: "bad.shadow",
        method: "POST",
        path: "/api/issues/:issueId",
        auth: "board",
        capability: "api.routes.register",
      },
    ]));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected manifest validation to fail");
    expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
      "path must stay inside the plugin api namespace",
    );
  });
});

describe("plugin browser WebSockets", () => {
  const companyId = "22222222-2222-4222-8222-222222222222";
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const apiRoutes = manifest([{
    routeKey: "channel.connect",
    method: "GET",
    path: "/channels/:channelId",
    transport: "websocket",
    auth: "board",
    capability: "api.routes.register",
    companyResolution: { from: "query", key: "companyId" },
  }]);
  const plugin = { id: pluginId, pluginKey: apiRoutes.id, status: "ready", manifestJson: apiRoutes };
  const board = { type: "board", userId: "user-1", source: "local_implicit", isInstanceAdmin: true };
  const endpoint = `/api/plugins/${pluginId}/api/channels/build-output?companyId=${companyId}`;

  async function listen(server: Server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  async function closeServer(server: Server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async function startMockWsUpstream() {
    const upstream = createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, ws => upstreamWs.emit("connection", ws));
    });
    const base = await listen(upstream);
    const close = async () => {
      for (const client of upstreamWs.clients) client.terminate();
      upstreamWs.close();
      await closeServer(upstream);
    };
    return { upstream, upstreamWs, base, close };
  }

  async function connectWsExpectStatus(url: string, origin: string | null = "http://localhost:3100"): Promise<number> {
    return new Promise<number>((resolve) => {
      const ws = new WebSocket(url, origin ? { origin } : {});
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      ws.on("error", (err: { status?: number }) => resolve(err?.status ?? 502));
    });
  }

  async function setupPluginWsAppServer(opts?: {
    actor?: Record<string, unknown>;
    workerResult?: unknown;
    wsOptions?: Parameters<typeof createApp>[0]["wsOptions"];
    upgradeDeadlineMs?: number;
  }) {
    const { app, workerManager } = await createApp({
      actor: opts?.actor ?? board,
      plugin,
      workerResult: opts?.workerResult,
      wsOptions: opts?.wsOptions,
    });
    const server = createServer(app);
    setupPluginApiWebSocketServer(server, app, opts?.upgradeDeadlineMs ? { upgradeDeadlineMs: opts.upgradeDeadlineMs } : undefined);
    const base = await listen(server);
    return { app, server, base, workerManager, close: () => closeServer(server) };
  }

  async function rejection(actor: Record<string, unknown>, origin?: string) {
    const appSvc = await setupPluginWsAppServer({ actor });
    try {
      const status = await connectWsExpectStatus(`${appSvc.base}${endpoint}`, origin ?? null);
      return { status, calls: appSvc.workerManager.call.mock.calls.length };
    } finally {
      await appSvc.close();
    }
  }

  it("rejects missing/bad Origin, anonymous callers and agents before worker dispatch", async () => {
    expect(await rejection(board)).toEqual({ status: 403, calls: 0 });
    expect(await rejection(board, "https://attacker.test")).toEqual({ status: 403, calls: 0 });
    expect(await rejection({ type: "none" }, "http://localhost:3100")).toEqual({ status: 403, calls: 0 });
    expect(await rejection({ type: "agent", agentId: "agent", companyId }, "http://localhost:3100")).toEqual({ status: 403, calls: 0 });
  });

  // fork(TECH-8283 F1, Finding A): Reject private network WSS destinations by default
  it.each([
    "wss://127.0.0.1:9999/channels/build-output",
    "wss://169.254.169.254/channels/build-output",
  ])("rejects private/reserved upstream target %s with 502 and opens no socket", async (badUpstreamUrl) => {
    const appSvc = await setupPluginWsAppServer({ workerResult: { websocket: { url: badUpstreamUrl } }, wsOptions: { allowPrivateNetwork: false } });
    try {
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`)).toBe(502);
    } finally {
      await appSvc.close();
    }
  });

  it("never exposes a worker's upstream credentials over ordinary HTTP", async () => {
    const { app, workerManager } = await createApp({
      actor: board,
      plugin,
      workerResult: { websocket: { url: "wss://private.test", headers: { Authorization: "fixture-secret" } } },
    });
    const response = await request(app).get(endpoint);
    expect(response.status).toBe(426);
    expect(response.text).not.toContain("fixture-secret");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it.each(["build-output", "metrics"])("proxies text and binary %s channels without resource or protocol assumptions", async (channelId) => {
    let upstreamHeaders: Record<string, unknown> = {};
    const mockWs = await startMockWsUpstream();
    mockWs.upstream.on("upgrade", (req) => { upstreamHeaders = req.headers; });
    mockWs.upstreamWs.on("connection", ws => {
      ws.on("message", (bytes, isBinary) => ws.send(bytes, { binary: isBinary }));
    });
    const appSvc = await setupPluginWsAppServer({
      workerResult: {
        websocket: {
          url: mockWs.base.replace("http:", "wss:") + `/channels/${channelId}`,
          headers: { Authorization: "Bearer fixture-only" },
        },
      },
    });
    const ws = new WebSocket(`${appSvc.base}${endpoint.replace("build-output", channelId)}`, {
      origin: "http://localhost:3100",
      headers: { Cookie: "browser=fixture", Authorization: "browser-only" },
    });
    try {
      await once(ws, "open");
      const payload = Buffer.from([0, 1, 127, 128, 255]);
      const reply = once(ws, "message");
      ws.send(payload);
      expect((await reply)[0]).toEqual(payload);
      const event = JSON.stringify({ event: "progress", value: 42 });
      const textReply = once(ws, "message");
      ws.send(event);
      expect((await textReply)[0].toString()).toBe(event);
      expect(appSvc.workerManager.call).toHaveBeenCalledWith(
        pluginId, "handleApiRequest", expect.objectContaining({ routeKey: "channel.connect", params: { channelId }, companyId }),
      );
      expect(upstreamHeaders.authorization).toBe("Bearer fixture-only");
      expect(upstreamHeaders.cookie).toBeUndefined();
      expect(upstreamHeaders.origin).toBeUndefined();
      ws.close();
      await once([...mockWs.upstreamWs.clients][0], "close");
    } finally {
      ws.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 F2): Revocation teardown within lifetime/tick
  it("destroys socket when plugin is revoked or worker stops", async () => {
    const mockWs = await startMockWsUpstream();
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true, watchIntervalMs: 25 },
    });
    const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
    try {
      await once(ws, "open");
      mockRegistry.getById.mockResolvedValue({ ...plugin, status: "disabled" });
      expect(await once(ws, "close")).toBeDefined();
    } finally {
      ws.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  it("destroys socket when hard lifetime expires", async () => {
    const mockWs = await startMockWsUpstream();
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true, lifetimeMs: 50 },
    });
    const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
    try {
      await once(ws, "open");
      expect(await once(ws, "close")).toBeDefined();
    } finally {
      ws.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 F3): Concurrency cap per (actor, plugin) = 4; reject 429 before worker dispatch
  it("rejects 429 when concurrency cap is exceeded and does not call worker", async () => {
    const mockWs = await startMockWsUpstream();
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true },
    });
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
        await once(ws, "open");
        sockets.push(ws);
      }
      expect(appSvc.workerManager.call).toHaveBeenCalledTimes(4);
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`)).toBe(429);
      expect(appSvc.workerManager.call).toHaveBeenCalledTimes(4);

      const toClose = sockets.pop()!;
      toClose.close();
      await once(toClose, "close");
      const fifthWs = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
      await once(fifthWs, "open");
      sockets.push(fifthWs);
      expect(appSvc.workerManager.call).toHaveBeenCalledTimes(5);
    } finally {
      for (const s of sockets) s.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 F6): Handshake deadline sub-cap
  it("terminates when handshake deadline expires before 101", async () => {
    const upstream = createServer((_req, res) => { res.end(); });
    const baseUpstream = await listen(upstream);
    const { app } = await createApp({
      actor: board, plugin,
      workerResult: { websocket: { url: baseUpstream.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true, handshakeDeadlineMs: 50 },
    });
    const server = createServer(app);
    setupPluginApiWebSocketServer(server, app);
    const base = await listen(server);
    try {
      expect(await connectWsExpectStatus(`${base}${endpoint}`)).toBe(502);
    } finally {
      await Promise.all([closeServer(server), closeServer(upstream)]);
    }
  });

  // fork(TECH-8283 F4): Header allowlist rejects forbidden upstream headers with 502
  it("rejects worker upstream header outside allowlist with 502 and writes nothing upstream", async () => {
    let reached = false;
    const upstream = createServer((_req, _res) => { reached = true; });
    upstream.on("upgrade", () => { reached = true; });
    const baseUpstream = await listen(upstream);
    const { app } = await createApp({
      actor: board, plugin,
      workerResult: {
        websocket: { url: baseUpstream.replace("http:", "wss:") + "/channels/build-output", headers: { "content-length": "100" } },
      },
      wsOptions: { allowPrivateNetwork: true },
    });
    const server = createServer(app);
    setupPluginApiWebSocketServer(server, app);
    const base = await listen(server);
    try {
      expect(await connectWsExpectStatus(`${base}${endpoint}`)).toBe(502);
      expect(reached).toBe(false);
    } finally {
      await Promise.all([closeServer(server), closeServer(upstream)]);
    }
  });

  // fork(TECH-8283 F4): Regression - non-WS route returns 200 and excludes secret
  it("excludes websocket credentials when non-WS route worker returns websocket field", async () => {
    const httpRoutes = manifest([
      {
        routeKey: "http.info",
        method: "GET",
        path: "/info",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const httpPlugin = { id: pluginId, pluginKey: httpRoutes.id, status: "ready", manifestJson: httpRoutes };
    const { app } = await createApp({
      actor: board,
      plugin: httpPlugin,
      workerResult: {
        status: 200,
        body: { ok: true, data: "visible" },
        websocket: {
          url: "wss://secret.internal/leak",
          headers: { Authorization: "Bearer super-secret-token" },
        },
      },
    });
    const response = await request(app).get(`/api/plugins/${pluginId}/api/info?companyId=${companyId}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: "visible" });
    expect(response.text).not.toContain("super-secret-token");
    expect(response.text).not.toContain("secret.internal");
    expect(response.headers.authorization).toBeUndefined();
  });

  // fork(TECH-8283 Finding B1): Stalled worker -> deadline (504), then 5 sequential connects none 429
  it("handles stalled worker timeout (504) and releases slot so subsequent connections succeed", async () => {
    const mockWs = await startMockWsUpstream();
    let stallWorker = true;
    const appSvc = await setupPluginWsAppServer({
      workerResult: () => (stallWorker ? new Promise(() => {}) : Promise.resolve({ websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } })),
      wsOptions: { allowPrivateNetwork: true, upgradeDeadlineMs: 40 },
      upgradeDeadlineMs: 40,
    });
    try {
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`)).toBe(504);
      stallWorker = false;
      for (let i = 0; i < 5; i += 1) {
        const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
        await once(ws, "open");
        ws.close();
        await once(ws, "close");
      }
    } finally {
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 Finding B2): Slow DNS counts against deadline, upstream never reached
  it("counts slow DNS against deadline and never reaches upstream", async () => {
    let upstreamReached = false;
    const upstream = createServer((_req, _res) => { upstreamReached = true; });
    upstream.on("upgrade", () => { upstreamReached = true; });
    await listen(upstream);
    const slowLookup = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([{ address: "127.0.0.1", family: 4 }]), 200)));
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: "wss://slow-dns.test:8443/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true, upgradeDeadlineMs: 40, lookup: slowLookup },
      upgradeDeadlineMs: 40,
    });
    try {
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`, "http://localhost:3100")).toBe(504);
      expect(upstreamReached).toBe(false);
    } finally {
      await Promise.all([appSvc.close(), closeServer(upstream)]);
    }
  });

  // fork(TECH-8283 Finding B3): Established tunnel survives past upgrade deadline
  it("allows established tunnel to survive past the upgrade deadline", async () => {
    const mockWs = await startMockWsUpstream();
    mockWs.upstreamWs.on("connection", (ws) => {
      ws.on("message", (msg) => ws.send(`echo:${msg.toString()}`));
    });
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true, upgradeDeadlineMs: 50, lifetimeMs: 10_000 },
      upgradeDeadlineMs: 50,
    });
    const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
    try {
      await once(ws, "open");
      await new Promise((r) => setTimeout(r, 80));
      const reply = once(ws, "message");
      ws.send("hello-after-deadline");
      expect((await reply)[0].toString()).toBe("echo:hello-after-deadline");
    } finally {
      ws.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 Finding C1): Authz false at 101 -> no open
  it("fails closed when authorization returns false at 101 upgrade", async () => {
    const mockWs = await startMockWsUpstream();
    let initialCall = true;
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true },
    });
    mockRegistry.getById.mockImplementation(() => {
      if (initialCall) { initialCall = false; return Promise.resolve(plugin); }
      return Promise.resolve({ ...plugin, status: "disabled" });
    });
    try {
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`)).toBe(502);
    } finally {
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 Finding C2): Authz throws at 101 -> fail closed
  it("fails closed when authorization throws at 101 upgrade", async () => {
    const mockWs = await startMockWsUpstream();
    let initialCall = true;
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true },
    });
    mockRegistry.getById.mockImplementation(() => {
      if (initialCall) { initialCall = false; return Promise.resolve(plugin); }
      return Promise.reject(new Error("Database error during 101 auth check"));
    });
    try {
      expect(await connectWsExpectStatus(`${appSvc.base}${endpoint}`)).toBe(502);
    } finally {
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 Finding C3): No upstream frames leak when authz fails
  it("discards buffered upstream frames without forwarding to client when authz fails at 101", async () => {
    let clientReceivedFrame = false, initialCall = true;
    const mockWs = await startMockWsUpstream();
    mockWs.upstreamWs.on("connection", (ws) => ws.send("confidential-upstream-frame"));
    const appSvc = await setupPluginWsAppServer({
      workerResult: { websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" } },
      wsOptions: { allowPrivateNetwork: true },
    });
    mockRegistry.getById.mockImplementation(() => {
      if (initialCall) { initialCall = false; return Promise.resolve(plugin); }
      return Promise.resolve({ ...plugin, status: "disabled" });
    });
    const ws = new WebSocket(`${appSvc.base}${endpoint}`, { origin: "http://localhost:3100" });
    ws.on("message", () => { clientReceivedFrame = true; });
    try {
      await new Promise<void>((resolve) => {
        ws.on("unexpected-response", (_req, res) => { res.resume(); resolve(); });
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });
      expect(clientReceivedFrame).toBe(false);
    } finally {
      ws.terminate();
      await Promise.all([appSvc.close(), mockWs.close()]);
    }
  });

  // fork(TECH-8283 Residual Verification): Composed server with late live-events handler
  it("in production assembly with late live-events handler, valid plugin upgrade works, live-events works, and unknown upgrade is destroyed", async () => {
    const mockWs = await startMockWsUpstream();
    mockWs.upstreamWs.on("connection", (ws) => {
      ws.on("message", (msg) => ws.send(`echo:${msg.toString()}`));
    });

    const { app } = await createApp({
      actor: board,
      plugin,
      workerResult: {
        websocket: { url: mockWs.base.replace("http:", "wss:") + "/channels/build-output" },
      },
      wsOptions: { allowPrivateNetwork: true },
    });

    const { createPaperclipHttpServer } = await import("../http/server.js");
    const server = createPaperclipHttpServer(app, { apiUrl: "http://127.0.0.1:3210" });

    const liveEventsWs = new WebSocketServer({ noServer: true });
    liveEventsWs.on("connection", (ws) => {
      ws.on("message", (msg) => ws.send(`live:${msg.toString()}`));
    });

    server.on("upgrade", (req, socket, head) => {
      if ((req as { paperclipWebSocketHandled?: boolean }).paperclipWebSocketHandled) return;
      if (req.url?.startsWith("/api/companies/test-company/live")) {
        (req as { paperclipWebSocketHandled?: boolean }).paperclipWebSocketHandled = true;
        liveEventsWs.handleUpgrade(req, socket, head, (ws) => liveEventsWs.emit("connection", ws));
        return;
      }
      socket.destroy();
    });

    const base = await listen(server);
    try {
      const pluginWs = new WebSocket(`${base}${endpoint}`, { origin: "http://localhost:3100" });
      await once(pluginWs, "open");
      const pluginReply = once(pluginWs, "message");
      pluginWs.send("hello-plugin");
      expect((await pluginReply)[0].toString()).toBe("echo:hello-plugin");
      pluginWs.close(); await once(pluginWs, "close");

      const liveWs = new WebSocket(`${base}/api/companies/test-company/live`);
      await once(liveWs, "open");
      const liveReply = once(liveWs, "message");
      liveWs.send("hello-live");
      expect((await liveReply)[0].toString()).toBe("live:hello-live");
      liveWs.close(); await once(liveWs, "close");

      const unknownError = await new Promise<boolean>((resolve) => {
        const unknownWs = new WebSocket(`${base}/api/unknown/random/route`);
        unknownWs.on("error", () => resolve(true));
        unknownWs.on("close", () => resolve(true));
      });
      expect(unknownError).toBe(true);
    } finally {
      liveEventsWs.close();
      await Promise.all([closeServer(server), mockWs.close()]);
    }
  });

  it("only permits declared board GET WebSockets", () => {
    expect(pluginManifestV1Schema.safeParse(apiRoutes).success).toBe(true);
    const bad = structuredClone(apiRoutes);
    bad.apiRoutes![0].auth = "agent";
    expect(pluginManifestV1Schema.safeParse(bad).success).toBe(false);
  });
});

it("agent-scoped plugin routes reuse agent:read and refuse denied access before worker dispatch", async () => {
  const agentId = "33333333-3333-4333-8333-333333333333", companyId = "22222222-2222-4222-8222-222222222222", pluginId = "11111111-1111-4111-8111-111111111111";
  const chain = { from: () => chain, where: () => chain, limit: vi.fn(async () => [{ id: agentId, companyId }]) };
  const apiRoutes = manifest([{ routeKey: "status", method: "GET", path: "/agents/:agentId/status", auth: "board", capability: "api.routes.register", companyResolution: { from: "agent", param: "agentId" } }]);
  const actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "user", isInstanceAdmin: true };
  const { app, workerManager } = await createApp({ db: { select: () => chain }, actor, plugin: { id: pluginId, pluginKey: apiRoutes.id, status: "ready", manifestJson: apiRoutes } });
  mockAccess.decide.mockResolvedValue({ allowed: true });
  expect((await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`)).status).toBe(200);
  expect(mockAccess.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "agent:read", resource: { type: "agent", companyId, agentId } }));
  workerManager.call.mockClear(); mockAccess.decide.mockResolvedValue({ allowed: false });
  expect((await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`)).status).toBe(404);
  actor.source = "session"; actor.companyIds = ["another-company"];
  const crossCompany = await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`);
  chain.limit.mockResolvedValue([]);
  const missing = await request(app).get(`/api/plugins/${pluginId}/api/agents/${agentId}/status`);
  expect(crossCompany.status).toBe(404);
  expect(crossCompany.body).toEqual(missing.body);
  expect(workerManager.call).not.toHaveBeenCalled();
});
