import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import os from "node:os";
import path from "node:path";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const CLAUDE_RESULT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
  JSON.stringify({ type: "result", session_id: "claude-session-1", result: "done", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
].join("\n");

const { runChildProcess, startAdapterExecutionTargetPaperclipBridge, prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (..._args: unknown[]): Promise<RunProcessResult> => { throw new Error("unset"); }),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "claude"),
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, startAdapterExecutionTargetPaperclipBridge, prepareAdapterExecutionTargetRuntime };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const BRIDGE_ENV = {
  PAPERCLIP_API_URL: "http://127.0.0.1:4310",
  PAPERCLIP_API_KEY: "bridge-token",
  PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
};
const MCP_TOKEN = "mcp-secret-token-do-not-leak";
const RUNTIME_ROOT = "/workspace/.paperclip-runtime/claude";

const runtimeMcp = {
  getServers: () => [
    {
      name: "Comms Board",
      url: "https://paperclip.example/api/mcp/comms",
      token: MCP_TOKEN,
      connectionId: "conn-1",
      allowedTools: ["post_message", "inbox"],
      requestTimeoutMs: 10_000,
    },
    {
      name: "No Tools",
      url: "https://paperclip.example/api/mcp/none",
      token: MCP_TOKEN,
      connectionId: "conn-2",
      allowedTools: [],
    },
  ],
};

const runnerInputs: Array<{ command?: string; args?: string[]; env?: Record<string, string> }> = [];

function sandboxTarget(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    remoteCwd: "/workspace",
    runner: {
      execute: async (input: { command?: string; args?: string[]; env?: Record<string, string> }) => {
        runnerInputs.push(input);
        const isRun = input.args?.includes("--output-format") === true;
        return { exitCode: 0, signal: null, timedOut: false, stdout: isRun ? CLAUDE_RESULT : "2.1.284 (Claude Code)\n", stderr: "", pid: null, startedAt: new Date().toISOString() };
      },
    },
  } as unknown as AdapterExecutionTarget;
}

