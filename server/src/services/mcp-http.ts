// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}

/**
 * Build the JSON-RPC 2.0 envelope for an MCP `tools/call` request. This is
 * the single place that shapes an MCP tool invocation; every caller that
 * needs to invoke a remote MCP tool over Streamable HTTP (the ordinary
 * gateway tool-call path in `tool-gateway.ts`'s `executeRemoteHttpTool`, and
 * the `mcp_tool` connection-token-broker exchange protocol in
 * `tool-access.ts`'s `mintExchangeConnectionToken`) should build its request
 * body from this function rather than hand-rolling the envelope again.
 */
export function buildMcpToolCallRequest(id: string, toolName: string, args: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args ?? {},
    },
  };
}

/** The `result` shape of a successful `tools/call` JSON-RPC response. */
export interface McpToolCallResult {
  content: string;
  structuredContent: unknown;
  isError: boolean;
}

/**
 * Normalize an MCP `content` array (the `result.content` field of a
 * `tools/call` response) into a single string, the same rule
 * `executeRemoteHttpTool` applies to ordinary tool-call results: text parts
 * are concatenated as-is, non-text parts are JSON-stringified. Returns null
 * when the shape does not match the spec so callers can raise their own
 * transport-specific error rather than this shared helper throwing one on
 * their behalf.
 */
export function normalizeMcpToolContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!record || typeof record.type !== "string") return null;
    if (record.type === "text") {
      if (typeof record.text !== "string") return null;
      parts.push(record.text);
    } else {
      parts.push(JSON.stringify(record));
    }
  }
  return parts.join("\n");
}

/**
 * Extract `content`/`structuredContent`/`isError` out of a `tools/call`
 * JSON-RPC response's `result` field. Returns null when the shape is
 * malformed (missing/invalid `content`) so callers can raise their own
 * transport-specific error, matching how `normalizeMcpToolContent` reports
 * malformed shapes.
 */
export function extractMcpToolCallResult(result: unknown): McpToolCallResult | null {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!record) return null;
  const content = normalizeMcpToolContent(record.content);
  if (content === null) return null;
  return {
    content,
    structuredContent: record.structuredContent ?? null,
    isError: record.isError === true,
  };
}
