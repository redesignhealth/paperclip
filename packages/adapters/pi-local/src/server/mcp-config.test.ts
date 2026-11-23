import { describe, expect, it } from "vitest";
import {
  buildPiMcpConfig,
  buildPiMcpRelayRoutes,
  resolvePiMcpAdapterPath,
  selectPiMcpRelayServers,
} from "./mcp-config.js";

const server = (name: string, connectionId: string, allowedTools: string[] = ["a"]) => ({
  name,
  url: `https://paperclip.example/api/mcp/${connectionId}`,
  token: "secret-token",
  connectionId,
  allowedTools,
});

describe("pi mcp-config", () => {
  it("derives unique keys and fails closed on empty allowlists", () => {
    const { relayServers, skipped } = selectPiMcpRelayServers([
      server("Linear", "c1"),
      server("Linear", "c2"),
      server("Empty", "c3", []),
    ]);
    expect(relayServers.map((entry) => entry.key)).toEqual(["linear", "linear_c2"]);
    expect(skipped).toEqual(["Empty"]);
  });

  it("builds a config with placeholders only", () => {
    const { relayServers } = selectPiMcpRelayServers([server("Argus", "c1", ["x", "y", "x"])]);
    const config = buildPiMcpConfig(relayServers);
    expect(JSON.stringify(config)).not.toContain("secret-token");
    expect(config).toEqual({
      mcpServers: {
        argus: {
          url: "${PAPERCLIP_API_URL}/paperclip-relay/mcp/argus",
          headers: { Authorization: "Bearer ${PAPERCLIP_API_KEY}" },
          auth: false,
          lifecycle: "lazy",
          requestTimeoutMs: 25_000,
          includeTools: ["x", "y"],
          exposeResources: false,
        },
      },
    });
  });

  it("registers host-held tokens on relay routes with a deadline margin", () => {
    const { relayServers } = selectPiMcpRelayServers([server("Argus", "c1")]);
    expect(buildPiMcpRelayRoutes(relayServers)).toEqual([
      {
        path: "/paperclip-relay/mcp/argus",
        upstreamUrl: "https://paperclip.example/api/mcp/c1",
        token: "secret-token",
        deadlineMs: 30_000,
        label: "Argus",
      },
    ]);
  });

  it("resolves the extension path with an env override", () => {
    expect(resolvePiMcpAdapterPath({})).toBe("/opt/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts");
    expect(resolvePiMcpAdapterPath({ PAPERCLIP_PI_MCP_ADAPTER_PATH: " /x/index.ts " })).toBe("/x/index.ts");
  });
});
