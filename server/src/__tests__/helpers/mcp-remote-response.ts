/**
 * A minimal streamable-HTTP MCP server response for gateway tests. Session-required connections open with
 * `initialize` before `tools/call`, so each MCP method needs its own response shape. Pass the `tools/call`
 * result to return (defaults to a one-line text result).
 */
export function mcpRemoteResponse(
  init?: RequestInit,
  toolResult: Record<string, unknown> = { content: [{ type: "text", text: "ok" }] },
): Response {
  if (init?.method === "DELETE") return new Response(null, { status: 200 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  const initialize = body.method === "initialize";
  const result = initialize
    ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1" } }
    : toolResult;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...(initialize ? { "mcp-session-id": "session-test" } : {}) },
  });
}
