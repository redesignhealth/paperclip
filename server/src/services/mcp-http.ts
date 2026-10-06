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
export const MCP_PROTOCOL_VERSION = "2025-06-18";

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

export class McpHttpInitializationError extends Error {
  constructor(
    message: string,
    readonly stage: "initialize" | "initialized_notification",
    readonly status: number | null,
  ) {
    super(message);
    this.name = "McpHttpInitializationError";
  }
}

/**
 * Scan an MCP Streamable HTTP response (either a plain JSON body or an SSE stream)
 * for the JSON-RPC response with the EXPECTED request id.
 * Returns null if not found, malformed, or exceeds the maximum size.
 */
export function findJsonRpcResponse(
  contentType: string | null | undefined,
  text: string,
  expectedId: string | number,
  maxResponseBytes?: number,
): Record<string, unknown> | null {
  if (maxResponseBytes !== undefined && Buffer.byteLength(text, "utf8") > maxResponseBytes) {
    return null;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        isRecord(parsed) &&
        parsed.id === expectedId &&
        ("result" in parsed || "error" in parsed)
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  // SSE event stream scanning
  for (const event of text.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }
    if (
      isRecord(parsed) &&
      parsed.id === expectedId &&
      ("result" in parsed || "error" in parsed)
    ) {
      return parsed;
    }
  }
  return null;
}

/**
 * Establish the short-lived Streamable HTTP session needed by stateful MCP
 * servers. The returned headers belong only to the caller's next request; no
 * session id is persisted with the connection or shared across operations.
 */
export async function initializeMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
  strict?: boolean;
  maxResponseBytes?: number;
  supportedVersions?: string[];
}): Promise<Record<string, string>> {
  const isStrict = input.strict === true;
  const maxBytes = input.maxResponseBytes ?? (isStrict ? 1_000_000 : undefined);
  const supportedVersions = input.supportedVersions ?? ["2025-06-18", "2025-03-26"];

  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(input.headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${input.requestId}-initialize`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip", version: "1" },
      },
    }),
  });
  if (!initializeResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${initializeResponse.status}`,
      "initialize",
      initializeResponse.status,
    );
  }

  if (isStrict && maxBytes !== undefined) {
    const contentLength = initializeResponse.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new McpHttpInitializationError(
        "Remote MCP initialization response exceeded maximum size",
        "initialize",
        initializeResponse.status,
      );
    }
  }

  let responseText: string;
  try {
    responseText = await initializeResponse.text();
  } catch {
    throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", initializeResponse.status);
  }

  if (isStrict && maxBytes !== undefined && Buffer.byteLength(responseText, "utf8") > maxBytes) {
    throw new McpHttpInitializationError(
      "Remote MCP initialization response exceeded maximum size",
      "initialize",
      initializeResponse.status,
    );
  }

  const contentType = initializeResponse.headers.get("content-type");
  let protocolVersion: string;

  if (isStrict) {
    const envelope = findJsonRpcResponse(contentType, responseText, `${input.requestId}-initialize`, maxBytes);
    if (!envelope) {
      throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", initializeResponse.status);
    }
    if ("error" in envelope) {
      throw new McpHttpInitializationError("Remote MCP initialization returned error", "initialize", initializeResponse.status);
    }
    const result = envelope.result && typeof envelope.result === "object" ? envelope.result as Record<string, unknown> : null;
    const reportedVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
    if (!supportedVersions.includes(reportedVersion)) {
      throw new McpHttpInitializationError("Remote MCP initialization returned unsupported protocol version", "initialize", initializeResponse.status);
    }
    protocolVersion = reportedVersion;
  } else {
    let payload: unknown;
    try {
      payload = parseMcpHttpResponseBody(responseText, contentType);
    } catch {
      throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null);
    }
    const result = payload && typeof payload === "object" && "result" in payload
      ? (payload as { result?: unknown }).result
      : null;
    const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
    protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
      ? resultRecord.protocolVersion
      : MCP_PROTOCOL_VERSION;
  }

  const sessionId = initializeResponse.headers.get("mcp-session-id");
  if (isStrict && sessionId) {
    // 1..256 visible ASCII characters (ASCII 33 to 126)
    if (!/^[\x21-\x7E]{1,256}$/.test(sessionId)) {
      throw new McpHttpInitializationError("Remote MCP initialization returned an invalid Mcp-Session-Id header", "initialize", initializeResponse.status);
    }
  }

  const sessionHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };

  try {
    const initializedResponse = await input.send({
      method: "POST",
      headers: mcpHttpRequestHeaders(sessionHeaders),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    if (!initializedResponse.ok) {
      throw new McpHttpInitializationError(
        `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
        "initialized_notification",
        initializedResponse.status,
      );
    }
  } catch (error) {
    if (sessionId) {
      await terminateMcpHttpSession({ send: input.send, headers: sessionHeaders, timeoutMs: 3000 });
    }
    throw error;
  }

  return sessionHeaders;
}

/**
 * Best-effort termination of an MCP Streamable HTTP session.
 * Sends DELETE with the session headers (including Mcp-Session-Id).
 * Swallows any error (404/405/network error), never throws.
 */
export async function terminateMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  try {
    await input.send({
      method: "DELETE",
      headers: mcpHttpRequestHeaders(input.headers),
      signal: AbortSignal.timeout(input.timeoutMs ?? 3000),
    });
  } catch {
    // Best-effort: ignore errors on termination
  }
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
export function buildMcpToolCallRequest(id: string | number, toolName: string, args: unknown): Record<string, unknown> {
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
