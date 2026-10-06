import { describe, expect, it, vi } from "vitest";
import {
  findJsonRpcResponse,
  initializeMcpHttpSession,
  terminateMcpHttpSession,
  McpHttpInitializationError,
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

  describe("strict initialization options", () => {
    it("rejects response when request id mismatches in strict mode", async () => {
      await expect(
        initializeMcpHttpSession({
          requestId: "req-1",
          strict: true,
          send: async () =>
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "other-id",
                result: { protocolVersion: MCP_PROTOCOL_VERSION },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        }),
      ).rejects.toThrow(McpHttpInitializationError);
    });

    it("rejects response carrying JSON-RPC error in strict mode", async () => {
      await expect(
        initializeMcpHttpSession({
          requestId: "req-1",
          strict: true,
          send: async (init) => {
            const body = JSON.parse(String(init.body));
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "Internal error" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      ).rejects.toThrow(McpHttpInitializationError);
    });

    it("rejects unsupported protocol version in strict mode", async () => {
      await expect(
        initializeMcpHttpSession({
          requestId: "req-1",
          strict: true,
          supportedVersions: ["2025-06-18", "2025-03-26"],
          send: async (init) => {
            const body = JSON.parse(String(init.body));
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "1999-01-01" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      ).rejects.toThrow(McpHttpInitializationError);
    });

    it("parses matching SSE event even when notifications precede it in strict mode", async () => {
      const sessionHeaders = await initializeMcpHttpSession({
        requestId: "req-1",
        strict: true,
        send: async (init) => {
          const body = JSON.parse(String(init.body));
          if (body.method === "initialize") {
            const events = [
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" })}\n\n`,
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } })}\n\n`,
            ].join("");
            return new Response(events, {
              status: 200,
              headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-sse" },
            });
          }
          return new Response(null, { status: 202 });
        },
      });
      expect(sessionHeaders["Mcp-Session-Id"]).toBe("sess-sse");
      expect(sessionHeaders["MCP-Protocol-Version"]).toBe("2025-06-18");
    });

    it("non-strict mode preserves previous permissive behavior", async () => {
      // In non-strict mode, id mismatch is ignored by parseMcpHttpResponseBody
      const sessionHeaders = await initializeMcpHttpSession({
        requestId: "req-nonstrict",
        strict: false,
        send: async (init) => {
          const body = JSON.parse(String(init.body));
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "mismatched-but-permissive",
                result: { protocolVersion: "2025-06-18" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(null, { status: 202 });
        },
      });
      expect(sessionHeaders["MCP-Protocol-Version"]).toBe("2025-06-18");
    });
  });

  describe("terminateMcpHttpSession", () => {
    it("sends DELETE with session headers and handles 200 OK", async () => {
      const send = vi.fn(async () => new Response("OK", { status: 200 }));
      await terminateMcpHttpSession({
        send,
        headers: { "Mcp-Session-Id": "sess-term", "Authorization": "Bearer tok" },
      });
      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]![0];
      expect(call.method).toBe("DELETE");
      expect((call.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-term");
    });

    it("swallows 405 Method Not Allowed and 404 Not Found without throwing", async () => {
      const send405 = vi.fn(async () => new Response("Method not allowed", { status: 405 }));
      await expect(
        terminateMcpHttpSession({ send: send405, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();

      const send404 = vi.fn(async () => new Response("Not found", { status: 404 }));
      await expect(
        terminateMcpHttpSession({ send: send404, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();
    });

    it("swallows network/fetch errors without throwing", async () => {
      const sendErr = vi.fn(async () => {
        throw new Error("Network offline");
      });
      await expect(
        terminateMcpHttpSession({ send: sendErr, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();
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

describe("findJsonRpcResponse exact typed ID matching", () => {
  it("strictly distinguishes numeric 1 from string '1' in plain JSON", () => {
    const jsonNum = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const jsonStr = JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } });

    // Numeric match succeeds; string match against numeric id fails
    expect(findJsonRpcResponse("application/json", jsonNum, 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(findJsonRpcResponse("application/json", jsonNum, "1")).toBeNull();

    // String match succeeds; numeric match against string id fails
    expect(findJsonRpcResponse("application/json", jsonStr, "1")).toEqual({ jsonrpc: "2.0", id: "1", result: { ok: true } });
    expect(findJsonRpcResponse("application/json", jsonStr, 1)).toBeNull();
  });

  it("strictly distinguishes numeric 1 from string '1' in SSE streams", () => {
    const sseNum = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`;
    const sseStr = `data: ${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } })}\n\n`;

    expect(findJsonRpcResponse("text/event-stream", sseNum, 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(findJsonRpcResponse("text/event-stream", sseNum, "1")).toBeNull();

    expect(findJsonRpcResponse("text/event-stream", sseStr, "1")).toEqual({ jsonrpc: "2.0", id: "1", result: { ok: true } });
    expect(findJsonRpcResponse("text/event-stream", sseStr, 1)).toBeNull();
  });

  it("requires result or error envelope in JSON branch", () => {
    const jsonNotification = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(findJsonRpcResponse("application/json", jsonNotification, 1)).toBeNull();
  });
});
