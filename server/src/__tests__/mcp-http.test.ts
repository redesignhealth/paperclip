import { describe, expect, it } from "vitest";
import {
  MCP_HTTP_ACCEPT,
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
