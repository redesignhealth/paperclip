/**
 * TECH-7095: the ACP client `terminal` capability is a command runner inside the
 * Paperclip server process. It must be OFF by default in every policy, an agent's
 * `acpxClientTerminal: true` opt-in is honored only under `host_fallback`, and even
 * an opted-in terminal must never receive the server's own environment.
 *
 * These tests drive the REAL (patched) acpx runtime with a fake ACP agent that
 * issues `terminal/create` back to the client.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpxEngineExecutor,
  projectAcpxInheritedHostEnvironment,
  resolveAcpxClientTerminal,
} from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

// Sentinel server secrets. Values are fake; tests assert neither the key names
// (in the terminal child env) nor the values (anywhere) leak.
const SENTINELS: Record<string, string> = {
  DATABASE_URL: "postgres://sentinel-db-7095-value@db.invalid/paperclip",
  BETTER_AUTH_SECRET: "sentinel-better-auth-7095-value",
  PAPERCLIP_SECRETS_MASTER_KEY: "sentinel-master-key-7095-value",
  ANTHROPIC_API_KEY: "sentinel-anthropic-7095-value",
  GITHUB_TOKEN: "sentinel-github-7095-value",
};

// A fake ACP agent: records the advertised terminal capability, then on
// session/prompt asks the client to run a terminal command that reports which
// sentinel env names it can see (names only, never values) plus a positive
// control from the explicit terminal env.
const FAKE_AGENT = String.raw`
import { createInterface } from "node:readline";
let nextId = 1000;
const pending = new Map();
let terminalCapability = null;
function write(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function request(method, params) {
  const id = nextId++;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
const SENTINEL_NAMES = ${JSON.stringify(Object.keys(SENTINELS))};
async function prompt(params) {
  const report = { terminalCapability, agentSeesSentinels: SENTINEL_NAMES.filter((k) => k in process.env) };
  const script = "const n=" + JSON.stringify(SENTINEL_NAMES) + ";console.log(JSON.stringify({leaked:n.filter(k=>k in process.env),explicit:process.env.PAPERCLIP_TERMINAL_EXPLICIT??null,hasPath:typeof process.env.PATH==='string'}))";
  const created = await request("terminal/create", {
    sessionId: params.sessionId,
    command: process.execPath,
    args: ["-e", script],
    env: [{ name: "PAPERCLIP_TERMINAL_EXPLICIT", value: "explicit-ok" }],
  });
  if (created.error) {
    report.create = "refused";
    report.createError = String(created.error.message ?? "");
  } else {
    report.create = "ok";
    const terminalId = created.result.terminalId;
    await request("terminal/wait_for_exit", { sessionId: params.sessionId, terminalId });
    const output = await request("terminal/output", { sessionId: params.sessionId, terminalId });
    report.child = JSON.parse(String(output.result?.output ?? "{}").trim() || "{}");
    await request("terminal/release", { sessionId: params.sessionId, terminalId });
  }
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "TERMINAL_REPORT " + Buffer.from(JSON.stringify(report)).toString("base64") + " END" },
  } } });
  return { stopReason: "end_turn" };
}
async function handle(message) {
  if (message.method === "initialize") {
    terminalCapability = message.params?.clientCapabilities?.terminal ?? null;
    return { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "fake-terminal-agent", version: "1.0.0" } };
  }
  if (message.method === "session/new") return { sessionId: "fake-terminal-session" };
  if (message.method === "session/prompt") return await prompt(message.params);
  if (["session/close", "session/set_mode", "session/set_config_option"].includes(message.method)) return {};
  if (message.method === "session/cancel") return null;
  throw new Error("Unsupported ACP method: " + message.method);
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
    return;
  }
  try {
    const result = await handle(message);
    if (message.id !== undefined && result !== null) write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
});
`;

type TerminalReport = {
  terminalCapability: boolean | null;
  agentSeesSentinels: string[];
  create: "ok" | "refused";
  createError?: string;
  child?: { leaked: string[]; explicit: string | null; hasPath: boolean };
};

const POLICY_ENV = "PAPERCLIP_AGENT_AUTH_POLICY";
const tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [POLICY_ENV, ...Object.keys(SENTINELS)]) savedEnv[key] = process.env[key];
  Object.assign(process.env, SENTINELS);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function runFakeTerminalAgent(input: {
  policy: "managed_only" | "managed_only_report" | "host_fallback";
  acpxClientTerminal?: boolean;
}): Promise<{ report: TerminalReport; transcript: string }> {
  process.env[POLICY_ENV] = input.policy;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-terminal-isolation-"));
  tempRoots.push(root);
  const agentPath = path.join(root, "fake-terminal-agent.mjs");
  await fs.writeFile(agentPath, FAKE_AGENT, "utf8");
  const logs: string[] = [];
  const execute = createAcpxEngineExecutor();
  const result = await execute({
    runId: `terminal-isolation-${input.policy}-${input.acpxClientTerminal === true}`,
    agent: { id: "terminal-agent", companyId: "terminal-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(agentPath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      ...(input.acpxClientTerminal !== undefined ? { acpxClientTerminal: input.acpxClientTerminal } : {}),
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);
  const transcript = `${logs.join("\n")}\n${JSON.stringify(result)}`;
  const match = /TERMINAL_REPORT ([A-Za-z0-9+/=]+) END/.exec(logs.join("\n"));
  expect(match, transcript.slice(0, 4000)).not.toBeNull();
  const report = JSON.parse(Buffer.from(match![1]!, "base64").toString("utf8")) as TerminalReport;
  return { report, transcript };
}

function expectNoSentinelValues(text: string) {
  for (const value of Object.values(SENTINELS)) expect(text.includes(value)).toBe(false);
}

describe("resolveAcpxClientTerminal (TECH-7095 D9)", () => {
  it("is off by default under every policy", () => {
    for (const policy of ["managed_only", "managed_only_report", "host_fallback"] as const) {
      expect(resolveAcpxClientTerminal({}, policy)).toBe(false);
      expect(resolveAcpxClientTerminal({ acpxClientTerminal: "true" }, policy)).toBe(false);
    }
  });

  it("honors acpxClientTerminal: true only under host_fallback", () => {
    expect(resolveAcpxClientTerminal({ acpxClientTerminal: true }, "host_fallback")).toBe(true);
    expect(resolveAcpxClientTerminal({ acpxClientTerminal: true }, "managed_only")).toBe(false);
    expect(resolveAcpxClientTerminal({ acpxClientTerminal: true }, "managed_only_report")).toBe(false);
  });
});

describe("ACP client terminal isolation against the real acpx runtime", () => {
  it("advertises terminal=false and refuses terminal/create by default under managed_only", async () => {
    const { report, transcript } = await runFakeTerminalAgent({ policy: "managed_only" });
    expect(report.terminalCapability).toBe(false);
    expect(report.create).toBe("refused");
    expect(report.child).toBeUndefined();
    expect(report.agentSeesSentinels).toEqual([]);
    expectNoSentinelValues(transcript);
  }, 60_000);

  it("ignores acpxClientTerminal: true under managed_only", async () => {
    const { report, transcript } = await runFakeTerminalAgent({ policy: "managed_only", acpxClientTerminal: true });
    expect(report.terminalCapability).toBe(false);
    expect(report.create).toBe("refused");
    expectNoSentinelValues(transcript);
  }, 60_000);

  it("keeps the terminal off by default under host_fallback too", async () => {
    const { report, transcript } = await runFakeTerminalAgent({ policy: "host_fallback" });
    expect(report.terminalCapability).toBe(false);
    expect(report.create).toBe("refused");
    expectNoSentinelValues(transcript);
  }, 60_000);

  it("honors the opt-in under host_fallback without handing the terminal the server env", async () => {
    const { report, transcript } = await runFakeTerminalAgent({ policy: "host_fallback", acpxClientTerminal: true });
    expect(report.terminalCapability).toBe(true);
    expect(report.create).toBe("ok");
    // Positive control: the terminal ran and saw its explicit env and a PATH.
    expect(report.child?.explicit).toBe("explicit-ok");
    expect(report.child?.hasPath).toBe(true);
    // Negative: none of the server's secrets reached the terminal child.
    expect(report.child?.leaked).toEqual([]);
    expectNoSentinelValues(transcript);
  }, 60_000);
});

describe("patched acpx terminal env construction", () => {
  const patchFiles = ["acpx@0.12.0.patch", "acpx@0.13.1.patch"];

  it.each(patchFiles)("%s rebuilds toEnvObject without spreading process.env", async (name) => {
    const patch = await fs.readFile(path.join(repoRoot, "patches", name), "utf8");
    expect(patch).toContain("-\tconst merged = { ...process.env };");
    expect(patch).toContain("+function toEnvObject(env, baseEnv) {");
    expect(patch).toContain("+\tconst merged = { ...baseEnv ?? {} };");
    expect(patch).toContain('+\t\t\tif (!this.enabled) throw new PermissionDeniedError(');
    expect(patch).toContain("terminal: this.options.terminal === true");
  });

  it("the installed acpx 0.12.0 dist carries the patched toEnvObject", async () => {
    const runtimeEntry = fileURLToPath(import.meta.resolve("acpx/runtime"));
    const distDir = path.dirname(runtimeEntry);
    const entries = (await fs.readdir(distDir)).filter((entry) => /^live-checkpoint-.*\.js$/.test(entry));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const source = await fs.readFile(path.join(distDir, entry), "utf8");
      const start = source.indexOf("function toEnvObject(");
      if (start < 0) continue;
      const body = source.slice(start, source.indexOf("\n}\n", start));
      expect(body).not.toContain("...process.env");
      expect(body).toContain("baseEnv");
      const spawnOptions = source.slice(
        source.indexOf("function buildTerminalSpawnOptions("),
        source.indexOf("function trimToUtf8Boundary("),
      );
      expect(spawnOptions).not.toContain("process.env");
    }
  });
});

describe("host home is not projected under managed_only (TECH-7095)", () => {
  it("drops HOME/XDG_*/CODEX_HOME from the host projection only when enforced", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/Users/server",
      XDG_CONFIG_HOME: "/Users/server/.config",
      CODEX_HOME: "/Users/server/.codex",
      LANG: "en_US.UTF-8",
      ...SENTINELS,
    };
    expect(projectAcpxInheritedHostEnvironment(host, "codex", true, "managed_only")).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
    });
    const legacy = projectAcpxInheritedHostEnvironment(host, "codex", true, "host_fallback");
    expect(legacy.HOME).toBe("/Users/server");
    for (const key of Object.keys(SENTINELS)) expect(legacy[key]).toBeUndefined();
  });

  it("never seeds the managed Codex home from the server $HOME/.codex under managed_only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-codex-home-"));
    tempRoots.push(root);
    const serverHome = path.join(root, "server-home");
    await fs.mkdir(path.join(serverHome, ".codex"), { recursive: true });
    const hostAuth = "sentinel-host-codex-auth-7095-value";
    await fs.writeFile(path.join(serverHome, ".codex", "auth.json"), JSON.stringify({ token: hostAuth }));
    const saved = {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
    };
    process.env.HOME = serverHome;
    delete process.env.CODEX_HOME;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env[POLICY_ENV] = "managed_only";
    const runtimeOptions: Record<string, unknown>[] = [];
    const meta: Record<string, unknown>[] = [];
    const logs: string[] = [];
    try {
      const execute = createAcpxEngineExecutor({
        createRuntime: (options) => {
          runtimeOptions.push(options as unknown as Record<string, unknown>);
          return {
            ensureSession: async () => ({
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            }),
            startTurn: () => ({
              events: (async function* () {
                yield { type: "done", stopReason: "end_turn" };
              })(),
              result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
              cancel: async () => {},
            }),
            setConfigOption: async () => {},
            close: async () => {},
          } as never;
        },
      });
      const result = await execute({
        runId: "codex-home-managed-only",
        agent: { id: "agent-1", companyId: "company-7095" },
        runtime: {},
        config: { agent: "codex", cwd: root, stateDir: path.join(root, "state"), acpxClientTerminal: true },
        context: {},
        onLog: async (_stream: string, text: string) => logs.push(text),
        onMeta: async (entry: Record<string, unknown>) => meta.push(entry),
      } as never);
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(runtimeOptions[0]?.terminal).toBe(false);
      const managedHome = path.join(root, "paperclip-home", "instances", "default", "companies", "company-7095", "codex-home");
      await expect(fs.lstat(path.join(managedHome, "auth.json"))).rejects.toThrow();
      const transcript = `${logs.join("\n")}\n${JSON.stringify(meta)}\n${JSON.stringify(result)}`;
      expect(transcript).not.toContain("seeded from");
      expect(transcript).not.toContain(serverHome);
      expect(transcript.includes(hostAuth)).toBe(false);
      expectNoSentinelValues(transcript);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
