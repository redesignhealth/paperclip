import { createServer, type IncomingMessage, type RequestListener, type ServerOptions } from "node:http";
import type { Socket } from "node:net";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";
import { setupRunnerPrpWebSocketServer } from "../realtime/runner-prp-ws.js";

/** Create the HTTP listener used by both production and custom launchers. */
export function createPaperclipHttpServer(
  listener: RequestListener,
  options: { apiUrl: string; httpOptions?: ServerOptions },
) {
  const server = createServer(options.httpOptions ?? {}, listener);
  // Native execution uses the listener even when a launcher has no browser
  // realtime connection. Register it before any run can be admitted.
  setupRunnerPrpWebSocketServer(server, { apiUrl: options.apiUrl });
  setupPluginApiWebSocketServer(server, listener);
  // fork(TECH-8283 F7): Terminal fallback upgrade listener that destroys unhandled upgrades
  server.on("upgrade", (request: IncomingMessage & { paperclipWebSocketHandled?: boolean }, socket: Socket) => {
    if (request.paperclipWebSocketHandled) return;
    socket.destroy();
  });
  return server;
}
