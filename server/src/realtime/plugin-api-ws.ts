/**
 * Plugin API WebSocket Server
 *
 * Listener Registration Order (fork(TECH-8283 Finding 11)):
 * setupPluginApiWebSocketServer must be registered BEFORE any catch-all or fallback
 * upgrade listeners (such as live-events-ws or createPaperclipHttpServer terminal fallback).
 * It claims matching upgrade requests synchronously (setting request.paperclipWebSocketHandled = true)
 * before any asynchronous dispatch so downstream listeners do not destroy in-flight upgrades.
 */

import { ServerResponse, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { Request, Response } from "express";
import {
  validateAndResolveFetchUrl,
  isPrivateOrDeniedWsIP,
  type ValidatedFetchTarget,
} from "../services/plugin-egress-guard.js";
import { logger } from "../middleware/logger.js";

export const PLUGIN_WS_UPGRADE_DEADLINE_MS = 20_000;

export const pluginApiUpgrade = Symbol("pluginApiUpgrade");

// fork(TECH-8283 Finding 9): Claim routes consistently with/without trailing slash and query strings
export const PLUGIN_API_WS_ROUTE_REGEX = /^\/api\/plugins\/[^/]+\/api(?:\/|\?|$)/;

export interface PluginApiUpgradeState {
  socket: Socket;
  head: Buffer;
  deadlineAt: number;
  signal: AbortSignal;
  settle: (reason: "success" | "error" | "timeout") => boolean;
}

export type UpgradeRequest = IncomingMessage & {
  paperclipWebSocketHandled?: boolean;
  [pluginApiUpgrade]?: PluginApiUpgradeState;
};

// fork(TECH-8283 F3): Concurrency cap per (actor, plugin) = 4, per company = 32
export const MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN = 4;
export const MAX_WS_CONCURRENT_PER_COMPANY = 32;

const activePerActorPlugin = new Map<string, number>();
const activePerCompany = new Map<string, number>();

export function acquireWebSocketSlot(companyId: string, actorId: string, pluginId: string): (() => void) | null {
  const actorPluginKey = `${actorId}:${pluginId}`;
  const currentActorPlugin = activePerActorPlugin.get(actorPluginKey) ?? 0;
  if (currentActorPlugin >= MAX_WS_CONCURRENT_PER_ACTOR_PLUGIN) return null;

  const currentCompany = activePerCompany.get(companyId) ?? 0;
  if (currentCompany >= MAX_WS_CONCURRENT_PER_COMPANY) return null;

  activePerActorPlugin.set(actorPluginKey, currentActorPlugin + 1);
  activePerCompany.set(companyId, currentCompany + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const actorCount = activePerActorPlugin.get(actorPluginKey) ?? 1;
    if (actorCount <= 1) activePerActorPlugin.delete(actorPluginKey);
    else activePerActorPlugin.set(actorPluginKey, actorCount - 1);

    const compCount = activePerCompany.get(companyId) ?? 1;
    if (compCount <= 1) activePerCompany.delete(companyId);
    else activePerCompany.set(companyId, compCount - 1);
  };
}

export function resetWebSocketSlotsForTest() {
  activePerActorPlugin.clear();
  activePerCompany.clear();
}

// fork(TECH-8283 Finding 6): Header allowlist with explicit denylist of routing/proxy headers
const DENIED_X_HEADER_PREFIXES = [
  "x-forwarded-",
];
const DENIED_X_HEADERS = new Set([
  "x-real-ip",
  "x-original-url",
  "x-rewrite-url",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

export function isAllowedWorkerUpstreamHeader(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (lower === "authorization" || lower === "user-agent") return true;
  if (!lower.startsWith("x-")) return false;
  if (DENIED_X_HEADERS.has(lower)) return false;
  if (DENIED_X_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  return true;
}

// fork(TECH-8283 Finding 5): Lifecycle options for route-level callers
export interface PluginApiWsLifecycleOptions {
  upgradeDeadlineMs?: number;
  watchIntervalMs?: number;
  lifetimeMs?: number;
}

// fork(TECH-8283 Finding 1): Strip path, query, credentials, and fragment for logging
export function safeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<invalid-url>";
  }
}

// fork(TECH-8283 Finding 1): Stable sanitized reason codes without raw error strings
function classifyValidationErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.message.includes("Invalid WSS target URL") || err.message.startsWith("Invalid URL")) {
      return "invalid_target_url";
    }
    if (err.message.startsWith("Disallowed upstream header")) {
      return "disallowed_upstream_header";
    }
    if (err.message.startsWith("Disallowed protocol")) {
      return "disallowed_protocol";
    }
    if (err.message.includes("private/reserved ranges")) {
      return "private_ip_denied";
    }
    if (err.message.startsWith("DNS lookup timed out")) {
      return "dns_timeout";
    }
    if (err.message.startsWith("DNS resolution")) {
      return "dns_resolution_failed";
    }
  }
  return "target_validation_failed";
}

