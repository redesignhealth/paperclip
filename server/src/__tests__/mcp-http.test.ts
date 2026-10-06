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
  readMcpHttpResponseText,
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

  describe("strict cleanup and session-id contract", () => {
    const SID = "sess-cleanup";

    /** A send double that answers DELETE and records every dispatch. */
    function cleanupSend(initializeResponse: () => Response) {
      return vi.fn(async (init: RequestInit): Promise<Response> => {
        if (init.method === "DELETE") return new Response(null, { status: 200 });
        return initializeResponse();
      });
    }

    /** The shared post-conditions: typed error, exactly one cleanup DELETE, no notify. */
    async function expectOneCleanupDelete(
      send: ReturnType<typeof cleanupSend>,
      rejection: Promise<Record<string, string>>,
      message: string,
    ) {
      await expect(rejection).rejects.toThrow(McpHttpInitializationError);
      await expect(rejection).rejects.toThrow(message);
      // Exactly two dispatches: initialize + the cleanup DELETE. The
      // notifications/initialized POST never happened.
      expect(send).toHaveBeenCalledTimes(2);
      const deleteInit = send.mock.calls[1]![0];
      expect(deleteInit.method).toBe("DELETE");
      const deleteHeaders = deleteInit.headers as Record<string, string>;
      expect(deleteHeaders["Mcp-Session-Id"]).toBe(SID);
      expect(deleteInit.signal).toBeInstanceOf(AbortSignal);
      // The DELETE never carries a content-type (case-insensitive strip).
      expect(
        Object.keys(deleteHeaders).some((key) => key.toLowerCase() === "content-type"),
      ).toBe(false);
    }

    it.each([
      [
        "mismatched request id",
        () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "other-id", result: { protocolVersion: MCP_PROTOCOL_VERSION } }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": SID } },
          ),
        "invalid response",
      ],
      [
        "unsupported protocol version",
        () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "req-cleanup-initialize", result: { protocolVersion: "1999-01-01" } }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": SID } },
          ),
        "unsupported protocol version",
      ],
      [
        "JSON-RPC error envelope",
        () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "req-cleanup-initialize", error: { code: -32603, message: "boom" } }),
            { status: 200, headers: { "content-type": "application/json", "mcp-session-id": SID } },
          ),
        "returned error",
      ],
    ])(
      "strict initialize failing after a valid session id (%s) throws typed and sends exactly one cleanup DELETE",
      async (_label, initializeResponse, message) => {
        const send = cleanupSend(initializeResponse);
        await expectOneCleanupDelete(
          send,
          initializeMcpHttpSession({
            requestId: "req-cleanup",
            strict: true,
            headers: { "Content-Type": "application/json", authorization: "Bearer x" },
            send,
          }),
          message,
        );
      },
    );

    it("strict initialize read error after a valid session id throws typed and sends exactly one cleanup DELETE", async () => {
      const send = cleanupSend(() => {
        const envelope = JSON.stringify({
          jsonrpc: "2.0",
          id: "req-cleanup-initialize",
          result: { protocolVersion: MCP_PROTOCOL_VERSION },
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(envelope));
            controller.error(new Error("read boom"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": SID },
        });
      });
      await expectOneCleanupDelete(
        send,
        initializeMcpHttpSession({ requestId: "req-cleanup", strict: true, send }),
        "invalid response",
      );
    });

    it("strict initialize with Content-Length over the cap cancels the body without reading and sends exactly one cleanup DELETE", async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
        },
        cancel() {
          cancelled = true;
        },
      });
      const send = cleanupSend(
        () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "2000", "mcp-session-id": SID },
          }),
      );
      await expectOneCleanupDelete(
        send,
        initializeMcpHttpSession({ requestId: "req-cleanup", strict: true, maxResponseBytes: 1000, send }),
        "exceeded maximum size",
      );
      // The body was canceled up front, never read raw.
      expect(cancelled).toBe(true);
    });

    it("strict initialize with streamed chunks over the cap cancels the reader and sends exactly one cleanup DELETE", async () => {
      let cancelled = false;
      const chunk = new TextEncoder().encode("x".repeat(600));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk); // 1200 streamed bytes > 1000 cap
        },
        cancel() {
          cancelled = true;
        },
      });
      const send = cleanupSend(
        () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": SID },
          }),
      );
      await expectOneCleanupDelete(
        send,
        initializeMcpHttpSession({ requestId: "req-cleanup", strict: true, maxResponseBytes: 1000, send }),
        "exceeded maximum size",
      );
      expect(cancelled).toBe(true);
    });

    it("invalid (non-visible-ASCII) session id fails typed with no DELETE and no initialized notification", async () => {
      // Headers trims outer whitespace (an empty or spaces-only value reads back
      // as "" and is therefore treated as ABSENT, i.e. stateless, by the code),
      // so the typed-failure branch needs an invalid value that survives the
      // trim, such as an interior space.
      expect(
        new Response(null, { headers: { "mcp-session-id": "   " } }).headers.get("mcp-session-id"),
      ).toBe("");
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled = true;
        },
      });
      const send = vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "sess cleanup" },
          }),
      );
      let caught: unknown;
      try {
        await initializeMcpHttpSession({ requestId: "req", strict: true, send });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpHttpInitializationError);
      expect((caught as Error).message).toContain("invalid Mcp-Session-Id");
      // The invalid session id is never echoed: no notification, no DELETE.
      expect(send).toHaveBeenCalledTimes(1);
      expect(cancelled).toBe(true);
    });

    it("empty session id is treated as absent: registration succeeds stateless with no session id echoed and no DELETE", async () => {
      const notifyResponse = new Response("accepted", { status: 202 });
      const send = vi.fn(
        async (init: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init.body)) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: MCP_PROTOCOL_VERSION },
              }),
              { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "" } },
            );
          }
          return notifyResponse;
        },
      );
      const sessionHeaders = await initializeMcpHttpSession({
        requestId: "req",
        strict: true,
        send,
      });
      expect(sessionHeaders["Mcp-Session-Id"]).toBeUndefined();
      expect(sessionHeaders["MCP-Protocol-Version"]).toBe(MCP_PROTOCOL_VERSION);
      // initialize + notification only; nothing to terminate without a session id.
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.every(([init]) => init.method !== "DELETE")).toBe(true);
      expect(notifyResponse.bodyUsed).toBe(true);
    });

    it("strict success without any session id stays stateless with no DELETE", async () => {
      const send = vi.fn(
        async (init: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init.body)) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2025-06-18" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(null, { status: 202 });
        },
      );
      const sessionHeaders = await initializeMcpHttpSession({
        requestId: "req",
        strict: true,
        send,
      });
      expect(sessionHeaders["Mcp-Session-Id"]).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2); // initialize + notification, no DELETE
    });

    it("non-strict failed notification with a session id throws typed, cancels the body, and never sends DELETE", async () => {
      const notifyResponse = new Response("notify failed", { status: 500 });
      const send = vi.fn(
        async (init: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init.body)) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2025-06-18" },
              }),
              { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-nonstrict" } },
            );
          }
          return notifyResponse;
        },
      );
      let caught: unknown;
      try {
        await initializeMcpHttpSession({ requestId: "req", strict: false, send });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpHttpInitializationError);
      expect((caught as McpHttpInitializationError).stage).toBe("initialized_notification");
      // Non-strict preserves master behavior: no cleanup DELETE.
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.every(([init]) => init.method !== "DELETE")).toBe(true);
      expect(notifyResponse.bodyUsed).toBe(true);
    });
  });

  describe("terminateMcpHttpSession", () => {
    it("sends DELETE with session headers and handles 200 OK", async () => {
      const send = vi.fn(async (_init: RequestInit) => new Response("OK", { status: 200 }));
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
      const send405 = vi.fn(async (_init: RequestInit) => new Response("Method not allowed", { status: 405 }));
      await expect(
        terminateMcpHttpSession({ send: send405, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();

      const send404 = vi.fn(async (_init: RequestInit) => new Response("Not found", { status: 404 }));
      await expect(
        terminateMcpHttpSession({ send: send404, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();
    });

    it("swallows network/fetch errors without throwing", async () => {
      const sendErr = vi.fn(async (_init: RequestInit): Promise<Response> => {
        throw new Error("Network offline");
      });
      await expect(
        terminateMcpHttpSession({ send: sendErr, headers: { "Mcp-Session-Id": "sess-term" } }),
      ).resolves.toBeUndefined();
    });

    it("skips the DELETE entirely when no Mcp-Session-Id header is present", async () => {
      const send = vi.fn(async (_init: RequestInit) => new Response(null, { status: 200 }));
      await terminateMcpHttpSession({
        send,
        headers: { authorization: "Bearer tok" },
      });
      // An empty session id value is equally session-less: nothing to terminate.
      await terminateMcpHttpSession({
        send,
        headers: { "Mcp-Session-Id": "", authorization: "Bearer tok" },
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("finds the session id case-insensitively and strips content-type from the DELETE", async () => {
      const deleteResponse = new Response("OK", { status: 200 });
      const send = vi.fn(async (_init: RequestInit) => deleteResponse);
      await terminateMcpHttpSession({
        send,
        headers: {
          "MCP-SESSION-ID": "sess-case",
          "Content-Type": "application/json",
          authorization: "Bearer tok",
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]![0];
      expect(call.method).toBe("DELETE");
      const headers = call.headers as Record<string, string>;
      expect(headers["MCP-SESSION-ID"]).toBe("sess-case");
      expect(headers.authorization).toBe("Bearer tok");
      expect(headers.accept).toBe(MCP_HTTP_ACCEPT);
      expect(
        Object.keys(headers).some((key) => key.toLowerCase() === "content-type"),
      ).toBe(false);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      // The DELETE response body is canceled, never left dangling.
      expect(deleteResponse.bodyUsed).toBe(true);
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

describe("readMcpHttpResponseText", () => {
  it("returns null early and cancels body if Content-Length exceeds maxBytes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-length": "2000" },
    });
    const result = await readMcpHttpResponseText(response, 1000);
    expect(result).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("reads small response text completely", async () => {
    const response = new Response("hello world", {
      headers: { "content-length": "11" },
    });
    const result = await readMcpHttpResponseText(response, 1000);
    expect(result).toBe("hello world");
  });

  it("returns null and cancels reader when chunked stream exceeds maxBytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);
    const result = await readMcpHttpResponseText(response, 8); // max 8 bytes, total 10 bytes
    expect(result).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("correctly decodes multibyte UTF-8 characters split across chunks", async () => {
    // Euro symbol '€' in UTF-8 is 3 bytes: 0xE2, 0x82, 0xAC
    const chunk1 = new Uint8Array([0xe2, 0x82]);
    const chunk2 = new Uint8Array([0xac]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    const response = new Response(stream);
    const result = await readMcpHttpResponseText(response, 100);
    expect(result).toBe("€");
  });

  it("returns empty string when body is null", async () => {
    const response = new Response(null);
    const result = await readMcpHttpResponseText(response, 100);
    expect(result).toBe("");
  });

  it("propagates read errors to the caller and releases the reader lock", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("read boom"));
      },
    });
    const response = new Response(stream);
    // Read errors propagate (never swallowed into null), per the contract.
    await expect(readMcpHttpResponseText(response, 100)).rejects.toThrow("read boom");
    // The finally released the lock: a fresh reader can be acquired on the same
    // body (without releaseLock this throws "ReadableStream is locked").
    expect(() => response.body!.getReader()).not.toThrow();
  });
});
