/**
 * TECH-7895: Router launch binding across the real process boundary. No child process, probe or
 * launcher resolver is mocked: execute() binds the launcher, the real registry probe inspects it and
 * the real runChildProcess launches it. The synthetic Hermes CLI only records how it was launched;
 * it performs no inference and never uses a credential.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";
import { createFakeHermesInstall } from "./test-support/fake-hermes-install.js";

const ROUTER_KEY = "rr-launch-binding-test-key-7895-abcdefghij";
const ENV_KEYS = ["PAPERCLIP_HERMES_HOST_ISOLATION", "PAPERCLIP_HERMES_COMMAND_SCAN", "HOME", "HERMES_HOME", "TMPDIR"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root: string;
let serverCwd: string;

const RECORDING_MAIN = (capture: string) =>
  [
    "import json, os, sys",
    "def main():",
    `    open(${JSON.stringify(capture)}, 'w').write(json.dumps({`,
    "        'argv0': os.path.realpath(sys.argv[0]), 'cwd': os.getcwd(), 'path': os.environ.get('PATH'),",
    "        'launcher_dir': sys.path[0]}))",
    "    return 0",
    "",
  ].join("\n");

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-router-launch-")));
  const hostHome = path.join(root, "host-home");
  await fs.mkdir(path.join(hostHome, ".hermes"), { recursive: true });
  process.env.HOME = hostHome;
  process.env.HERMES_HOME = path.join(hostHome, ".hermes");
  process.env.TMPDIR = root;
  process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "false";
  process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  serverCwd = path.join(root, "server-cwd");
  await fs.mkdir(serverCwd, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

function routerCtx(runCwd: string, agentPath: string, logs: string[]): AdapterExecutionContext {
  return {
    runId: "run-router-launch",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      hermesCommand: "hermes",
      provider: "router",
      model: "auto-jev-routing",
      cwd: runCwd,
      timeoutSec: 30,
      graceSec: 2,
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, PATH: agentPath },
    },
    context: { issueId: "issue-1", wakeReason: "manual" },
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      logs.push(chunk);
    },
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

async function installs(relativeSupported: boolean) {
  const runCwd = path.join(root, "run-cwd");
  const rel = await createFakeHermesInstall(path.join(runCwd, "rel"), relativeSupported ? {} : { profile: null, auth: null });
  const abs = await createFakeHermesInstall(path.join(root, "abs"), relativeSupported ? { profile: null, auth: null } : {});
  const capture = path.join(root, "launched.json");
  for (const install of [rel, abs]) {
    await fs.writeFile(path.join(install.srcRoot, "hermes_cli", "main.py"), RECORDING_MAIN(capture));
  }
  // A decoy relative to the SERVER cwd that a server-cwd-based lookup would find instead.
  const decoy = await createFakeHermesInstall(path.join(serverCwd, "rel"));
  await fs.writeFile(path.join(decoy.srcRoot, "hermes_cli", "main.py"), RECORDING_MAIN(capture));
  return { runCwd, rel, abs, capture, agentPath: `rel/bin:${abs.binDir}:/usr/bin:/bin:` };
}

describe("Router launch binding (real probe, real child process)", () => {
  it("probes and executes the relative-first launcher from the run cwd with the normalized PATH", async () => {
    const { runCwd, rel, capture, agentPath } = await installs(true);
    const previous = process.cwd();
    process.chdir(serverCwd);
    const logs: string[] = [];
    try {
      const result = await execute(routerCtx(runCwd, agentPath, logs));
      expect(result.exitCode).toBe(0);
    } finally {
      process.chdir(previous);
    }
    const launched = JSON.parse(await fs.readFile(capture, "utf8")) as Record<string, string>;
    expect(launched.argv0).toBe(rel.command);
    expect(launched.launcher_dir).toBe(rel.binDir);
    expect(launched.cwd).toBe(runCwd);
    expect(launched.path).toBe(`${rel.binDir}:${path.join(root, "abs", "bin")}:/usr/bin:/bin:${runCwd}`);
    expect(logs.join("")).toContain("Ramp Router provider verified");
    expect(logs.join("")).not.toContain(ROUTER_KEY);
  });

  it("refuses before launch when the relative-first launcher lacks Router, despite a capable absolute fallback", async () => {
    const { runCwd, capture, agentPath } = await installs(false);
    const previous = process.cwd();
    process.chdir(serverCwd);
    try {
      await expect(execute(routerCtx(runCwd, agentPath, []))).rejects.toThrow(/does not provide the native Ramp Router provider/);
    } finally {
      process.chdir(previous);
    }
    await expect(fs.access(capture)).rejects.toThrow();
  });
});
