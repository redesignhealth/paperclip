import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { sandboxBridgeMcpRelayPath, sanitizeMcpServerKey } from "@paperclipai/adapter-utils/sandbox-bridge-relay";

// TECH-9794: Pi 0.87 has no native MCP client. The pinned `pi-mcp-adapter` extension (installed in the
// runtime image, see docker/pi-mcp-adapter) reads `$PI_CODING_AGENT_DIR/mcp.json`. In a sandbox pod every
// server points at the bridge relay route and authenticates with the run's bridge token; the server's own
// token never reaches the pod (the host injects it per route).

/**
 * Server-process env var (operator-set, never read from agent adapterConfig.env) that overrides where the pinned
 * extension lives in the runtime image.
 */
export const PI_MCP_ADAPTER_PATH_ENV = "PAPERCLIP_PI_MCP_ADAPTER_PATH";
export const PI_MCP_ADAPTER_DEFAULT_PATH = "/opt/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts";
/** The one tool the extension registers; `--tools` is a name allowlist, so it must be listed. */
export const PI_MCP_TOOL_NAME = "mcp";
export const PI_MCP_DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
export const PI_MCP_RELAY_DEADLINE_MARGIN_MS = 5_000;

export interface PiMcpRelayServer {
  key: string;
  server: AdapterRuntimeMcpServer;
}

export function resolvePiMcpAdapterPath(serverEnv: Record<string, string | undefined> = process.env): string {
  return serverEnv[PI_MCP_ADAPTER_PATH_ENV]?.trim() || PI_MCP_ADAPTER_DEFAULT_PATH;
}

/**
 * Servers that may be wired through the relay. A server with no allowed tools is dropped: the extension
 * treats an empty `includeTools` as "all tools", so it must fail closed here.
 */
export function selectPiMcpRelayServers(servers: readonly AdapterRuntimeMcpServer[]): {
  relayServers: PiMcpRelayServer[];
  skipped: string[];
} {
  const used = new Set<string>();
  const relayServers: PiMcpRelayServer[] = [];
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

export function piMcpRequestTimeoutMs(server: AdapterRuntimeMcpServer): number {
  return server.requestTimeoutMs ?? PI_MCP_DEFAULT_REQUEST_TIMEOUT_MS;
}

/** The `mcp.json` body. Holds only `${VAR}` placeholders resolved from the pod env at run time. */
export function buildPiMcpConfig(relayServers: readonly PiMcpRelayServer[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const { key, server } of relayServers) {
    mcpServers[key] = {
      url: `\${PAPERCLIP_API_URL}${sandboxBridgeMcpRelayPath(key)}`,
      headers: { Authorization: "Bearer ${PAPERCLIP_API_KEY}" },
      auth: false,
      lifecycle: "lazy",
      requestTimeoutMs: piMcpRequestTimeoutMs(server),
      includeTools: [...new Set(server.allowedTools)],
      exposeResources: false,
    };
  }
  return { mcpServers };
}

/** Relay route registrations for the bridge: the host holds each server's token. */
export function buildPiMcpRelayRoutes(relayServers: readonly PiMcpRelayServer[]) {
  return relayServers.map(({ key, server }) => ({
    path: sandboxBridgeMcpRelayPath(key),
    upstreamUrl: server.url,
    token: server.token,
    deadlineMs: piMcpRequestTimeoutMs(server) + PI_MCP_RELAY_DEADLINE_MARGIN_MS,
    label: server.name,
  }));
}
