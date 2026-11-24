import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PI_TURN_END = JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: "done",
    usage: { input: 10, output: 20, cacheRead: 0, cost: { total: 0.01 } },
  },
  toolResults: [],
});

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
  prepareAdapterExecutionTargetRuntime,
  actualPrepare,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "pi"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  actualPrepare: { fn: undefined as undefined | ((...args: never[]) => unknown) },
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  actualPrepare.fn = actual.prepareAdapterExecutionTargetRuntime as never;
  return { ...actual, startAdapterExecutionTargetPaperclipBridge, prepareAdapterExecutionTargetRuntime };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
      { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
    ]),
  };
});

import { execute } from "./execute.js";

const BRIDGE_ENV = {
  PAPERCLIP_API_URL: "http://127.0.0.1:4310",
  PAPERCLIP_API_KEY: "bridge-token",
  PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
};

const MCP_TOKEN = "mcp-secret-token-do-not-leak";
const RUN_JWT = "eyJfake.run-jwt-mcp.sig";

const runtimeMcp = {
  getServers: () => [
    {
      name: "Comms Board",
      url: "https://paperclip.example/api/mcp/comms",
      token: MCP_TOKEN,
      connectionId: "conn-1",
      allowedTools: ["post_message", "post_message", "inbox"],
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

const RUNTIME_ROOT = "/workspace/.paperclip-runtime/pi";

const runnerInputs: Array<{ command?: string; args?: string[]; env?: Record<string, string> }> = [];

function sandboxTarget(probeExitCode: number): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    remoteCwd: "/workspace",
    runner: {
      execute: async (input: { command?: string; args?: string[]; env?: Record<string, string> }) => (runnerInputs.push(input), {
        exitCode: JSON.stringify(input).includes("test -f") ? probeExitCode : 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  } as AdapterExecutionTarget;
}

const sshTransport = {
  remoteExecution: {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
    strictHostKeyChecking: true,
  },
};

describe("pi runtime MCP servers through the sandbox relay", () => {
  const cleanupDirs: string[] = [];
  const syncedMcpJson: string[] = [];

  function reset() {
    vi.clearAllMocks();
    syncedMcpJson.length = 0;
    runnerInputs.length = 0;
    runChildProcess.mockReset().mockImplementation(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: PI_TURN_END, stderr: "", pid: 123,
      startedAt: new Date().toISOString(),
    }));
    startAdapterExecutionTargetPaperclipBridge.mockReset().mockImplementation(async () => ({
      env: { ...BRIDGE_ENV },
      stop: async () => {},
    }));
    prepareAdapterExecutionTargetRuntime.mockReset().mockImplementation((async (input: { target: AdapterExecutionTarget; assets?: Array<{ key: string; localDir: string }> }) => {
      for (const asset of input.assets ?? []) {
        if (asset.key !== "agentConfig") continue;
        try { syncedMcpJson.push(await readFile(path.join(asset.localDir, "mcp-adapter.json"), "utf8")); } catch { /* none */ }
      }
      return {
        target: input.target,
        workspaceRemoteDir: "/workspace",
        runtimeRootDir: RUNTIME_ROOT,
        assetDirs: {
          attribution: `${RUNTIME_ROOT}/attribution`,
          guard: `${RUNTIME_ROOT}/guard`,
          memory: `${RUNTIME_ROOT}/memory`,
          skills: `${RUNTIME_ROOT}/skills`,
          agentConfig: `${RUNTIME_ROOT}/agentConfig`,
        },
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: async () => {},
      };
    }) as never);
  }

  async function run(overrides: Record<string, unknown> = {}) {
    runnerInputs.length = 0;
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-mcp-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const logs: string[] = [];
    await execute({
      runId: "run-mcp",
      agent: { id: "agent-1", companyId: "company-1", name: "Pi Builder", adapterType: "pi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "pi", model: "openai/gpt-5.4-mini" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      executionTarget: sandboxTarget(0),
      runtimeCommandSpec: { command: "pi", installCommand: "npm install -g pi", detectCommand: "pi" },
      authToken: RUN_JWT,
      runtimeMcp,
      onLog: async (_stream: string, line: string) => { logs.push(line); },
      ...overrides,
    } as never);
    const invocation = runnerInputs.find((input) => input.args?.includes("--mode"));
    // SSH and local targets run Pi through runChildProcess instead of the sandbox runner.
    if (invocation) return { args: invocation.args!, env: invocation.env ?? {}, logs };
    const [, , args, options] = runChildProcess.mock.calls[0] as unknown as
      [string, string, string[], { env: Record<string, string> }];
    return { args, env: options.env, logs };
  }

  reset();
  afterEach(async () => {
    reset();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("writes a credential-free mcp-adapter.json, registers relay routes, and loads the adapter extension", async () => {
    const { args, env, logs } = await run();

    expect(syncedMcpJson).toHaveLength(1);
    const written = JSON.parse(syncedMcpJson[0]!) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(Object.keys(written.mcpServers)).toEqual(["comms_board"]);
    expect(written.mcpServers.comms_board).toMatchObject({
      url: "${PAPERCLIP_API_URL}/paperclip-relay/mcp/comms_board",
      headers: { Authorization: "Bearer ${PAPERCLIP_API_KEY}" },
      includeTools: ["post_message", "inbox"],
      requestTimeoutMs: 10_000,
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

    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls,mcp");
    const extensions = args.flatMap((value, index) => (args[index - 1] === "--extension" ? [value] : []));
    expect(extensions).toContain("/opt/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts");
    expect(env.PI_CODING_AGENT_DIR).toBe(`${RUNTIME_ROOT}/agentConfig`);
    expect(logs.join("")).toContain("skipped runtime MCP server(s) with no allowed tools: No Tools");

    // No MCP token and no run JWT anywhere the pod can see.
    const podVisible = JSON.stringify({ args, env, written, sync: prepareAdapterExecutionTargetRuntime.mock.calls.map((call) => (call[0] as { assets: unknown }).assets) });
    expect(podVisible).not.toContain(MCP_TOKEN);
    expect(podVisible).not.toContain(RUN_JWT);
    expect(env.PAPERCLIP_API_KEY).toBe("bridge-token");
  });

  it("honours the server-side PAPERCLIP_PI_MCP_ADAPTER_PATH but ignores the agent's own env", async () => {
    const agentOnly = await run({
      config: { command: "pi", model: "openai/gpt-5.4-mini", env: { PAPERCLIP_PI_MCP_ADAPTER_PATH: "/agent/chosen.ts" } },
    });
    expect(agentOnly.args).not.toContain("/agent/chosen.ts");
    process.env.PAPERCLIP_PI_MCP_ADAPTER_PATH = "/custom/mcp/index.ts";
    try {
      const { args } = await run();
      expect(args).toContain("/custom/mcp/index.ts");
    } finally {
      delete process.env.PAPERCLIP_PI_MCP_ADAPTER_PATH;
    }
  });

  it("runs without MCP when the image has no adapter extension", async () => {
    const { args, logs } = await run({ executionTarget: sandboxTarget(1) });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(args).not.toContain("/opt/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts");
    expect(logs.join("")).toContain("extension was not found");
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.not.objectContaining({ relayRoutes: expect.anything() }),
    );
  });

  it("does not wire MCP for an SSH target (it has the bridge but not the image extension)", async () => {
    const { args, logs } = await run({ executionTarget: undefined, executionTransport: sshTransport });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(args.some((arg) => arg.includes("pi-mcp-adapter"))).toBe(false);
    expect(syncedMcpJson).toHaveLength(0);
    expect(logs.join("")).toContain("only sandbox pod targets have");
  });

  it("leaves Pi unchanged when the run has no MCP servers", async () => {
    const { args } = await run({ runtimeMcp: { getServers: () => [] } });
    expect(syncedMcpJson).toHaveLength(0);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.not.objectContaining({ relayRoutes: expect.anything() }),
    );
  });

  it("continues without MCP and says so on a local target", async () => {
    const { args, logs } = await run({ executionTransport: undefined, executionTarget: undefined });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(logs.join("")).toContain("only sandbox pod targets have");
  });
  it("loads the memory extension and its tools for an enrolled agent with a memory MCP server", async () => {
    const memoryServer = {
      name: "rh-agent-memory-tools",
      url: "https://paperclip.example/api/mcp/memory",
      token: MCP_TOKEN,
      connectionId: "conn-3",
      allowedTools: ["memory_search", "memory_add", "memory_delete"],
    };
    const { args, env, logs } = await run({
      config: { command: "pi", model: "openai/gpt-5.4-mini", memoryExtension: true },
      runtimeMcp: { getServers: () => [memoryServer] },
    });
    const written = JSON.parse(syncedMcpJson[0]!) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(written.mcpServers.rh_agent_memory_tools).toMatchObject({ includeTools: ["memory_search", "memory_add", "memory_delete"] });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls,mcp,memory_search,memory_add,memory_delete");
    const extensions = args.flatMap((value, index) => (args[index - 1] === "--extension" ? [value] : []));
    expect(extensions.some((value) => value.endsWith("/rh-memory.mjs"))).toBe(true);
    expect(logs.join("")).not.toContain("memory MCP server is not available");
    expect(JSON.stringify({ args, env, written })).not.toContain(MCP_TOKEN);
  });

  it("continues without the memory extension, and says so, when the memory server is not in the run", async () => {
    const { args, logs } = await run({ config: { command: "pi", model: "openai/gpt-5.4-mini", memoryExtension: true } });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls,mcp");
    expect(args.some((value) => value.endsWith("/rh-memory.mjs"))).toBe(false);
    expect(logs.join("")).toContain("memory MCP server is not available");
  });

  it("does not load the memory extension for an agent that is not enrolled", async () => {
    const memoryServer = { name: "rh-agent-memory-tools", url: "https://paperclip.example/api/mcp/memory", token: MCP_TOKEN, connectionId: "c", allowedTools: ["memory_search"] };
    const { args } = await run({ runtimeMcp: { getServers: () => [memoryServer] } });
    expect(args.some((value) => value.endsWith("/rh-memory.mjs"))).toBe(false);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls,mcp");
  });
});
