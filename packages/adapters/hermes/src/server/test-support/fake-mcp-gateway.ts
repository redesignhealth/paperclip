import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeGatewayOptions {
  token?: string;
  tools?: string[];
  pages?: string[][];
  hangOn?: "initialize" | "tools/list";
  failListWith?: number;
  jsonRpcListError?: number;
  rejectAllWith?: number;
  redirectTo?: string;
  /** Protocol-violating tools/list answers: a non-array `tools`, or a nextCursor that never advances. */
  malformedList?: "tools_not_array" | "repeat_cursor";
}

const servers: http.Server[] = [];


/** Minimal JSON-RPC-over-POST MCP gateway, mirroring server/src/routes/tool-gateway.ts responses. */
export async function startFakeGateway(
  options: FakeGatewayOptions = {},
): Promise<{ url: string; requests: string[]; authorizations: string[]; incoming: string[] }> {
  const requests: string[] = [];
  /** Every request that reaches this server (method + path), recorded before any branching. */
  const incoming: string[] = [];
  const authorizations: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      incoming.push(`${req.method} ${req.url}`);
      if (typeof req.headers.authorization === "string") authorizations.push(req.headers.authorization);
      if (options.redirectTo) {
        res.writeHead(302, { location: options.redirectTo }).end();
        return;
      }
      if (req.method === "GET") {
        // Real gateway (server/src/routes/tool-gateway.ts) answers GET with 200 JSON, not 405/SSE.
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (options.rejectAllWith) {
        res.writeHead(options.rejectAllWith, { "content-type": "application/json" }).end('{"error":"nope"}');
        return;
      }
      if (req.headers.authorization !== `Bearer ${options.token ?? "good-token"}`) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Bearer token is required"}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        id?: unknown;
        method?: string;
        params?: { cursor?: string };
      };
      requests.push(body.method ?? "");
      if (options.hangOn === body.method) return;
      const json = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }));
      if (body.method === "initialize") {
        json({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-gateway", version: "1.0.0" },
        });
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/list") {
        if (options.jsonRpcListError) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: options.jsonRpcListError, message: "x" } }));
          return;
        }
        if (options.failListWith) {
          res.writeHead(options.failListWith, { "content-type": "application/json" }).end('{"error":"boom"}');
          return;
        }
        if (options.malformedList === "tools_not_array") {
          json({ tools: "not-an-array" });
          return;
        }
        if (options.malformedList === "repeat_cursor") {
          json({
            tools: (options.tools ?? []).map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
            nextCursor: "same-cursor",
          });
          return;
        }
        const pages = options.pages ?? [options.tools ?? []];
        const index = body.params?.cursor ? Number(body.params.cursor) : 0;
        json({
          tools: (pages[index] ?? []).map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
          ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
        });
        return;
      }
      res.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests, authorizations, incoming };
}


export async function stopFakeGateways(): Promise<void> {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }),
  );
}

/** Stops a single gateway early (to simulate an unreachable server). */
export async function stopFakeGateway(url: string): Promise<void> {
  const port = Number(new URL(url).port);
  const index = servers.findIndex((s) => (s.address() as AddressInfo | null)?.port === port);
  if (index < 0) return;
  const [server] = servers.splice(index, 1);
  server!.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
}
