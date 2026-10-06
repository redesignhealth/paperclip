import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface StatefulBoardOptions {
  adminToken?: string;
  toolOutcome?:
    | { kind: "success"; boardAgentId?: string }
    | { kind: "tool_error"; text: string }
    | { kind: "http_status"; status: number }
    | { kind: "oversized" }
    | { kind: "delay"; ms: number }
    | { kind: "mismatched_sub"; sub: string }
    | { kind: "invalid_uuid" };
  handshakeOutcome?:
    | { kind: "http_status"; status: number }
    | { kind: "delay"; ms: number }
    | { kind: "oversized" };
  notificationsOutcome?:
    | { kind: "http_status"; status: number };
  deleteOutcome?:
    | { kind: "delay"; ms: number };
}

export interface StatefulBoardServer {
  url: string;
  adminToken: string;
  events: Array<{ type: string; headers: Record<string, string>; body?: unknown }>;
  sessions: Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport }>;
  close: () => Promise<void>;
}

export async function startStatefulMcpBoard(options: StatefulBoardOptions = {}): Promise<StatefulBoardServer> {
  const adminToken = options.adminToken ?? "test-board-admin-secret-token";
  const events: Array<{ type: string; headers: Record<string, string>; body?: unknown }> = [];
  const sessions = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport }>();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (typeof val === "string") rawHeaders[key.toLowerCase()] = val;
      else if (Array.isArray(val)) rawHeaders[key.toLowerCase()] = val.join(", ");
    }

    const auth = rawHeaders["authorization"];
    if (options.adminToken && auth !== `Bearer ${options.adminToken}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = rawHeaders["mcp-session-id"];

    // DELETE request
    if (req.method === "DELETE") {
      events.push({ type: "delete", headers: rawHeaders });
      if (options.deleteOutcome?.kind === "delay") {
        await new Promise((r) => setTimeout(r, options.deleteOutcome!.ms));
      }
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Session not found");
        return;
      }
      const s = sessions.get(sessionId)!;
      sessions.delete(sessionId);
      await s.transport.close();
      res.writeHead(200, { "content-type": "text/plain" }).end("OK");
      return;
    }

    // Read POST body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Handshake override
    if (parsed?.method === "initialize" && options.handshakeOutcome) {
      events.push({ type: "initialize", headers: rawHeaders, body: parsed });
      if (options.handshakeOutcome.kind === "http_status") {
        res.writeHead(options.handshakeOutcome.status, { "content-type": "application/json" }).end(JSON.stringify({ error: "Handshake failed" }));
        return;
      }
      if (options.handshakeOutcome.kind === "delay") {
        await new Promise((r) => setTimeout(r, options.handshakeOutcome!.delay as unknown as number ?? 50));
      }
      if (options.handshakeOutcome.kind === "oversized") {
        const big = "x".repeat(1_050_000);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { big } }));
        return;
      }
    }

    // Initialize request
    if (parsed?.method === "initialize") {
      events.push({ type: "initialize", headers: rawHeaders, body: parsed });
      const mcp = new McpServer({ name: "stateful-board", version: "1.0.0" });
      mcp.tool(
        "comms_admin_register",
        {
          sub: z.string(),
          owner_sub: z.string().optional(),
          owner_email: z.string().optional(),
          display_name: z.string().optional(),
          is_shared: z.boolean().optional(),
        },
        async (args) => {
          events.push({ type: "tools/call", headers: rawHeaders, body: args });

          if (options.toolOutcome?.kind === "tool_error") {
            return {
              isError: true,
              content: [{ type: "text", text: options.toolOutcome.text }],
            };
          }
          if (options.toolOutcome?.kind === "mismatched_sub") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  agent_id: randomUUID(),
                  sub: options.toolOutcome.sub,
                  display_name: args.display_name ?? "Agent",
                }),
              }],
            };
          }
          if (options.toolOutcome?.kind === "invalid_uuid") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  agent_id: "not-a-valid-uuid",
                  sub: args.sub,
                  display_name: args.display_name ?? "Agent",
                }),
              }],
            };
          }

          const boardAgentId = options.toolOutcome?.kind === "success" && options.toolOutcome.boardAgentId
            ? options.toolOutcome.boardAgentId
            : randomUUID();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                agent_id: boardAgentId,
                sub: args.sub,
                display_name: args.display_name ?? "Agent",
                status: "active",
                is_shared: false,
              }),
            }],
          };
        },
      );

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { mcp, transport });
      }
      return;
    }

    // Notification: initialized
    if (parsed?.method === "notifications/initialized") {
      events.push({ type: "initialized", headers: rawHeaders, body: parsed });
      if (options.notificationsOutcome?.kind === "http_status") {
        res.writeHead(options.notificationsOutcome.status, { "content-type": "application/json" }).end(JSON.stringify({ error: "Notification failed" }));
        return;
      }
      if (sessionId && sessions.has(sessionId)) {
        const s = sessions.get(sessionId)!;
        await s.transport.handleRequest(req, res, parsed);
        return;
      }
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Missing session" }));
      return;
    }

    // Tools call with override or session
    if (parsed?.method === "tools/call") {
      if (options.toolOutcome?.kind === "http_status") {
        events.push({ type: "tools/call", headers: rawHeaders, body: parsed });
        res.writeHead(options.toolOutcome.status, { "content-type": "application/json" }).end(JSON.stringify({ error: "HTTP error" }));
        return;
      }
      if (options.toolOutcome?.kind === "oversized") {
        events.push({ type: "tools/call", headers: rawHeaders, body: parsed });
        const big = "x".repeat(1_050_000);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: big }] } }));
        return;
      }
      if (options.toolOutcome?.kind === "delay") {
        await new Promise((r) => setTimeout(r, options.toolOutcome!.delay as unknown as number ?? 50));
      }

      if (!sessionId || !sessions.has(sessionId)) {
        events.push({ type: "tools/call_rejected_no_session", headers: rawHeaders, body: parsed });
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "MissingSessionId" }));
        return;
      }
      const s = sessions.get(sessionId)!;
      await s.transport.handleRequest(req, res, parsed);
      return;
    }

    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId)!;
      await s.transport.handleRequest(req, res, parsed);
      return;
    }

    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Missing or invalid session" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;

  const close = async () => {
    for (const s of sessions.values()) {
      try {
        await s.transport.close();
      } catch {}
    }
    sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, adminToken, events, sessions, close };
}
