import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    runChildProcess.mockReset().mockImplementation(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: PI_TURN_END, stderr: "", pid: 123,
      startedAt: new Date().toISOString(),
    }));
    startAdapterExecutionTargetPaperclipBridge.mockReset().mockImplementation(async () => ({
      env: { ...BRIDGE_ENV },
      stop: async () => {},
    }));
    prepareAdapterExecutionTargetRuntime.mockReset().mockImplementation(actualPrepare.fn as never);
    syncDirectoryToSsh.mockReset().mockImplementation((async (input: { localDir: string }) => {
      try {
        syncedMcpJson.push(await readFile(path.join(input.localDir, "mcp.json"), "utf8"));
      } catch {
        // not the agentConfig directory
      }
    }) as never);
  }

  async function run(overrides: Record<string, unknown> = {}) {
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
      executionTransport: sshTransport,
      authToken: RUN_JWT,
      runtimeMcp,
      onLog: async (_stream: string, line: string) => { logs.push(line); },
      ...overrides,
    } as never);
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

  it("writes a credential-free mcp.json, registers relay routes, and loads the adapter extension", async () => {
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
    expect(env.PI_CODING_AGENT_DIR).toContain("agentConfig");
    expect(logs.join("")).toContain("skipped runtime MCP server(s) with no allowed tools: No Tools");

    // No MCP token and no run JWT anywhere the pod can see.
    const podVisible = JSON.stringify({ args, env, written, sync: syncDirectoryToSsh.mock.calls, sync2: syncedMcpJson });
    expect(podVisible).not.toContain(MCP_TOKEN);
    expect(podVisible).not.toContain(RUN_JWT);
    expect(env.PAPERCLIP_API_KEY).toBe("bridge-token");
  });

  it("honours PAPERCLIP_PI_MCP_ADAPTER_PATH", async () => {
    const { args } = await run({
      config: { command: "pi", model: "openai/gpt-5.4-mini", env: { PAPERCLIP_PI_MCP_ADAPTER_PATH: "/custom/mcp/index.ts" } },
    });
    expect(args).toContain("/custom/mcp/index.ts");
  });

  it("leaves Pi unchanged when the run has no MCP servers", async () => {
    const { args, env } = await run({ runtimeMcp: { getServers: () => [] } });
    expect(syncedMcpJson).toHaveLength(0);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.not.objectContaining({ relayRoutes: expect.anything() }),
    );
  });

  it("continues without MCP and says so on a local target", async () => {
    const { args, logs } = await run({ executionTransport: undefined, executionTarget: undefined });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(logs.join("")).toContain("runtime MCP server(s) need the Paperclip bridge relay");
  });
});
