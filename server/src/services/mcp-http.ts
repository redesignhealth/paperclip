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
 * Read the response body as a UTF-8 string up to `maxBytes`.
 * If Content-Length exceeds `maxBytes` or the streamed chunk bytes exceed `maxBytes`,
 * cancels the body and returns null.
 * Read errors propagate to the caller.
 */
export async function readMcpHttpResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let cumulativeBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        cumulativeBytes += value.byteLength;
        if (cumulativeBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(cumulativeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Scan an MCP Streamable HTTP response (either a plain JSON body or an SSE stream)
 * for the JSON-RPC response with the EXPECTED request id.
 * Returns null if not found, malformed, or missing a result/error property.
 */
export function findJsonRpcResponse(
  contentType: string | null | undefined,
  text: string,
  expectedId: string | number,
): Record<string, unknown> | null {
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
  const initializeId = `${input.requestId}-initialize`;

  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(input.headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: initializeId,
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

  const contentType = initializeResponse.headers.get("content-type");

  if (isStrict) {
    const rawSessionId = initializeResponse.headers.get("mcp-session-id");
    let validSessionId: string | null = null;
    if (rawSessionId) {
      if (!/^[\x21-\x7E]{1,256}$/.test(rawSessionId)) {
        if (initializeResponse.body) {
          try {
            await initializeResponse.body.cancel();
          } catch {}
        }
        throw new McpHttpInitializationError(
          "Remote MCP initialization returned an invalid Mcp-Session-Id header",
          "initialize",
          initializeResponse.status,
        );
      }
      validSessionId = rawSessionId;
    }

    let sessionHeaders: Record<string, string> | undefined;
    try {
      let responseText: string | null;
      try {
        responseText = await readMcpHttpResponseText(initializeResponse, maxBytes!);
      } catch {
        throw new McpHttpInitializationError(
          "Remote MCP initialization returned an invalid response",
          "initialize",
          initializeResponse.status,
        );
      }
      if (responseText === null) {
        throw new McpHttpInitializationError(
          "Remote MCP initialization response exceeded maximum size",
          "initialize",
          initializeResponse.status,
        );
      }

      const envelope = findJsonRpcResponse(contentType, responseText, initializeId);
      if (!envelope) {
        throw new McpHttpInitializationError(
          "Remote MCP initialization returned an invalid response",
          "initialize",
          initializeResponse.status,
        );
      }
      if ("error" in envelope) {
        throw new McpHttpInitializationError(
          "Remote MCP initialization returned error",
          "initialize",
          initializeResponse.status,
        );
      }

      const result = envelope.result && typeof envelope.result === "object"
        ? (envelope.result as Record<string, unknown>)
        : null;
      const reportedVersion = typeof result?.protocolVersion === "string" ? result.protocolVersion : "";
      if (!supportedVersions.includes(reportedVersion)) {
        throw new McpHttpInitializationError(
          "Remote MCP initialization returned unsupported protocol version",
          "initialize",
          initializeResponse.status,
        );
      }

      sessionHeaders = {
        ...(input.headers ?? {}),
        "MCP-Protocol-Version": reportedVersion,
        ...(validSessionId ? { "Mcp-Session-Id": validSessionId } : {}),
      };

      const initializedResponse = await input.send({
        method: "POST",
        headers: mcpHttpRequestHeaders(sessionHeaders),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      if (initializedResponse.body) {
        try {
          await initializedResponse.body.cancel();
        } catch {}
      }
      if (!initializedResponse.ok) {
        throw new McpHttpInitializationError(
          `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
          "initialized_notification",
          initializedResponse.status,
        );
      }
      return sessionHeaders;
    } catch (error) {
      if (validSessionId) {
        const cleanupHeaders = sessionHeaders ?? {
          ...(input.headers ?? {}),
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Session-Id": validSessionId,
        };
        await terminateMcpHttpSession({ send: input.send, headers: cleanupHeaders, timeoutMs: 3000 });
      }
      if (error instanceof McpHttpInitializationError) {
        throw error;
      }
      throw new McpHttpInitializationError(
        "Remote MCP initialization returned an invalid response",
        "initialize",
        initializeResponse.status,
      );
    }
  }

  // Non-strict flow (restores master behavior: no DELETE on notification failure)
  let payload: unknown;
  try {
    payload = parseMcpHttpResponseBody(await initializeResponse.text(), contentType);
  } catch {
    throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null);
  }
  const result = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: unknown }).result
    : null;
  const resultRecord = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
    ? resultRecord.protocolVersion
    : MCP_PROTOCOL_VERSION;
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const sessionHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };

  const initializedResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(sessionHeaders),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (initializedResponse.body) {
    try {
      await initializedResponse.body.cancel();
    } catch {}
  }
  if (!initializedResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
      "initialized_notification",
      initializedResponse.status,
    );
  }
  return sessionHeaders;
}

/**
 * Best-effort termination of an MCP Streamable HTTP session.
 * Skips execution if no Mcp-Session-Id header is present.
 * Sends DELETE with session headers (excluding content-type) and no body.
 * Cancels any response body and swallows errors.
 */
export async function terminateMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const sessionId = Object.entries(input.headers).find(
    ([k]) => k.toLowerCase() === "mcp-session-id",
  )?.[1];
  if (!sessionId) return;

  const deleteHeaders: Record<string, string> = {
    accept: MCP_HTTP_ACCEPT,
  };
  for (const [k, v] of Object.entries(input.headers)) {
    if (k.toLowerCase() !== "content-type") {
      deleteHeaders[k] = v;
    }
  }

  try {
    const response = await input.send({
      method: "DELETE",
      headers: deleteHeaders,
      signal: AbortSignal.timeout(input.timeoutMs ?? 3000),
    });
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }
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
