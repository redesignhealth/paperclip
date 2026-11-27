import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { sandboxBridgeMcpRelayPath, sanitizeMcpServerKey } from "@paperclipai/adapter-utils/sandbox-bridge-relay";

// TECH-11041: in a sandbox pod the Paperclip server is not reachable, so Claude's runtime MCP servers go through the
// bridge relay, as they do for pi_local (pi-local/src/server/mcp-config.ts). Every server points at a bridge relay
// route and authenticates with the run's bridge token; the host injects each server's own token per route, so no
// MCP server token is written to the pod. Claude Code expands `${VAR}` in the `url` and `headers` of an MCP config
// from its own process env, and the bridge env (PAPERCLIP_API_URL, PAPERCLIP_API_KEY) is only known once the bridge has
// started, after the config is staged, so the file holds placeholders only.

export const CLAUDE_MCP_DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
/** A relayed call that runs past about 65 s fails in a pod, so a client timeout is capped below that. */
export const CLAUDE_MCP_MAX_TOOL_TIMEOUT_MS = 60_000;
export const CLAUDE_MCP_RELAY_DEADLINE_MARGIN_MS = 5_000;

export interface ClaudeMcpRelayServer {
  key: string;
  server: AdapterRuntimeMcpServer;
}

/**
 * Servers that may be wired through the relay. A server with no allowed tools is dropped (fail closed, as for Pi).
 */
export function selectClaudeMcpRelayServers(servers: readonly AdapterRuntimeMcpServer[]): {
  relayServers: ClaudeMcpRelayServer[];
  skipped: string[];
} {
  const used = new Set<string>();
  const relayServers: ClaudeMcpRelayServer[] = [];
  const skipped: string[] = [];
  for (const server of servers) {
    if (server.allowedTools.length === 0) {
      skipped.push(server.name);
      continue;
    }
    relayServers.push({ key: sanitizeMcpServerKey(server.name, server.connectionId, used), server });
  }
  return { relayServers, skipped };
}

export function claudeMcpRequestTimeoutMs(server: AdapterRuntimeMcpServer): number {
  return server.requestTimeoutMs ?? CLAUDE_MCP_DEFAULT_REQUEST_TIMEOUT_MS;
}

/** The `--mcp-config` body for a pod. Holds only `${VAR}` placeholders resolved from the pod env at run time. */
export function buildClaudeMcpRelayConfig(relayServers: readonly ClaudeMcpRelayServer[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const { key } of relayServers) {
    mcpServers[key] = {
      type: "http",
      url: `\${PAPERCLIP_API_URL}${sandboxBridgeMcpRelayPath(key)}`,
      headers: { Authorization: "Bearer ${PAPERCLIP_API_KEY}" },
    };
  }
  return { mcpServers };
}

/** Relay route registrations for the bridge: the host holds each server's token. */
export function buildClaudeMcpRelayRoutes(relayServers: readonly ClaudeMcpRelayServer[]) {
  return relayServers.map(({ key, server }) => ({
    path: sandboxBridgeMcpRelayPath(key),
    upstreamUrl: server.url,
    token: server.token,
    deadlineMs: claudeMcpRequestTimeoutMs(server) + CLAUDE_MCP_RELAY_DEADLINE_MARGIN_MS,
    label: server.name,
  }));
}

/**
 * Claude Code's `MCP_TOOL_TIMEOUT` (ms). Set so a slow relayed call fails cleanly in the client before the relay gives up.
 */
export function claudeMcpToolTimeoutMs(relayServers: readonly ClaudeMcpRelayServer[]): number {
  const longest = Math.max(...relayServers.map(({ server }) => claudeMcpRequestTimeoutMs(server)));
  return Math.min(Math.max(longest, CLAUDE_MCP_DEFAULT_REQUEST_TIMEOUT_MS), CLAUDE_MCP_MAX_TOOL_TIMEOUT_MS);
}
