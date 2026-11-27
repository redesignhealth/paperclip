import { describe, expect, it } from "vitest";
import {
  buildClaudeSandboxMemoryNote,
  findClaudeMemoryRelayServer,
  resolveClaudeMemoryToolName,
  stripSandboxMemoryHookEnv,
} from "./memory-relay.js";
import { selectClaudeMcpRelayServers } from "./mcp-relay.js";

const server = (name: string, allowedTools: string[]) => ({ name, url: "https://x.example/mcp", token: "t", connectionId: `c-${name}`, allowedTools });

describe("claude sandbox memory", () => {
  it("resolves bare and gateway-namespaced memory tool names", () => {
    expect(resolveClaudeMemoryToolName(["memory_search"], "memory_search")).toBe("memory_search");
    const namespaced = ["mcp.rh-agent-memory-tools-2d639e79:memory-search", "mcp.rh-agent-memory-tools-2d639e79:memory-add"];
    expect(resolveClaudeMemoryToolName(namespaced, "memory_search")).toBe(namespaced[0]);
    expect(resolveClaudeMemoryToolName(namespaced, "memory_add")).toBe(namespaced[1]);
    expect(resolveClaudeMemoryToolName(namespaced, "memory_delete")).toBeNull();
    expect(resolveClaudeMemoryToolName(["memory-searcher"], "memory_search")).toBeNull();
  });

  it("finds the memory server among relay servers, or none", () => {
    const { relayServers } = selectClaudeMcpRelayServers([server("Comms", ["inbox"]), server("Mem", ["memory_search", "memory_add"])]);
    expect(findClaudeMemoryRelayServer(relayServers)?.key).toBe("mem");
    expect(findClaudeMemoryRelayServer(relayServers.slice(0, 1))).toBeNull();
  });

  it("builds a note naming the server and the available tools", () => {
    const { relayServers } = selectClaudeMcpRelayServers([server("Mem", ["memory_search", "memory_add"])]);
    const note = buildClaudeSandboxMemoryNote(relayServers[0]!);
    expect(note).toContain("`mem`");
    expect(note).toContain("memory_search, memory_add");
    expect(note).not.toContain("memory_delete");
  });

  it("strips only the hook env", () => {
    const env: Record<string, string> = { RH_MEMORY_TOKEN: "a", RH_MEMORY_URL: "b", RH_MEMORY_PROXY: "c", RH_MEMORY_TOP_K: "5", OTHER: "x" };
    expect(stripSandboxMemoryHookEnv(env)).toEqual(["RH_MEMORY_TOKEN", "RH_MEMORY_URL", "RH_MEMORY_PROXY"]);
    expect(env).toEqual({ RH_MEMORY_TOP_K: "5", OTHER: "x" });
    expect(stripSandboxMemoryHookEnv(env)).toEqual([]);
  });
});
