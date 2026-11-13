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
  type GuardedRemoteHttpFetchOptions,
} from "../services/plugin-egress-guard.js";

export const PLUGIN_WS_UPGRADE_DEADLINE_MS = 20_000;

export const pluginApiUpgrade = Symbol("pluginApiUpgrade");

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

// fork(TECH-8283 F4): Replace worker->upstream header deny-regex with strict allowlist
export function isAllowedWorkerUpstreamHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "user-agent") return true;
  if (lower.startsWith("x-") && !lower.startsWith("x-forwarded-")) return true;
  return false;
}

/** Reuse the full HTTP authentication/company pipeline for plugin upgrades. */
export function setupPluginApiWebSocketServer(
  server: Server,
  handler: RequestListener,
  wsOptions?: GuardedRemoteHttpFetchOptions,
) {
  server.on("upgrade", (request: UpgradeRequest, socket: Socket, head: Buffer) => {
    if (request.paperclipWebSocketHandled || !/^\/api\/plugins\/[^/]+\/api\//.test(request.url ?? "")) return;
    request.paperclipWebSocketHandled = true;

    // fork(TECH-8283 Finding B): One absolute deadline armed at browser upgrade acceptance
    const deadlineMs = wsOptions?.upgradeDeadlineMs ?? PLUGIN_WS_UPGRADE_DEADLINE_MS;
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

    const deadlineTimer = setTimeout(() => {
      if (settle("timeout")) {
        if (!socket.destroyed) {
          if (!response.headersSent) {
            response.writeHead(504, { "Content-Type": "application/json", Connection: "close" });
            response.end(JSON.stringify({ error: "Plugin upgrade timed out" }));
          } else {
            socket.destroy();
          }
        }
      }
    }, deadlineMs);
    deadlineTimer.unref();

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

/** Only worker-selected WSS targets and credentials reach the upstream. */
export async function proxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => Promise<boolean>,
  options?: GuardedRemoteHttpFetchOptions,
) {
  const upgrade = (req as UpgradeRequest)[pluginApiUpgrade];
  if (!upgrade || upgrade.socket.destroyed) return;
  const { socket, head } = upgrade;

  // fork(TECH-8283 Finding B): Check remaining deadline time
  const remainingMs = Math.max(0, upgrade.deadlineAt - Date.now());
  if (remainingMs <= 0 || upgrade.signal.aborted) {
    if (upgrade.settle("timeout")) {
      if (!socket.destroyed && !res.headersSent) {
        res.status(504).json({ error: "Plugin upgrade timed out" });
      } else {
        socket.destroy();
      }
    }
    return;
  }

  let url: URL;
  let resolvedTarget: ValidatedFetchTarget;
  try {
    url = new URL(target.url);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) throw new Error();
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      // fork(TECH-8283 F4): Reject any header not in the strict allowlist
      if (!isAllowedWorkerUpstreamHeader(name)) throw new Error(`Disallowed upstream header: ${name}`);
    }
    // fork(TECH-8283 F1, Finding A): Strict canonical IP classification for WebSocket egress
    resolvedTarget = await validateAndResolveFetchUrl(target.url, {
      ...options,
      allowedProtocols: new Set(["wss:"]),
      isPrivate: isPrivateOrDeniedWsIP,
      dnsTimeoutMs: Math.min(5_000, remainingMs),
    });
  } catch {
    const isTimeout = upgrade.signal.aborted || Date.now() >= upgrade.deadlineAt;
    const settleReason = isTimeout ? "timeout" : "error";
    if (upgrade.settle(settleReason)) {
      if (!socket.destroyed && !res.headersSent) {
        res.status(isTimeout ? 504 : 502).json({
          error: isTimeout ? "Plugin upgrade timed out" : "Plugin connection unavailable",
        });
      } else {
        socket.destroy();
      }
    }
    return;
  }

  const headers: Record<string, string | string[]> = { ...target.headers, Connection: "Upgrade", Upgrade: "websocket" };
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    if (req.headers[name]) headers[name] = req.headers[name]!;
  }

  let connected = false;
  let upstream: Duplex | undefined;

  const fail = (status = 502) => {
    if (upgrade.settle("error")) {
      if (!connected && !socket.destroyed && !res.headersSent) {
        res.status(status).json({ error: "Plugin connection unavailable" });
      } else {
        socket.destroy();
      }
    } else if (!connected && !socket.destroyed) {
      socket.destroy();
    }
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

  let connection: ReturnType<typeof httpsRequest>;
  try {
    connection = httpsRequest(requestOptions);
  } catch {
    fail();
    return;
  }

  // fork(TECH-8283 F6, Finding B): Handshake deadline clamped to remaining absolute deadline
  const handshakeDeadlineMs = Math.min(options?.handshakeDeadlineMs ?? 20_000, remainingMs);
  const handshakeTimer = setTimeout(() => {
    if (!connected) {
      fail();
    }
  }, handshakeDeadlineMs);
  handshakeTimer.unref();

  // fork(TECH-8283 F2): Shorten hard lifetime from 5 min to 90 s, re-check on tick
  const lifetimeMs = options?.lifetimeMs ?? 90_000;
  const watchIntervalMs = options?.watchIntervalMs ?? 5_000;
  const lifetime = setTimeout(() => socket.destroy(), lifetimeMs);
  const watch = setInterval(async () => {
    try {
      if (!(await available())) socket.destroy();
    } catch {
      socket.destroy();
    }
  }, watchIntervalMs);
  lifetime.unref();
  watch.unref();

  const cleanup = () => {
    clearInterval(watch);
    clearTimeout(lifetime);
    clearTimeout(handshakeTimer);
    connection.destroy();
    upstream?.destroy();
  };
  socket.once("close", cleanup);

  connection.on("timeout", () => {
    connection.destroy();
    fail();
  });
  connection.on("error", () => fail());
  connection.on("response", (response) => {
    response.destroy();
    fail();
  });

  // fork(TECH-8283 Finding C): Rewritten upgrade handler ordering
  // 1. Attach provisional error listener
  // 2. Pause remote stream
  // 3. Verify status 101
  // 4. Await available() authorization
  // 5. Settle single-winner
  // 6. Detach, write 101 to client, pipe, and resume
  connection.on("upgrade", async (response, remote, remoteHead) => {
    upstream = remote;
    remote.once("error", () => {
      remote.destroy();
      fail();
    });
    remote.pause();

    if (socket.destroyed || upgrade.signal.aborted || response.statusCode !== 101) {
      remote.destroy();
      fail();
      return;
    }

    let isAvail = false;
    try {
      isAvail = await available();
    } catch {
      isAvail = false;
    }

    if (!isAvail || socket.destroyed || upgrade.signal.aborted) {
      remote.destroy();
      fail();
      return;
    }

    if (!upgrade.settle("success")) {
      remote.destroy();
      fail();
      return;
    }

    connected = true;
    clearTimeout(handshakeTimer);
    connection.setTimeout(0);
    socket.setTimeout(0);
    res.detachSocket(socket);
    socket.once("close", () => res.emit("close"));

    let handshake = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
    for (const name of ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      const value = response.headers[name];
      if (typeof value === "string") handshake += `${name}: ${value}\r\n`;
    }
    socket.write(handshake + "\r\n");
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);

    remote.on("error", () => socket.destroy());
    remote.once("close", () => socket.destroy());
    socket.pipe(remote).pipe(socket);
    remote.resume();
  });

  connection.end();
}
