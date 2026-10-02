/**
 * TECH-7095: under the enforced managed-only auth policy the Cursor execute/skills paths must
 * never reach for the server user's home or host credentials; under host_fallback the legacy
 * behaviour stays.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { AgentAuthPolicyError } from "@paperclipai/adapter-utils/agent-auth-policy";

const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "agent"),
    runAdapterExecutionTargetProcess: runProcessMock,
    startAdapterExecutionTargetPaperclipBridge: async () => null,
  };
});

import { execute } from "./execute.js";
import { listCursorSkills, syncCursorSkills } from "./skills.js";

const HOST_SECRET = "sentinel-host-cursor-secret-7095";
const HOST_FILE_SECRET = "sentinel-host-cursor-file-7095";
const SENTINELS = [HOST_SECRET, HOST_FILE_SECRET];

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PAPERCLIP_AGENT_AUTH_POLICY", "HOME", "CURSOR_API_KEY", "OPENAI_API_KEY", "XDG_CONFIG_HOME"];
const tempRoots: string[] = [];

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out.sort();
}

let fakeHostHome = "";

async function makeFakeHostHome() {
  const home = await tempDir("paperclip-fake-host-home-");
  await fs.mkdir(path.join(home, ".cursor", "skills"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "cli-config.json"), JSON.stringify({ token: HOST_FILE_SECRET }));
  await fs.mkdir(path.join(home, ".config", "cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".config", "cursor", "auth.json"), JSON.stringify({ token: HOST_FILE_SECRET }));
  return home;
}

function makeContext(config: Record<string, unknown>, logs: string[]): AdapterExecutionContext {
  return {
    runId: "run-auth-policy",
    agent: { id: "agent-1", companyId: "company-1", name: "Cursor", adapterType: "cursor", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    authToken: "run-token",
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  };
}

function okProcess() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ type: "result", subtype: "success", session_id: "s-1", result: "ok" }),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  fakeHostHome = await makeFakeHostHome();
  process.env.HOME = fakeHostHome;
  process.env.XDG_CONFIG_HOME = path.join(fakeHostHome, ".config");
  process.env.CURSOR_API_KEY = HOST_SECRET;
  process.env.OPENAI_API_KEY = HOST_SECRET;
  vi.spyOn(os, "homedir").mockReturnValue(fakeHostHome);
  runProcessMock.mockReset();
  runProcessMock.mockImplementation(async () => okProcess());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempRoots.length > 0) {
    await fs.rm(tempRoots.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("cursor execute under managed_only", () => {
  it("uses only the supplied child HOME and never touches host home or host keys", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const before = await listTree(fakeHostHome);
    const runHome = await tempDir("paperclip-run-home-test-");
    const cwd = await tempDir("paperclip-cursor-cwd-");
    const logs: string[] = [];

    const result = await execute(makeContext({ cwd, command: "agent", env: { HOME: runHome } }, logs));

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    const [, , , args, opts] = runProcessMock.mock.calls[0] as [string, unknown, string, string[], { env: Record<string, string> }];
    expect(opts.env.HOME).toBe(runHome);
    expect(opts.env.CURSOR_API_KEY).toBeUndefined();
    expect(opts.env.OPENAI_API_KEY).toBeUndefined();
    // Host keys are not an auth/billing signal.
    // TECH-7095: no explicit key bound and no host login to infer from => unknown billing.
    expect(result.billingType).toBe("unknown");
    const serialized = JSON.stringify({ args, env: opts.env, logs, result });
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(fakeHostHome);
    // Skills (if any) were linked into the run home, never the host home.
    expect(await listTree(fakeHostHome)).toEqual(before);
    const runSkills = await fs.readdir(path.join(runHome, ".cursor", "skills"));
    expect(runSkills.length).toBeGreaterThan(0);
  });

  it("refuses before spawn when no isolated child HOME is supplied", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const before = await listTree(fakeHostHome);
    const cwd = await tempDir("paperclip-cursor-cwd-");
    const logs: string[] = [];

    const error = await execute(makeContext({ cwd, command: "agent" }, logs)).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AgentAuthPolicyError);
    expect((error as AgentAuthPolicyError).code).toBe("agent_home_isolation_required");
    expect(runProcessMock).not.toHaveBeenCalled();
    const serialized = JSON.stringify({ message: (error as Error).message, details: (error as AgentAuthPolicyError).details, logs });
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
    expect(await listTree(fakeHostHome)).toEqual(before);
  });

  it("skills list/sync never read or write the host home without a child HOME", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const before = await listTree(fakeHostHome);
    const listed = await listCursorSkills({ agentId: "a", companyId: "c", adapterType: "cursor", config: {} });
    const synced = await syncCursorSkills({ agentId: "a", companyId: "c", adapterType: "cursor", config: {} }, ["paperclip"]);
    expect(await listTree(fakeHostHome)).toEqual(before);
    for (const snapshot of [listed, synced]) {
      expect(JSON.stringify(snapshot)).not.toContain(fakeHostHome);
      expect(snapshot.warnings.join("\n")).toContain("isolated home");
    }
  });
});

describe("cursor execute under host_fallback", () => {
  it("keeps the legacy host-home skills location when no child HOME is configured", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const cwd = await tempDir("paperclip-cursor-cwd-");
    const logs: string[] = [];

    await execute(makeContext({ cwd, command: "agent" }, logs));

    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(path.join(fakeHostHome, ".cursor", "skills"))).length).toBeGreaterThan(0);
    const listed = await listCursorSkills({ agentId: "a", companyId: "c", adapterType: "cursor", config: {} });
    expect(listed.entries.every((entry) => !entry.targetPath || entry.targetPath.startsWith(path.join(fakeHostHome, ".cursor", "skills")))).toBe(true);
    expect(listed.warnings.join("\n")).not.toContain("isolated home");
  });
});
