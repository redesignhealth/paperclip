import { describe, expect, it, beforeEach, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Response } from "express";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  isAllowedWorkerUpstreamHeader,
  acquireWebSocketSlot,
  resetWebSocketSlotsForTest,
  setupPluginApiWebSocketServer,
  proxyPluginApiWebSocket,
  createGuardedWebSocketProxyForTesting,
  safeUrlForLog,
  PLUGIN_API_WS_ROUTE_REGEX,
  MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN,
  MAX_WS_CONCURRENT_PER_COMPANY,
} from "../plugin-api-ws.js";

let mockHttpsRequestOverride: ((...args: unknown[]) => unknown) | null = null;

// Rework node:https mock locally to http for bare server tests
vi.mock("node:https", () => ({
  request: (urlOrOptions: unknown, optionsOrCallback?: unknown, callback?: unknown) => {
    if (mockHttpsRequestOverride) {
      return mockHttpsRequestOverride(urlOrOptions, optionsOrCallback, callback);
    }
    if (urlOrOptions instanceof URL || typeof urlOrOptions === "string") {
      const local = new URL(urlOrOptions);
      local.protocol = "http:";
      return (httpRequest as (...args: unknown[]) => unknown)(local, optionsOrCallback, callback);
    }
    const { servername, ...rest } = (urlOrOptions ?? {}) as Record<string, unknown>;
    return (httpRequest as (...args: unknown[]) => unknown)(rest, optionsOrCallback, callback);
  },
}));