const AVAILABLE_TIMEOUT_MS = 5_000;

async function checkAvailableWithTimeout(
  available: () => Promise<boolean>,
  timeoutMs = AVAILABLE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      available(),
      new Promise<boolean>((_, reject) => {
        timer = setTimeout(() => reject(new Error("available() timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// fork(TECH-8283 Finding 3): Test seam separated from production API
export interface PluginApiWsTestSeam {
  allowPrivateNetwork?: boolean;
  lookup?: typeof import("node:dns/promises").lookup;
  handshakeDeadlineMs?: number;
}

function isTestRuntimeEnvironment(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}

/**
 * Explicit test factory with runtime test-environment guard.
 * fork(TECH-8283 Finding 3): Throws outside test runtime; prevents production bypass.
 */
export function createGuardedWebSocketProxyForTesting(
  testSeam: PluginApiWsTestSeam,
): (
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => Promise<boolean>,
  options?: PluginApiWsLifecycleOptions,
) => Promise<void> {
  if (!isTestRuntimeEnvironment()) {
    throw new Error("createGuardedWebSocketProxyForTesting is only permitted in test environments");
  }
  return (req, res, target, available, options) =>
    internalProxyPluginApiWebSocket(req, res, target, available, options, testSeam);
}

/** Reuse the full HTTP authentication/company pipeline for plugin upgrades. */
export function setupPluginApiWebSocketServer(
  server: Server,
  handler: RequestListener,
  lifecycleOptions?: PluginApiWsLifecycleOptions,
) {
  server.on("upgrade", (request: UpgradeRequest, socket: Socket, head: Buffer) => {
    // fork(TECH-8283 Finding 9, Finding 11): Synchronous path claim before downstream listeners
    if (request.paperclipWebSocketHandled || !PLUGIN_API_WS_ROUTE_REGEX.test(request.url ?? "")) return;
    request.paperclipWebSocketHandled = true;

    // fork(TECH-8283 Finding B): One absolute deadline armed at browser upgrade acceptance
    const deadlineMs = lifecycleOptions?.upgradeDeadlineMs ?? PLUGIN_WS_UPGRADE_DEADLINE_MS;
    const deadlineAt = Date.now() + deadlineMs;
    const abortController = new AbortController();

    let settled = false;
    const settle = (reason: "success" | "error" | "timeout"): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadlineTimer);
      if (reason !== "success") {
        abortController.abort();
      }
      return true;
    };

    const response = new ServerResponse(request);
    response.assignSocket(socket);
    response.setHeader("Connection", "close");

    // fork(TECH-8283 Finding 3): Deadline timer checks headersSent/writableEnded and clears on response finish/close
    const deadlineTimer = setTimeout(() => {
      if (settle("timeout")) {
        logger.warn("Plugin WebSocket upgrade deadline exceeded");
        if (!socket.destroyed) {
          if (!response.headersSent && !response.writableEnded) {
            response.writeHead(504, { "Content-Type": "application/json", Connection: "close" });
            response.end(JSON.stringify({ error: "Plugin upgrade timed out" }));
          } else {
            socket.destroy();
          }
        }
      }
    }, deadlineMs);
    deadlineTimer.unref();

    const clearDeadline = () => {
      clearTimeout(deadlineTimer);
    };
    response.once("finish", clearDeadline);
    response.once("close", clearDeadline);

    socket.on("error", () => {
      settle("error");
      socket.destroy();
    });
    socket.once("close", () => {
      settle("error");
    });

    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
      || request.headers["content-length"] || request.headers["transfer-encoding"]) {
      settle("error");
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    request[pluginApiUpgrade] = {
      socket,
      head,
      deadlineAt,
      signal: abortController.signal,
      settle,
    };

    response.once("finish", () => {
      if (!socket.destroyed) socket.end();
    });
    handler(request, response);
  });
}

/**
 * Production exported proxy wrapper.
 * fork(TECH-8283 Finding 3): Accepts ONLY safe lifecycle options; no test seam bypass parameters.
 */
export async function proxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => Promise<boolean>,
  options?: PluginApiWsLifecycleOptions,
): Promise<void> {
  return internalProxyPluginApiWebSocket(req, res, target, available, options, undefined);
}

/** Internal implementation: only worker-selected WSS targets and credentials reach upstream. */
async function internalProxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => Promise<boolean>,
  options?: PluginApiWsLifecycleOptions,
  testSeam?: PluginApiWsTestSeam,
): Promise<void> {
  const upgrade = (req as UpgradeRequest)[pluginApiUpgrade];
  if (!upgrade || upgrade.socket.destroyed) return;
  const { socket, head } = upgrade;

  const remainingMs = Math.max(0, upgrade.deadlineAt - Date.now());
  if (remainingMs <= 0 || upgrade.signal.aborted) {
    if (upgrade.settle("timeout")) {
      logger.warn({ reason: "deadline_exceeded_before_dial" }, "Plugin WebSocket upgrade timed out before dial");
      if (!socket.destroyed && !res.headersSent && !res.writableEnded) {
        res.writeHead(504, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: "Plugin upgrade timed out" }));
      }
      socket.destroy();
    }
    return;
  }

  let resolvedTarget: ValidatedFetchTarget;
  try {
    const url = new URL(target.url);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) {
      throw new Error("Invalid WSS target URL");
    }
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      // fork(TECH-8283 Finding 6): Reject any header not in the strict allowlist
      if (!isAllowedWorkerUpstreamHeader(name)) {
        logger.warn({ code: "disallowed_upstream_header" }, "Worker returned prohibited upstream header");
        throw new Error(`Disallowed upstream header: ${name}`);
      }
    }
    // fork(TECH-8283 Finding 5): Pass explicit parameters only; do NOT spread caller options
    resolvedTarget = await validateAndResolveFetchUrl(target.url, {
      allowedProtocols: new Set(["wss:"]),
      isPrivate: isPrivateOrDeniedWsIP,
      allowPrivateNetwork: testSeam?.allowPrivateNetwork,
      lookup: testSeam?.lookup,
      dnsTimeoutMs: Math.min(5_000, remainingMs),
    });
  } catch (err) {
    const isTimeout = upgrade.signal.aborted || Date.now() >= upgrade.deadlineAt;
    const settleReason = isTimeout ? "timeout" : "error";
    if (upgrade.settle(settleReason)) {
      // fork(TECH-8283 Finding 1): Log only stable sanitized code and safe origin/host
      const code = isTimeout ? "upgrade_deadline_timeout" : classifyValidationErrorCode(err);
      logger.warn({ code, target: safeUrlForLog(target.url) }, "Plugin WebSocket target validation failed");
      const status = isTimeout ? 504 : 502;
      if (!socket.destroyed && !res.headersSent && !res.writableEnded) {
        res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify({ error: isTimeout ? "Plugin upgrade timed out" : "Plugin connection unavailable" }));
      }
      socket.destroy();
    }
    return;
  }

  // fork(TECH-8283 Finding 8): Forward array-valued sec-websocket headers correctly
  const headers: Record<string, string | string[]> = { ...target.headers, Connection: "Upgrade", Upgrade: "websocket" };
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const val = req.headers[name];
    if (val !== undefined) {
      headers[name] = Array.isArray(val) ? val.join(", ") : val;
    }
  }

  let connected = false;
  let upstream: Duplex | undefined;
  // fork(TECH-8283 Finding 2): Declare connection before cleanup to avoid TDZ/ReferenceError on sync throw
  let connection: ReturnType<typeof httpsRequest> | undefined;
  let cleanedUp = false;
  let lifetimeTimer: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;

  // fork(TECH-8283 Finding 1, Finding 2): Unified cleanup for all terminal paths; safe if connection undefined
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    connection?.destroy();
    if (upstream && !upstream.destroyed) upstream.destroy();
    if (!socket.destroyed) socket.destroy();
  };
  socket.once("close", cleanup);

  const fail = (status = 502, reason = "connection_failed") => {
    if (upgrade.settle("error")) {
      logger.warn({ status, reason, target: safeUrlForLog(target.url) }, "Plugin WebSocket connection failed");
      if (!connected && !socket.destroyed) {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: status === 504 ? "Plugin upgrade timed out" : "Plugin connection unavailable" }));
        }
      }
    }
    cleanup();
  };

  const port = resolvedTarget.parsedUrl.port ? Number(resolvedTarget.parsedUrl.port) : 443;
  const path = `${resolvedTarget.parsedUrl.pathname}${resolvedTarget.parsedUrl.search}`;
  const connectTimeoutMs = Math.min(15_000, remainingMs);

  const requestOptions = {
    method: "GET",
    host: resolvedTarget.resolvedAddress,
    port,
    path,
    servername: resolvedTarget.tlsServername,
    headers: {
      ...headers,
      Host: resolvedTarget.hostHeader,
    },
    timeout: connectTimeoutMs,
  };

  try {
    connection = httpsRequest(requestOptions);
  } catch (err) {
    // fork(TECH-8283 Finding 2): Synchronous throw in httpsRequest safely invokes fail/cleanup without ReferenceError
    fail(502, "https_request_threw");
    return;
  }

  // fork(TECH-8283 Finding 4): Handshake deadline sub-cap clamped to remaining absolute deadline
  const handshakeDeadlineMs = testSeam?.handshakeDeadlineMs
    ? Math.min(testSeam.handshakeDeadlineMs, remainingMs)
    : remainingMs;
  handshakeTimer = setTimeout(() => {
    if (!connected) {
      fail(502, "handshake_timeout");
    }
  }, handshakeDeadlineMs);
  handshakeTimer.unref();

  connection.on("timeout", () => {
    fail(504, "upstream_connect_timeout");
  });
  connection.on("error", (err) => {
    fail(502, `upstream_connection_error: ${(err as Error)?.message}`);
  });
  connection.on("response", (response) => {
    response.destroy();
    fail(502, `unexpected_http_response: ${response.statusCode}`);
  });

  // fork(TECH-8283 Finding C, Finding 2): Rewritten upgrade handler ordering with bounded auth
  connection.on("upgrade", async (response, remote, remoteHead) => {
    upstream = remote;
    remote.once("error", () => {
      fail(502, "remote_stream_error");
    });
    // fork(TECH-8283 Finding 2): Cleanup runs when upstream destroyed
    remote.once("close", cleanup);
    remote.pause();

    if (socket.destroyed || remote.destroyed || upgrade.signal.aborted || response.statusCode !== 101) {
      fail(502, `upgrade_status_not_101: ${response.statusCode}`);
      return;
    }

    let isAvail = false;
    try {
      // fork(TECH-8283 Finding 2): Bounded authorization check fails closed promptly on hang
      const authTimeoutMs = Math.min(AVAILABLE_TIMEOUT_MS, Math.max(1, upgrade.deadlineAt - Date.now()));
      isAvail = await checkAvailableWithTimeout(available, authTimeoutMs);
    } catch (err) {
      logger.warn({ code: "authz_check_failed" }, "101 authorization check failed or timed out");
      isAvail = false;
    }

    // fork(TECH-8283 Finding 2): Re-check remote.destroyed and socket.destroyed after auth
    if (!isAvail || socket.destroyed || remote.destroyed || upgrade.signal.aborted) {
      fail(502, "authorization_denied_or_stream_destroyed_at_101");
      return;
    }

    if (!upgrade.settle("success")) {
      fail(502, "upgrade_settle_failed");
      return;
    }

    connected = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    connection.setTimeout(0);
    socket.setTimeout(0);
    res.detachSocket(socket);
    socket.once("close", () => res.emit("close"));

    // fork(TECH-8283 Finding 1): Start lifetime and watchdog ONLY after tunnel is established
    const lifetimeMs = options?.lifetimeMs ?? 90_000;
    const watchIntervalMs = options?.watchIntervalMs ?? 5_000;
    lifetimeTimer = setTimeout(() => cleanup(), lifetimeMs);
    lifetimeTimer.unref();

    // fork(TECH-8283 Finding 2): Watchdog with in-flight guard and timeout
    let watchInFlight = false;
    watchTimer = setInterval(async () => {
      if (watchInFlight || socket.destroyed || (upstream && upstream.destroyed)) return;
      watchInFlight = true;
      try {
        const stillAvailable = await checkAvailableWithTimeout(available, Math.min(AVAILABLE_TIMEOUT_MS, watchIntervalMs));
        if (!stillAvailable) {
          logger.warn({ code: "watchdog_revocation" }, "Plugin WebSocket revoked on watchdog tick");
          cleanup();
        }
      } catch (err) {
        logger.warn({ code: "watchdog_timeout_or_error" }, "Plugin WebSocket watchdog check timed out or threw");
        cleanup();
      } finally {
        watchInFlight = false;
      }
    }, watchIntervalMs);
    watchTimer.unref();

    let handshake = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
    // fork(TECH-8283 Finding 8): Forward array or string values for websocket response headers
    for (const name of ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      const value = response.headers[name];
      if (typeof value === "string") {
        handshake += `${name}: ${value}\r\n`;
      } else if (Array.isArray(value)) {
        handshake += `${name}: ${value.join(", ")}\r\n`;
      }
    }
    socket.write(handshake + "\r\n");
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);

    remote.on("error", () => cleanup());
    remote.once("close", () => cleanup());
    socket.pipe(remote).pipe(socket);
    remote.resume();
  });

  connection.end();
}