describe("claude runtime MCP servers", () => {
  const cleanupDirs: string[] = [];
  const stagedMcpJson: string[] = [];
  const stagedInstructions: string[] = [];

  function reset() {
    vi.clearAllMocks();
    stagedMcpJson.length = 0;
    stagedInstructions.length = 0;
    runnerInputs.length = 0;
    resetClaudeCliCapabilitiesCacheForTests();
    runChildProcess.mockReset().mockImplementation(async (_runId: unknown, _command: unknown, args: unknown) => ({
      exitCode: 0, signal: null, timedOut: false,
      stdout: (args as string[]).includes("--version") ? "2.1.284 (Claude Code)\n" : CLAUDE_RESULT,
      stderr: "", pid: 123, startedAt: new Date().toISOString(),
    }));
    startAdapterExecutionTargetPaperclipBridge.mockReset().mockImplementation(async () => ({ env: { ...BRIDGE_ENV }, stop: async () => {} }));
    prepareAdapterExecutionTargetRuntime.mockReset().mockImplementation((async (input: { target: AdapterExecutionTarget; assets?: Array<{ key: string; localDir: string }> }) => {
      for (const asset of input.assets ?? []) {
        if (asset.key === "skills") {
          for (const name of await readdir(asset.localDir)) {
            if (name.endsWith(".md")) stagedInstructions.push(await readFile(path.join(asset.localDir, name), "utf8"));
          }
        }
        if (asset.key !== "mcp-config") continue;
        stagedMcpJson.push(await readFile(path.join(asset.localDir, "mcp-config.json"), "utf8"));
      }
      return {
        target: input.target,
        workspaceRemoteDir: "/workspace",
        runtimeRootDir: RUNTIME_ROOT,
        assetDirs: { skills: `${RUNTIME_ROOT}/skills`, "mcp-config": `${RUNTIME_ROOT}/mcp-config` },
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: async () => {},
      };
    }) as never);
  }

  async function run(overrides: Record<string, unknown> = {}) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-mcp-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const logs: string[] = [];
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "home"));
    await execute({
      runId: "run-mcp",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "claude", env: {} },
      context: { ...createPromptContextFixture(), paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      runtimeMcp,
      onLog: async (_stream: string, line: string) => { logs.push(line); },
      ...overrides,
    } as never);
    const invocation = runnerInputs.find((input) => input.args?.includes("--output-format"));
    if (invocation) return { args: invocation.args!, env: invocation.env ?? {}, logs };
    const call = runChildProcess.mock.calls.find((c: unknown[]) => (c[2] as string[]).includes("--output-format"));
    const [, , args, options] = call as unknown as [string, string, string[], { env: Record<string, string> }];
    return { args, env: options.env, logs };
  }

  reset();
  afterEach(async () => {
    vi.unstubAllEnvs();
    reset();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("in a sandbox pod stages a credential-free config and registers relay routes", async () => {
    const { args, env, logs } = await run({ executionTarget: sandboxTarget() });

    expect(stagedMcpJson).toHaveLength(1);
    const written = JSON.parse(stagedMcpJson[0]!);
    expect(written).toEqual({
      mcpServers: {
        comms_board: {
          type: "http",
          url: "${PAPERCLIP_API_URL}/paperclip-relay/mcp/comms_board",
          headers: { Authorization: "Bearer ${PAPERCLIP_API_KEY}" },
        },
      },
    });
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        relayRoutes: [
          expect.objectContaining({
            path: "/paperclip-relay/mcp/comms_board",
            upstreamUrl: "https://paperclip.example/api/mcp/comms",
            token: MCP_TOKEN,
            deadlineMs: 15_000,
          }),
        ],
      }),
    );
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
    expect(env.MCP_TOOL_TIMEOUT).toBe("25000");
    expect(logs.join("")).toContain("No Tools");

    const podVisible = JSON.stringify({ args, env, written });
    expect(podVisible).not.toContain(MCP_TOKEN);
    expect(podVisible).not.toContain("https://paperclip.example");
  });

  it("keeps a configured MCP_TOOL_TIMEOUT in a sandbox pod", async () => {
    const { env } = await run({ executionTarget: sandboxTarget(), config: { engine: "cli", command: "claude", env: { MCP_TOOL_TIMEOUT: "1234" } } });
    expect(env.MCP_TOOL_TIMEOUT).toBe("1234");
  });

  it("passes no --mcp-config in a pod when every server lacks allowed tools", async () => {
    const { args } = await run({
      executionTarget: sandboxTarget(),
      runtimeMcp: { getServers: () => runtimeMcp.getServers().slice(1) },
    });
    expect(args).not.toContain("--mcp-config");
    expect(startAdapterExecutionTargetPaperclipBridge.mock.calls[0]![0]).not.toHaveProperty("relayRoutes");
  });

  it("keeps the direct config, with the server URL and bearer token, for a local run", async () => {
    const { args, env } = await run();
    expect(args).toContain("--mcp-config");
    const configPath = args[args.indexOf("--mcp-config") + 1]!;
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({
      mcpServers: {
        "Comms Board": { type: "http", url: "https://paperclip.example/api/mcp/comms", headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
        "No Tools": { type: "http", url: "https://paperclip.example/api/mcp/none", headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
      },
    });
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(env.MCP_TOOL_TIMEOUT).toBeUndefined();
  });

  describe("memory", () => {
    const memoryMcp = {
      getServers: () => [
        {
          name: "Agent Memory",
          url: "https://paperclip.example/api/mcp/memory",
          token: MCP_TOKEN,
          connectionId: "conn-3",
          allowedTools: ["mcp.rh-agent-memory-tools-2d639e79:memory-search", "mcp.rh-agent-memory-tools-2d639e79:memory-add"],
        },
      ],
    };
    const hookEnv = { RH_MEMORY_TOKEN: "memory-secret-do-not-leak", RH_MEMORY_URL: "https://memory.internal.example", RH_MEMORY_PROXY: "http://127.0.0.1:1055", RH_MEMORY_TOP_K: "3" };

    it("in a sandbox pod keeps the hook env out, relays the memory server and tells the agent to use it", async () => {
      const { env, logs } = await run({
        executionTarget: sandboxTarget(),
        runtimeMcp: memoryMcp,
        config: { engine: "cli", command: "claude", env: hookEnv },
      });
      expect(env.RH_MEMORY_TOKEN).toBeUndefined();
      expect(env.RH_MEMORY_URL).toBeUndefined();
      expect(env.RH_MEMORY_PROXY).toBeUndefined();
      expect(env.RH_MEMORY_TOP_K).toBe("3");
      expect(JSON.stringify(env)).not.toContain("memory-secret-do-not-leak");
      expect(JSON.parse(stagedMcpJson[0]!).mcpServers).toHaveProperty("agent_memory");
      expect(stagedInstructions.join("\n")).toContain("## Memory in this sandbox");
      expect(stagedInstructions.join("\n")).toContain("`agent_memory`");
      expect(logs.join("")).toContain("Memory hooks are off in a sandbox pod");
    });

    it("warns, and adds no memory note, when the agent has hook env but no memory server", async () => {
      const { env, logs } = await run({
        executionTarget: sandboxTarget(),
        config: { engine: "cli", command: "claude", env: hookEnv },
      });
      expect(env.RH_MEMORY_TOKEN).toBeUndefined();
      expect(stagedInstructions.join("\n")).not.toContain("Memory in this sandbox");
      expect(logs.join("")).toContain("memory MCP server is not available");
    });

    it("leaves the hook env and the instructions alone for a local run", async () => {
      const { env } = await run({
        runtimeMcp: memoryMcp,
        config: { engine: "cli", command: "claude", env: hookEnv },
      });
      expect(env.RH_MEMORY_TOKEN).toBe("memory-secret-do-not-leak");
      expect(env.RH_MEMORY_URL).toBe("https://memory.internal.example");
      expect(env.RH_MEMORY_PROXY).toBe("http://127.0.0.1:1055");
      expect(stagedInstructions).toEqual([]);
    });
  });
});