describe("plugin-api-ws unit & lifecycle tests (P2a unwired module)", () => {
  beforeEach(() => {
    resetWebSocketSlotsForTest();
    mockHttpsRequestOverride = null;
  });

  describe("safeUrlForLog credential stripping (Finding 1)", () => {
    it("strips path-token, query-token, hash-token, and credentials for safe logging", () => {
      // fork(TECH-8283 Finding 1): Only origin/host is retained; path/query/credentials/hash stripped
      const sensitiveUrl = "wss://user:pass@service.internal:8443/channels/secret_path_token?key=secret_query_token#secret_hash_token";
      const sanitized = safeUrlForLog(sensitiveUrl);
      expect(sanitized).toBe("wss://service.internal:8443");
      expect(sanitized).not.toContain("secret_path_token");
      expect(sanitized).not.toContain("secret_query_token");
      expect(sanitized).not.toContain("secret_hash_token");
      expect(sanitized).not.toContain("user");
      expect(sanitized).not.toContain("pass");
    });

    it("returns <invalid-url> for unparseable input", () => {
      expect(safeUrlForLog("not a valid url")).toBe("<invalid-url>");
    });
  });

  describe("PLUGIN_API_WS_ROUTE_REGEX route matching (Finding 9)", () => {
    it.each([
      "/api/plugins/p1/api", "/api/plugins/p1/api/", "/api/plugins/p1/api?companyId=c1",
      "/api/plugins/p1/api/channels/build", "/api/plugins/my-plugin_123/api/test?foo=bar",
    ])("claims matching plugin api upgrade path %s", (path) => {
      expect(PLUGIN_API_WS_ROUTE_REGEX.test(path)).toBe(true);
    });

    it.each([
      "/api/plugins", "/api/plugins/p1", "/api/plugins/p1/tools",
      "/api/runner/v1/connect/123", "/other/path",
    ])("ignores non-plugin upgrade path %s", (path) => {
      expect(PLUGIN_API_WS_ROUTE_REGEX.test(path)).toBe(false);
    });
  });

  describe("isAllowedWorkerUpstreamHeader allowlist (Finding 6)", () => {
    it.each([
      "authorization", "Authorization", "AUTHORIZATION",
      "user-agent", "User-Agent", "x-custom-header",
      "X-Trace-Id", "x-paperclip-key", "x-session-id",
    ])("allows permitted upstream header %s", (name) => {
      expect(isAllowedWorkerUpstreamHeader(name)).toBe(true);
    });

    it.each([
      "x-real-ip", "X-Real-IP", "x-original-url", "X-Original-URL",
      "x-rewrite-url", "x-http-method-override", "x-http-method", "x-method-override",
      "x-forwarded-for", "X-Forwarded-For", "x-forwarded-proto", "x-forwarded-host",
      "x-forwarded-port", "x-forwarded-prefix", "cookie", "Cookie", "set-cookie",
      "host", "Host", "origin", "upgrade", "connection", "content-length",
      "transfer-encoding", "proxy-authorization", "sec-websocket-key", "sec-websocket-accept",
    ])("rejects non-allowlisted upstream header %s", (name) => {
      expect(isAllowedWorkerUpstreamHeader(name)).toBe(false);
    });
  });

  describe("acquireWebSocketSlot concurrency caps (F3, Finding 12)", () => {
    const companyId = "company-1", actorId = "user-1", pluginId = "plugin-1";

    it("enforces concurrency cap per (actor, plugin) = 4", () => {
      const releases: Array<() => void> = [];
      try {
        for (let i = 0; i < MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN; i += 1) {
          releases.push(acquireWebSocketSlot(companyId, actorId, pluginId)!);
        }
        expect(acquireWebSocketSlot(companyId, actorId, pluginId)).toBeNull();
        releases.pop()!();
        const retry = acquireWebSocketSlot(companyId, actorId, pluginId);
        expect(retry).not.toBeNull();
        releases.push(retry!);
      } finally {
        for (const r of releases) r();
      }
    });

    it("enforces concurrency cap per company = 32 and releases all slots", () => {
      // fork(TECH-8283 Finding 12): Release all acquired slots
      const releases: Array<() => void> = [];
      try {
        for (let i = 0; i < MAX_WS_CONCURRENT_PER_COMPANY; i += 1) {
          releases.push(acquireWebSocketSlot(companyId, `user-${i}`, `plugin-${i % 2}`)!);
        }
        expect(acquireWebSocketSlot(companyId, "user-new", "plugin-new")).toBeNull();
        const otherCompanyRelease = acquireWebSocketSlot("company-2", "user-1", "plugin-1")!;
        releases.push(otherCompanyRelease);
        releases.shift()!();
        releases.push(acquireWebSocketSlot(companyId, "user-new", "plugin-new")!);
      } finally {
        for (const r of releases) r();
      }
    });

    it("release is idempotent and decrements only once", () => {
      const release1 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      const release2 = acquireWebSocketSlot(companyId, actorId, pluginId)!;
      const cleanup: Array<() => void> = [release2];
      try {
        release1();
        release1(); // Idempotent repeat
        cleanup.push(acquireWebSocketSlot(companyId, actorId, pluginId)!);
        cleanup.push(acquireWebSocketSlot(companyId, actorId, pluginId)!);
        cleanup.push(acquireWebSocketSlot(companyId, actorId, pluginId)!);
        expect(acquireWebSocketSlot(companyId, actorId, pluginId)).toBeNull();
      } finally {
        for (const r of cleanup) r();
      }
    });
  });

  describe("production API vs test factory seam (Finding 3)", () => {
    it("throws when createGuardedWebSocketProxyForTesting is invoked outside test environment", () => {
      // fork(TECH-8283 Finding 3): Runtime test-environment guard
      const prevEnv = process.env.NODE_ENV;
      const prevVitest = process.env.VITEST;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.VITEST;
        expect(() => createGuardedWebSocketProxyForTesting({ allowPrivateNetwork: true })).toThrow(
          /only permitted in test environments/,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      }
    });

    it("production exported proxyPluginApiWebSocket strictly rejects private/loopback destination", async () => {
      // fork(TECH-8283 Finding 3): Production exported API accepts no bypass seam and rejects private targets
      const server = createServer();
      setupPluginApiWebSocketServer(server, (req, res) => {
        void proxyPluginApiWebSocket(
          req as never,
          res as unknown as Response,
          { url: "wss://127.0.0.1:59999/test" },
          () => Promise.resolve(true),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

      try {
        const result = await new Promise<{ status: number }>((resolve) => {
          const ws = new WebSocket(`${base}/api/plugins/p1/api/test`);
          ws.on("unexpected-response", (_req, res) => {
            res.resume();
            resolve({ status: res.statusCode! });
          });
          ws.on("error", () => resolve({ status: 502 }));
        });
        expect(result.status).toBe(502);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("bare HTTP server direct lifecycle tests (Finding 1, 2, 3, 12)", () => {
    async function listen(server: Server): Promise<string> {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    }

    async function closeServer(server: Server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    it("fail() after connected destroys socket and upstream (Finding 1)", async () => {
      const upstream = createServer();
      const upstreamWs = new WebSocketServer({ noServer: true });
      let upstreamSocket: Duplex | undefined;
      upstream.on("upgrade", (req, socket, head) => {
        upstreamSocket = socket;
        upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws));
      });
      const upstreamBase = await listen(upstream);
      const testProxy = createGuardedWebSocketProxyForTesting({ allowPrivateNetwork: true });

      const server = createServer();
      setupPluginApiWebSocketServer(server, (req, res) => {
        void testProxy(
          req as never, res as unknown as Response,
          { url: upstreamBase.replace("http:", "wss:") + "/test" },
          () => Promise.resolve(true), { watchIntervalMs: 25 },
        );
      });
      const serverBase = await listen(server);
      const ws = new WebSocket(`${serverBase}/api/plugins/p1/api/test`);
      try {
        await once(ws, "open");
        expect(upstreamSocket).toBeDefined();
        ws.terminate();
        await once(ws, "close");
        await new Promise((r) => setTimeout(r, 50));
        expect(upstreamSocket?.destroyed).toBe(true);
      } finally {
        ws.terminate();
        upstreamWs.close();
        await Promise.all([closeServer(server), closeServer(upstream)]);
      }
    });

    it("handles synchronous httpsRequest throw safely without ReferenceError and destroys socket (Finding 2)", async () => {
      // fork(TECH-8283 Finding 2): Synchronous throw in httpsRequest must not throw ReferenceError
      mockHttpsRequestOverride = () => {
        throw new Error("Synchronous failure in https.request");
      };

      const testProxy = createGuardedWebSocketProxyForTesting({ allowPrivateNetwork: true });
      const server = createServer();
      setupPluginApiWebSocketServer(server, (req, res) => {
        void testProxy(
          req as never, res as unknown as Response,
          { url: "wss://127.0.0.1:8443/test" },
          () => Promise.resolve(true),
        );
      });
      const serverBase = await listen(server);

      try {
        const result = await new Promise<{ status: number }>((resolve) => {
          const ws = new WebSocket(`${serverBase}/api/plugins/p1/api/test`);
          ws.on("unexpected-response", (_req, res) => {
            res.resume();
            resolve({ status: res.statusCode! });
          });
          ws.on("error", () => resolve({ status: 502 }));
        });
        expect(result.status).toBe(502);
      } finally {
        await closeServer(server);
      }
    });

    it("failed connect cleans up socket and clears timers (Finding 1)", async () => {
      const testProxy = createGuardedWebSocketProxyForTesting({ allowPrivateNetwork: true });
      const server = createServer();
      setupPluginApiWebSocketServer(server, (req, res) => {
        void testProxy(
          req as never, res as unknown as Response,
          { url: "wss://127.0.0.1:59999/test" },
          () => Promise.resolve(true),
        );
      });
      const serverBase = await listen(server);
      try {
        const result = await new Promise<{ status: number }>((resolve) => {
          const ws = new WebSocket(`${serverBase}/api/plugins/p1/api/test`);
          ws.on("unexpected-response", (_req, res) => { res.resume(); resolve({ status: res.statusCode! }); });
          ws.on("error", () => resolve({ status: 502 }));
        });
        expect(result.status).toBe(502);
      } finally {
        await closeServer(server);
      }
    });

    it("watchdog non-overlap: does not call available() concurrently during slow tick (Finding 2)", async () => {
      const upstream = createServer();
      const upstreamWs = new WebSocketServer({ noServer: true });
      upstream.on("upgrade", (req, socket, head) => {
        upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws));
      });
      const upstreamBase = await listen(upstream);
      let inFlightCount = 0, maxConcurrent = 0;
      const slowAvailable = vi.fn().mockImplementation(async () => {
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        await new Promise((r) => setTimeout(r, 60));
        inFlightCount -= 1;
        return true;
      });
      const testProxy = createGuardedWebSocketProxyForTesting({ allowPrivateNetwork: true });
      const server = createServer();
      setupPluginApiWebSocketServer(server, (req, res) => {
        void testProxy(
          req as never, res as unknown as Response,
          { url: upstreamBase.replace("http:", "wss:") + "/test" },
          slowAvailable, { watchIntervalMs: 20 },
        );
      });
      const serverBase = await listen(server);
      const ws = new WebSocket(`${serverBase}/api/plugins/p1/api/test`);
      try {
        await once(ws, "open");
        await new Promise((r) => setTimeout(r, 120));
        expect(maxConcurrent).toBe(1);
      } finally {
        ws.terminate();
        upstreamWs.close();
        await Promise.all([closeServer(server), closeServer(upstream)]);
      }
    });

    it("deadline timer does not write 504 if response already finished (Finding 3)", async () => {
      const server = createServer();
      setupPluginApiWebSocketServer(server, (_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied" }));
      }, { upgradeDeadlineMs: 30 });
      const serverBase = await listen(server);
      try {
        const result = await new Promise<{ status: number }>((resolve) => {
          const ws = new WebSocket(`${serverBase}/api/plugins/p1/api/test`);
          ws.on("unexpected-response", (_req, res) => { res.resume(); resolve({ status: res.statusCode! }); });
          ws.on("error", () => resolve({ status: 403 }));
        });
        expect(result.status).toBe(403);
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        await closeServer(server);
      }
    });
  });
});
