import { ServerResponse, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { Request, Response } from "express";
import {
  validateAndResolveFetchUrl,
  type ValidatedFetchTarget,
  type GuardedRemoteHttpFetchOptions,
} from "../services/plugin-egress-guard.js";

export const pluginApiUpgrade = Symbol("pluginApiUpgrade");
type UpgradeRequest = IncomingMessage & {
  paperclipWebSocketHandled?: boolean;
  [pluginApiUpgrade]?: { socket: Socket; head: Buffer };
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

/** Reuse the full HTTP authentication/company pipeline for plugin upgrades. */
export function setupPluginApiWebSocketServer(server: Server, handler: RequestListener) {
  server.on("upgrade", (request: UpgradeRequest, socket: Socket, head: Buffer) => {
    if (request.paperclipWebSocketHandled || !/^\/api\/plugins\/[^/]+\/api\//.test(request.url ?? "")) return;
    request.paperclipWebSocketHandled = true;
    socket.on("error", () => socket.destroy());
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
      || request.headers["content-length"] || request.headers["transfer-encoding"]) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    request[pluginApiUpgrade] = { socket, head };
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    response.setHeader("Connection", "close");
    response.once("finish", () => socket.end());
    handler(request, response);
  });
}

// fork(TECH-8283 F4): Replace worker->upstream header deny-regex with strict allowlist
// Only authorization, user-agent, and x-* (excluding x-forwarded-*) are allowed.
export function isAllowedWorkerUpstreamHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "user-agent") return true;
  if (lower.startsWith("x-") && !lower.startsWith("x-forwarded-")) return true;
  return false;
}

/** Only worker-selected WSS targets and credentials reach the upstream. */
export async function proxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => boolean | Promise<boolean>,
  options?: GuardedRemoteHttpFetchOptions,
) {
  const upgrade = (req as UpgradeRequest)[pluginApiUpgrade];
  if (!upgrade || upgrade.socket.destroyed) return;
  const { socket, head } = upgrade;
  let url: URL;
  let resolvedTarget: ValidatedFetchTarget;
  try {
    url = new URL(target.url);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) throw new Error();
    for (const [name, value] of Object.entries(target.headers ?? {})) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      // fork(TECH-8283 F4): Reject any header not in the strict allowlist (502, nothing written upstream)
      if (!isAllowedWorkerUpstreamHeader(name)) throw new Error(`Disallowed upstream header: ${name}`);
    }
    // fork(TECH-8283 F1): Validate URL through egress guard and pin DNS resolution
    resolvedTarget = await validateAndResolveFetchUrl(target.url, {
      ...options,
      allowedProtocols: new Set(["wss:"]),
    });
  } catch {
    res.status(502).json({ error: "Plugin connection unavailable" });
    return;
  }
  const headers: Record<string, string | string[]> = { ...target.headers, Connection: "Upgrade", Upgrade: "websocket" };
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    if (req.headers[name]) headers[name] = req.headers[name]!;
  }
  let connected = false;
  let upstream: Duplex | undefined;
  const fail = () => {
    if (!connected && !socket.destroyed && !res.headersSent) res.status(502).json({ error: "Plugin connection unavailable" });
    else socket.destroy();
  };
  let connection: ReturnType<typeof httpsRequest>;
  // fork(TECH-8283 F1): Dial resolved address via options object with TLS servername and explicit Host header so it never re-resolves
  const port = resolvedTarget.parsedUrl.port ? Number(resolvedTarget.parsedUrl.port) : 443;
  const path = `${resolvedTarget.parsedUrl.pathname}${resolvedTarget.parsedUrl.search}`;
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
    timeout: 15_000,
  };
  try { connection = httpsRequest(requestOptions); }
  catch { fail(); return; }
  const cleanup = () => {
    clearInterval(watch);
    clearTimeout(lifetime);
    clearTimeout(handshakeTimer);
    connection.destroy();
    upstream?.destroy();
  };
  // Periodic reconnect reauthorizes the browser through HTTP; it also bounds
  // how long a removed membership or changed plugin binding can retain access.
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
  // fork(TECH-8283 F6): Handshake deadline ~20s from upgrade accept until 101 Switching Protocols
  const handshakeDeadlineMs = options?.handshakeDeadlineMs ?? 20_000;
  const handshakeTimer = setTimeout(() => {
    if (!connected) {
      fail();
    }
  }, handshakeDeadlineMs);
  lifetime.unref();
  watch.unref();
  handshakeTimer.unref();
  socket.once("close", cleanup);
  connection.on("timeout", () => { connection.destroy(); fail(); });
  connection.on("error", fail);
  connection.on("response", response => { response.destroy(); fail(); });
  connection.on("upgrade", (response, remote, remoteHead) => {
    upstream = remote;
    if (socket.destroyed || !available() || response.statusCode !== 101) { remote.destroy(); fail(); return; }
    connected = true;
    clearTimeout(handshakeTimer);
    connection.setTimeout(0);
    socket.setTimeout(0);
    res.detachSocket(socket);
    // Express request accounting must observe the lifetime of the upgraded stream.
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
  });
  connection.end();
}
