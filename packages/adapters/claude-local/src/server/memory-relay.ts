import type { ClaudeMcpRelayServer } from "./mcp-relay.js";

// TECH-11041: memory for a claude_local agent in a sandbox pod.
//
// On the server, Claude's recall and capture hooks (`docker/claude/rh-memory-hook`, registered by the image's managed
// settings) call the memory service directly, through the server task's Tailscale proxy. A pod has neither the proxy nor a
// route to the service, so the hooks cannot work there. Instead of a second client, a sandbox run uses the memory MCP
// tools the agent already has through the bridge relay (`memory_search`, `memory_add`, `memory_delete`, the same ones Pi's
// extension calls), and the agent is told to use them. The hooks are switched off by keeping the memory service URL, its
// long-lived token and the proxy out of the pod env: the hook does nothing without them, so it fails open and silent.

/** Hook env the pod must not receive. The hook is a no-op without a token and a URL. */
export const SANDBOX_MEMORY_HOOK_ENV_KEYS = ["RH_MEMORY_TOKEN", "RH_MEMORY_URL", "RH_MEMORY_PROXY"] as const;

export const CLAUDE_MEMORY_TOOL_NAMES = ["memory_search", "memory_add", "memory_delete"] as const;
type MemoryToolBase = (typeof CLAUDE_MEMORY_TOOL_NAMES)[number];

/**
 * The upstream tool name a relay server exposes for one memory tool. Servers that deliver an agent's assigned MCP
 * connections through the gateway list namespaced, hyphenated names (`mcp.rh-agent-memory-tools-2d639e79:memory-search`,
 * with an 8-hex suffix when two connections share a name), not the bare `memory_search`. A bare name wins when listed.
 * Same rule as pi-local's `resolvePiMemoryToolName`.
 */
export function resolveClaudeMemoryToolName(allowedTools: readonly string[], base: MemoryToolBase): string | null {
  if (allowedTools.includes(base)) return base;
  const wanted = base.replace(/_/g, "-");
  return allowedTools.find((name) => {
    const slug = name.toLowerCase().slice(Math.max(name.lastIndexOf(":"), name.lastIndexOf("/")) + 1).replace(/_/g, "-");
    return slug === wanted || (slug.startsWith(wanted + "-") && /^[0-9a-f]{8}$/.test(slug.slice(wanted.length + 1)));
  }) ?? null;
}

/** The relay server that carries the memory tools, or null when the run has none (agent not enrolled). */
export function findClaudeMemoryRelayServer(servers: readonly ClaudeMcpRelayServer[]): ClaudeMcpRelayServer | null {
  return servers.find(({ server }) => resolveClaudeMemoryToolName(server.allowedTools, "memory_search") !== null) ?? null;
}

/** Removes the hook env from a sandbox run's env. Returns the keys that were present. */
export function stripSandboxMemoryHookEnv(env: Record<string, string>): string[] {
  const removed: string[] = [];
  for (const key of SANDBOX_MEMORY_HOOK_ENV_KEYS) {
    if (key in env) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** Short, deterministic note appended to the agent instructions of a sandbox run that has memory tools. */
export function buildClaudeSandboxMemoryNote(memoryServer: ClaudeMcpRelayServer): string {
  const tools = CLAUDE_MEMORY_TOOL_NAMES
    .map((base) => resolveClaudeMemoryToolName(memoryServer.server.allowedTools, base))
    .filter((name): name is string => name !== null);
  return [
    "## Memory in this sandbox",
    "",
    `Automatic memory recall and capture are not available in this sandbox. Your memory is the \`${memoryServer.key}\` MCP server (${tools.join(", ")}).`,
    "Search it with the search tool at the start of a task, before you rely on what you remember of earlier work. When you learn something a later run needs (a decision, a fix, a constraint, a preference), add it with the add tool before you finish. Keep each memory short and self-contained.",
  ].join("\n");
}
