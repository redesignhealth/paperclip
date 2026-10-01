import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { preflightHermesMcpServers } from "./mcp-preflight.js";

interface FakeGatewayOptions {
  token?: string;
  tools?: string[];
  pages?: string[][];
  hangOn?: "initialize" | "tools/list";
  failListWith?: number;
  jsonRpcListError?: number;
  rejectAllWith?: number;
}

const servers: http.Server[] = [];

/** Minimal JSON-RPC-over-POST MCP gateway, mirroring server/src/routes/tool-gateway.ts responses. */
async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests };
}

function mcpServer(url: string, overrides: Partial<AdapterRuntimeMcpServer> = {}): AdapterRuntimeMcpServer {
  return {
    name: "Paperclip connections",
    url,
    token: "good-token",
    connectionId: "conn-1",
    allowedTools: ["connections_search", "connection_request"],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }),
  );
});

describe("preflightHermesMcpServers", () => {
  it("passes when auth, handshake and tools/list cover the full allowlist", async () => {
    const gw = await startFakeGateway({ tools: ["connections_search", "connection_request"] });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);

    expect(result).toEqual({
      ok: true,
      failures: [],
      servers: [{ serverKey: "paperclip_connections", listedToolCount: 2, unlistedByAllowlistCount: 0 }],
    });
    expect(gw.requests).toContain("initialize");
    expect(gw.requests).toContain("tools/list");
  });

  it("passes but counts gateway tools outside the allowlist (Hermes tools.include filters them)", async () => {
    const gw = await startFakeGateway({
      tools: ["connections_search", "connection_request", "paperclip_list_resources", "paperclip_read_resource"],
    });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);

    expect(result.ok).toBe(true);
    expect(result.servers[0]).toMatchObject({ listedToolCount: 4, unlistedByAllowlistCount: 2 });
  });

  it("follows tools/list pagination before judging the allowlist", async () => {
    const gw = await startFakeGateway({ pages: [["connections_search"], ["connection_request"]] });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);
    expect(result.ok).toBe(true);
    expect(result.servers[0]).toMatchObject({ listedToolCount: 2 });
  });

  it("fails closed when an allowlisted tool is not listed", async () => {
    const gw = await startFakeGateway({ tools: ["connections_search"] });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      {
        serverKey: "paperclip_connections",
        code: "missing_tools",
        missingTools: ["connection_request"],
        message: "MCP server 'paperclip_connections' does not list 1 allowlisted tool(s): connection_request",
      },
    ]);
  });

  it("fails closed when the server lists no tools at all", async () => {
    const gw = await startFakeGateway({ tools: [] });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ code: "missing_tools", missingTools: ["connections_search", "connection_request"] });
  });

  it("reports an unauthorized run credential without echoing the token or URL", async () => {
    const gw = await startFakeGateway({ token: "expected-token" });
    const result = await preflightHermesMcpServers(
      [mcpServer(`${gw.url}?api_key=url-secret`, { token: "wrong-token-secret" })],
      ["paperclip_connections"],
    );

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ serverKey: "paperclip_connections", code: "unauthorized" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("wrong-token-secret");
    expect(text).not.toContain("url-secret");
    expect(text).not.toContain("127.0.0.1");
  });

  it("classifies a tools/list server error as list_failed with the HTTP status only", async () => {
    const gw = await startFakeGateway({ failListWith: 500 });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ code: "list_failed" });
    expect(result.failures[0]!.message).not.toContain("boom");
  });

  it("does not treat a JSON-RPC error code in the response body as an HTTP status", async () => {
    const gw = await startFakeGateway({ tools: [], jsonRpcListError: 401 });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"]);
    expect(result.failures[0]).toMatchObject({ code: "list_failed" });
    expect(result.failures[0]!.message).not.toContain("401");
  });

  it("classifies an unreachable server as connect_failed without leaking the URL", async () => {
    const gw = await startFakeGateway();
    const deadUrl = gw.url.replace("/mcp", "/mcp?token=url-secret");
    const [only] = servers;
    await new Promise<void>((resolve) => only!.close(() => resolve()));
    servers.length = 0;

    const result = await preflightHermesMcpServers([mcpServer(deadUrl)], ["paperclip_connections"], { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ code: "connect_failed" });
    expect(JSON.stringify(result)).not.toContain("url-secret");
  });

  it("times out a server that never answers initialize", async () => {
    const gw = await startFakeGateway({ hangOn: "initialize" });
    const started = Date.now();
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"], { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ code: "timeout" });
    expect(result.failures[0]!.message).toContain("initialize");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("times out a server that never answers tools/list", async () => {
    const gw = await startFakeGateway({ hangOn: "tools/list" });
    const result = await preflightHermesMcpServers([mcpServer(gw.url)], ["paperclip_connections"], { timeoutMs: 300 });
    expect(result.failures[0]).toMatchObject({ code: "timeout" });
    expect(result.failures[0]!.message).toContain("tools/list");
  });

  it("checks every server and reports failures per server key while passing healthy ones", async () => {
    const good = await startFakeGateway({ tools: ["connections_search", "connection_request"] });
    const bad = await startFakeGateway({ tools: [] });
    const result = await preflightHermesMcpServers(
      [mcpServer(good.url), mcpServer(bad.url, { name: "Second", connectionId: "conn-2" })],
      ["paperclip_connections", "second"],
    );

    expect(result.ok).toBe(false);
    expect(result.servers.map((s) => s.serverKey)).toEqual(["paperclip_connections"]);
    expect(result.failures.map((f) => f.serverKey)).toEqual(["second"]);
  });

  it("rejects mismatched server/key arrays instead of guessing", async () => {
    await expect(preflightHermesMcpServers([mcpServer("http://127.0.0.1:1/mcp")], [])).rejects.toThrow(
      /one server key per runtime MCP server/,
    );
  });
});
