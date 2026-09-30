import { describe, expect, it } from "vitest";
import {
  initializeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  buildMcpToolCallRequest,
  extractMcpToolCallResult,
  mcpHttpRequestHeaders,
  normalizeMcpToolContent,
  parseMcpHttpResponseBody,
} from "../services/mcp-http.js";

describe("mcpHttpRequestHeaders", () => {
  it("advertises both JSON and SSE on every request", () => {
    expect(mcpHttpRequestHeaders()).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(MCP_HTTP_ACCEPT).toBe("application/json, text/event-stream");
  });

  it("preserves caller-supplied headers while keeping the required Accept value", () => {
    expect(mcpHttpRequestHeaders({ Authorization: "Bearer x", accept: "application/json" })).toMatchObject({
      accept: "application/json, text/event-stream",
      Authorization: "Bearer x",
    });
  });
});

describe("initializeMcpHttpSession", () => {
  it("returns the negotiated protocol and ephemeral session headers", async () => {
    const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
    const sessionHeaders = await initializeMcpHttpSession({
      requestId: "test-request",
      headers: { Authorization: "Bearer token" },
      send: async (init) => {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ headers: new Headers(init.headers), payload });
        if (payload.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "stateful-test", version: "1" },
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-123" },
          });
        }
        return new Response(null, { status: 202 });
      },
    });

    expect(requests.map(({ payload }) => payload.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[1]!.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[1]!.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(sessionHeaders).toMatchObject({
      Authorization: "Bearer token",
      "Mcp-Session-Id": "session-123",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
  });
});

describe("parseMcpHttpResponseBody", () => {
  it("parses a plain application/json body", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [] } };
    expect(parseMcpHttpResponseBody(JSON.stringify(payload), "application/json")).toEqual(payload);
  });

  it("parses an SSE-framed body, extracting the JSON-RPC message", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [{ name: "kv_get" }] } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream; charset=utf-8")).toEqual(payload);
  });

  it("skips non-JSON-RPC SSE events and returns the response message", () => {
    const ping = "event: ping\ndata: {\"type\":\"ping\"}";
    const message = { jsonrpc: "2.0", id: "1", result: { ok: true } };
    const body = `${ping}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(message);
  });

  it("handles multi-line SSE data fields", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { note: "line" } };
    const json = JSON.stringify(payload, null, 2);
    const body = `data: ${json.split("\n").join("\ndata: ")}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(payload);
  });

  it("throws when an SSE stream carries no data events", () => {
    expect(() => parseMcpHttpResponseBody("event: ping\n\n", "text/event-stream")).toThrow();
  });
});

// buildMcpToolCallRequest/normalizeMcpToolContent/extractMcpToolCallResult are
// the shared MCP JSON-RPC `tools/call` request-building and result-extraction
// helpers used by both tool-gateway.ts's `executeRemoteHttpTool` (ordinary
// gateway tool calls) and tool-access.ts's `mcp_tool` connection-token-broker
// exchange protocol -- there is a single implementation, exercised here and
// indirectly by both callers' own test suites.
describe("buildMcpToolCallRequest", () => {
  it("builds a tools/call JSON-RPC 2.0 envelope", () => {
    expect(buildMcpToolCallRequest("req-1", "mint_token_for_subject", { bearer_token: "x" })).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      method: "tools/call",
      params: { name: "mint_token_for_subject", arguments: { bearer_token: "x" } },
    });
  });

  it("defaults missing/nullish arguments to an empty object", () => {
    expect(buildMcpToolCallRequest("req-2", "some_tool", undefined)).toMatchObject({
      params: { name: "some_tool", arguments: {} },
    });
  });
});

describe("normalizeMcpToolContent", () => {
  it("concatenates text parts and stringifies non-text parts", () => {
    expect(normalizeMcpToolContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(normalizeMcpToolContent([{ type: "image", data: "base64" }])).toBe(JSON.stringify({ type: "image", data: "base64" }));
  });

  it("returns null for malformed content shapes instead of throwing", () => {
    expect(normalizeMcpToolContent("not-an-array")).toBeNull();
    expect(normalizeMcpToolContent([{ type: "text" }])).toBeNull();
    expect(normalizeMcpToolContent([{ noType: true }])).toBeNull();
  });
});

describe("extractMcpToolCallResult", () => {
  it("extracts content, structuredContent, and isError from a tools/call result", () => {
    expect(extractMcpToolCallResult({
      content: [{ type: "text", text: "minted" }],
      structuredContent: { token: "abc" },
      isError: false,
    })).toEqual({ content: "minted", structuredContent: { token: "abc" }, isError: false });
  });

  it("defaults structuredContent to null and isError to false when absent", () => {
    expect(extractMcpToolCallResult({ content: [{ type: "text", text: "ok" }] })).toEqual({
      content: "ok",
      structuredContent: null,
      isError: false,
    });
  });

  it("returns null when the result is not an object or content is malformed", () => {
    expect(extractMcpToolCallResult(null)).toBeNull();
    expect(extractMcpToolCallResult("nope")).toBeNull();
    expect(extractMcpToolCallResult({ content: "not-an-array" })).toBeNull();
  });
});
