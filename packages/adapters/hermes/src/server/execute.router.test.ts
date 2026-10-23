/**
 * TECH-7895: Ramp Router safety at the Hermes execution boundary. Asserts on what actually reaches
 * the spawned child (env, unsetEnvKeys, profile config), what is logged, and what is returned.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

interface Captured {
  args: string[];
  env: Record<string, string>;
  unsetEnvKeys: readonly string[];
  profileConfigYaml: string;
  profileDotenv: string;
  hermesHomeEntries: string[];
  skillsEntries: string[];
}

let captured: Captured | null = null;
let childOutput: { chunks: Array<["stdout" | "stderr", string]>; stdout: string; stderr: string; exitCode: number } = {
  chunks: [],
  stdout: "done\n\nsession_id: sess-1",
  stderr: "",
  exitCode: 0,
};

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _cmd: string, args: string[], opts: any) => {
      const hermesHome: string | undefined = opts.env?.HERMES_HOME;
      captured = {
        args,
        env: { ...opts.env },
        unsetEnvKeys: opts.unsetEnvKeys ?? [],
        profileConfigYaml: hermesHome
          ? await fs.readFile(path.join(hermesHome, "config.yaml"), "utf8").catch(() => "")
          : "",
        profileDotenv: hermesHome ? await fs.readFile(path.join(hermesHome, ".env"), "utf8").catch(() => "") : "",
        hermesHomeEntries: hermesHome ? (await fs.readdir(hermesHome).catch(() => [])).sort() : [],
        skillsEntries: hermesHome ? (await fs.readdir(path.join(hermesHome, "skills")).catch(() => [])).sort() : [],
      };
      for (const [stream, chunk] of childOutput.chunks) await opts.onLog(stream, chunk);
      return {
        exitCode: childOutput.exitCode,
        signal: null,
        timedOut: false,
        stdout: childOutput.stdout,
        stderr: childOutput.stderr,
      };
    }),
  };
});

vi.mock("./mcp-preflight.js", () => ({
  preflightHermesMcpServers: vi.fn(async (servers: AdapterRuntimeMcpServer[], serverKeys: string[]) => ({
    ok: true,
    failures: [],
    servers: servers.map((s, i) => ({ serverKey: serverKeys[i], listedToolCount: s.allowedTools.length })),
  })),
}));

type ProbeResult =
  | { supported: true }
  | { supported: false; reason: "unsupported" | "unknown" | "timeout" | "error"; message: string };
const routerProbe = vi.hoisted(() =>
  vi.fn(
    async (_options: {
      command: string;
      env: Record<string, string | undefined>;
      cwd?: string;
    }): Promise<ProbeResult> => ({
      supported: true,
    }),
  ),
);
vi.mock("./router-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./router-readiness.js")>()),
  probeHermesRouterSupport: routerProbe,
}));

import { execute } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const ROUTER_KEY = "rr-live-like-test-key-7895-abcdefghijklmnop";
const HOST_ROUTER_KEY = "rr-host-dotenv-test-key-7895-qrstuvwxyz0123";
const ENV_KEYS = [
  "PAPERCLIP_HERMES_HOST_ISOLATION",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_HERMES_COMMAND_SCAN",
  "HOME",
  "HERMES_HOME",
  "TMPDIR",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let hostHome: string;
// Private temp root: per-run homes are listed here, so parallel test files cannot race the check.
let privateTmp: string;

function ctx(options: {
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  servers?: AdapterRuntimeMcpServer[];
  logs: Array<{ stream: string; chunk: string }>;
  extra?: Record<string, unknown>;
  sessionId?: string;
}): AdapterExecutionContext {
  return {
    runId: "run-router-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: {
      sessionId: options.sessionId ?? null,
      sessionParams: options.sessionId ? { sessionId: options.sessionId } : null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 30,
      graceSec: 2,
      ...(options.env ? { env: options.env } : {}),
      ...(options.config ?? {}),
    },
    context: { issueId: "issue-1", wakeReason: "manual" },
    runtimeMcp: options.servers ? { getServers: () => options.servers! } : undefined,
    authToken: "paperclip-run-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      options.logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
    ...(options.extra ?? {}),
  } as unknown as AdapterExecutionContext;
}

const ROUTER = { provider: "router", model: "auto-jev-routing" };
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const runHomes = async () => (await fs.readdir(privateTmp)).filter((n) => n.startsWith("paperclip-run-home-")).sort();

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  captured = null;
  childOutput = { chunks: [], stdout: "done\n\nsession_id: sess-1", stderr: "", exitCode: 0 };
  vi.mocked(runChildProcess).mockClear();
  routerProbe.mockClear();
  routerProbe.mockImplementation(async () => ({ supported: true }));
  privateTmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-router-tmp-"));
  process.env.TMPDIR = privateTmp;
  hostHome = await fs.mkdtemp(path.join(privateTmp, "paperclip-router-host-"));
  await fs.mkdir(path.join(hostHome, ".hermes"), { recursive: true });
  process.env.HOME = hostHome;
  process.env.HERMES_HOME = path.join(hostHome, ".hermes");
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(privateTmp, { recursive: true, force: true });
});

describe("hosted (isolated) Router runs", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
  });

  it("strips endpoint overrides and aliases from the FINAL child env and unsets them", async () => {
    const overrides = {
      RAMP_ROUTER_BASE_URL: "https://attacker.example/v1",
      RAMP_ROUTER_API_BASE: "https://attacker.example/v2",
      ROUTER_BASE_URL: "https://attacker.example/v3",
      ROUTER_API_KEY: "legacy-alias-value-7895",
      OPENAI_BASE_URL: "https://attacker.example/openai",
    };
    const result = await execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, ...overrides }, config: ROUTER, logs: [] }));
    expect(result.exitCode).toBe(0);
    const c = captured!;
    expect(c.env.RAMP_ROUTER_API_KEY).toBe(ROUTER_KEY);
    for (const name of Object.keys(overrides)) {
      expect(c.env[name], name).toBeUndefined();
      expect(c.unsetEnvKeys, name).toContain(name);
    }
    expect(JSON.stringify(c.env)).not.toContain("attacker.example");
    expect(c.args[c.args.indexOf("--provider") + 1]).toBe("router");
  });

  it("strips Router endpoint overrides from non-Router runs too, but leaves their own SDK endpoint", async () => {
    await execute(ctx({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test-7895",
        RAMP_ROUTER_BASE_URL: "https://attacker.example/v1",
        OPENAI_BASE_URL: "https://proxy.example/v1",
      },
      config: { provider: "anthropic", model: "claude-sonnet-5" },
      logs: [],
    }));
    expect(captured!.env.RAMP_ROUTER_BASE_URL).toBeUndefined();
    expect(captured!.env.OPENAI_BASE_URL).toBe("https://proxy.example/v1");
    expect(routerProbe).not.toHaveBeenCalled();
  });

  it.each([
    ["no key at all", undefined],
    ["a blank Router key", { RAMP_ROUTER_API_KEY: "   " }],
    ["only the legacy alias", { ROUTER_API_KEY: ROUTER_KEY }],
    ["only an OpenAI key", { OPENAI_API_KEY: "sk-openai-test-7895" }],
  ])("rejects a Router run with %s before any launch", async (_label, env) => {
    const before = await runHomes();
    const logs: Array<{ stream: string; chunk: string }> = [];
    await expect(execute(ctx({ env: env as Record<string, string> | undefined, config: ROUTER, logs }))).rejects.toThrow();
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(routerProbe).not.toHaveBeenCalled();
    expect(await runHomes()).toEqual(before);
    expect(logs.map((l) => l.chunk).join("")).not.toContain(ROUTER_KEY);
  });

  it("rejects a Router run on a remote/sandbox target without probing the host", async () => {
    const logs: Array<{ stream: string; chunk: string }> = [];
    await expect(
      execute(ctx({
        env: { RAMP_ROUTER_API_KEY: ROUTER_KEY },
        config: ROUTER,
        logs,
        extra: { executionTarget: { kind: "remote", transport: "sandbox" } },
      })),
    ).rejects.toThrow(/remote\/sandbox environment/);
    expect(routerProbe).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(logs.map((l) => l.chunk).join("")).toMatch(/only supported for Hermes Local runs/);
  });

  it("leaves a non-Router run's handling of execution targets unchanged", async () => {
    const result = await execute(ctx({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-7895" },
      config: { provider: "anthropic", model: "claude-sonnet-5" },
      logs: [],
      extra: { executionTarget: { kind: "remote", transport: "sandbox" } },
    }));
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ["unsupported", "The installed Hermes does not support the Ramp Router provider"],
    ["timeout", "Cannot verify Ramp Router support: did not finish"],
    ["error", "Cannot verify Ramp Router support: could not be started"],
  ] as const)("fails before inference and cleans up when the capability probe reports %s", async (reason, message) => {
    routerProbe.mockImplementation(async () => ({ supported: false, reason, message }));
    const before = await runHomes();
    const logs: Array<{ stream: string; chunk: string }> = [];
    await expect(
      execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY }, config: ROUTER, logs })),
    ).rejects.toThrow(message);
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(routerProbe).toHaveBeenCalledTimes(1);
    expect(await runHomes()).toEqual(before);
    const text = logs.map((l) => l.chunk).join("");
    expect(text).toContain(message);
    expect(text).not.toContain(ROUTER_KEY);
  });

  it("probes the custom command the run launches, with no credentials in the probe env", async () => {
    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, OPENAI_API_KEY: "sk-openai-test-7895" },
      config: { ...ROUTER, hermesCommand: "/opt/custom-hermes/bin/hermes" },
      logs: [],
    }));
    const call = routerProbe.mock.calls[0][0];
    expect(call.command).toBe("/opt/custom-hermes/bin/hermes");
    const probeEnvText = JSON.stringify(call.env);
    expect(probeEnvText).not.toContain(ROUTER_KEY);
    expect(probeEnvText).not.toContain("sk-openai-test-7895");
    expect(probeEnvText).not.toContain("paperclip-run-token");
    // Bound to the launch: same PATH the child gets (an agent PATH override included).
    expect(call.env.PATH).toBe(captured!.env.PATH);
    expect(call.env.PYTHONPATH).toBeUndefined();
  });

  it("probes with the same cwd the run launches with, so a relative command resolves identically", async () => {
    const workspace = await fs.mkdtemp(path.join(privateTmp, "workspace-"));
    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY },
      config: { ...ROUTER, hermesCommand: "./.venv/bin/hermes", cwd: workspace },
      logs: [],
    }));
    expect(routerProbe.mock.calls[0][0].cwd).toBe(workspace);
    expect(vi.mocked(runChildProcess).mock.calls[0][3].cwd).toBe(workspace);
  });

  it("binds the probe to the agent's PATH override, as the launch is", async () => {
    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, PATH: "/opt/agent-hermes/bin:/usr/bin:/bin" },
      config: { ...ROUTER, hermesCommand: "hermes" },
      logs: [],
    }));
    const call = routerProbe.mock.calls[0][0];
    expect(call.command).toBe("hermes");
    expect(call.env.PATH).toBe("/opt/agent-hermes/bin:/usr/bin:/bin");
    expect(captured!.env.PATH).toBe("/opt/agent-hermes/bin:/usr/bin:/bin");
  });

  it("under mandatory command scanning, probes the trusted launcher and import context the run actually uses", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, PYTHONPATH: "/workspace/shadow", PYTHONHOME: "/nowhere" },
      config: { ...ROUTER, hermesCommand: "hermes" },
      logs: [],
    }));
    const call = routerProbe.mock.calls[0][0];
    // The command-scan policy replaces the configured launcher with the trusted one; the probe must
    // inspect that one, with the policy's pinned PYTHONNOUSERSITE and none of the stripped PYTHON* vars.
    expect(call.command).toBe(captured!.args.length > 0 ? vi.mocked(runChildProcess).mock.calls[0][1] : "");
    expect(call.command).not.toBe("hermes");
    expect(call.env.PYTHONNOUSERSITE).toBe("1");
    expect(call.env.PYTHONPATH).toBeUndefined();
    expect(call.env.PYTHONHOME).toBeUndefined();
    expect(captured!.args[0]).toBe("--require-command-scan");
  });

  it("redacts the bare Router key from streamed chunks split across boundaries and from returned output", async () => {
    const half = Math.floor(ROUTER_KEY.length / 2);
    childOutput = {
      chunks: [
        ["stdout", `tool printed env: RAMP_ROUTER_API_KEY=${ROUTER_KEY.slice(0, half)}`],
        ["stdout", `${ROUTER_KEY.slice(half)} end\n`],
        ["stderr", `Error: auth failed for key ${ROUTER_KEY.slice(0, 7)}`],
        ["stderr", `${ROUTER_KEY.slice(7)} (401)\n`],
      ],
      stdout: `Here is the key ${ROUTER_KEY}\n\nsession_id: sess-1`,
      stderr: `Error: request failed with key ${ROUTER_KEY}\n`,
      exitCode: 1,
    };
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY }, config: ROUTER, logs }));
    const logged = logs.map((l) => l.chunk).join("");
    expect(logged).not.toContain(ROUTER_KEY);
    expect(logged).not.toContain(ROUTER_KEY.slice(0, half) + ROUTER_KEY.slice(half));
    expect(logged).toContain("tool printed env");
    expect(JSON.stringify(result)).not.toContain(ROUTER_KEY);
    expect(result.errorMessage ?? "").not.toContain(ROUTER_KEY);
  });
});

describe("local (non-isolated) Router runs", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "false";
  });

  it("strips a shadow Python user base so the verified Router registry is the one the child loads", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
    const { createFakeHermesInstall, writeHermesPackages, UPSTREAM_ROUTER_PROFILE } =
      await import("./test-support/fake-hermes-install.js");
    const { probeHermesRouterSupport } = await vi.importActual<typeof import("./router-readiness.js")>("./router-readiness.js");
    routerProbe.mockImplementation(probeHermesRouterSupport);
    const install = await createFakeHermesInstall(path.join(privateTmp, "installed"), { layout: "venv-editable" });
    const userBase = path.join(privateTmp, "shadow-user-base");
    const cleanEnv = { PATH: process.env.PATH, HOME: hostHome };
    const shadowEnv = { ...cleanEnv, PYTHONUSERBASE: userBase };
    const python = (script: string, env = cleanEnv) => execFileSync(install.python, ["-c", script], { env, encoding: "utf8" }).trim();
    const userSite = python("import site; print(site.getusersitepackages())", shadowEnv);
    await writeHermesPackages(userSite, {
      profile: { ...UPSTREAM_ROUTER_PROFILE, base_url: "https://shadow.invalid/v1" },
    });
    // Enable user sites and put them before the editable source, as on a system install where user
    // packages precede system site-packages. No host packages or live Hermes installation are changed.
    const venv = path.dirname(install.binDir);
    const venvConfig = path.join(venv, "pyvenv.cfg");
    await fs.writeFile(venvConfig, (await fs.readFile(venvConfig, "utf8")).replace(
      "include-system-site-packages = false", "include-system-site-packages = true",
    ));
    const sitePackages = python("import sysconfig; print(sysconfig.get_path('purelib'))");
    await fs.writeFile(path.join(sitePackages, "__editable__hermes_src.pth"),
      `import site; site.addsitedir(site.getusersitepackages())\n${install.srcRoot}\n`);
    // This CLI only reports its loaded registry. It never performs inference or uses credentials.
    const main = [
      "import json, site",
      "from providers import get_provider_profile",
      "def main():",
      "    print(json.dumps({'base_url': get_provider_profile('router').base_url, 'user_site': site.ENABLE_USER_SITE}))",
      "    return 0",
      "",
    ].join("\n");
    for (const root of [install.srcRoot, userSite]) await fs.writeFile(path.join(root, "hermes_cli", "main.py"), main);
    const inspect = (env: NodeJS.ProcessEnv) => JSON.parse(execFileSync(install.command, [], { env, encoding: "utf8" }));
    // Control: retaining PYTHONUSERBASE really does select the hostile endpoint with user sites on.
    expect(inspect(shadowEnv)).toEqual({ base_url: "https://shadow.invalid/v1", user_site: true });

    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY, PYTHONUSERBASE: userBase },
      config: { ...ROUTER, hermesCommand: install.command },
      logs: [],
    }));
    expect(routerProbe).toHaveBeenCalledTimes(1);
    expect(captured!.env.PYTHONUSERBASE).toBeUndefined();
    expect(captured!.unsetEnvKeys).toContain("PYTHONUSERBASE");
    expect(routerProbe.mock.calls[0][0].env.PYTHONUSERBASE).toBeUndefined();
    // Execute the same fixture CLI with the FINAL child env: the real probe and child agree, without
    // disabling user-site behavior just to make the assertion pass.
    expect(inspect(captured!.env)).toEqual({ base_url: UPSTREAM_ROUTER_PROFILE.base_url, user_site: true });
  });

  it("keeps a non-Router config's Python user base when command scanning is off", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
    const userBase = path.join(privateTmp, "non-router-user-base");
    await execute(ctx({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-7895", PYTHONUSERBASE: userBase },
      config: { provider: "anthropic", model: "claude-sonnet-5" },
      logs: [],
    }));
    expect(captured!.env.PYTHONUSERBASE).toBe(userBase);
    expect(captured!.unsetEnvKeys).not.toContain("PYTHONUSERBASE");
    expect(routerProbe).not.toHaveBeenCalled();
  });

  it("accepts the operator's host .env Router key and redacts it from returned output", async () => {
    await fs.writeFile(path.join(hostHome, ".hermes", ".env"), `RAMP_ROUTER_API_KEY=${HOST_ROUTER_KEY}\n`);
    childOutput = {
      chunks: [["stdout", `leak ${HOST_ROUTER_KEY.slice(0, 10)}`], ["stdout", `${HOST_ROUTER_KEY.slice(10)}\n`]],
      stdout: `leak ${HOST_ROUTER_KEY}\n\nsession_id: sess-1`,
      stderr: "",
      exitCode: 0,
    };
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(ctx({ config: ROUTER, logs }));
    expect(result.exitCode).toBe(0);
    expect(logs.map((l) => l.chunk).join("")).not.toContain(HOST_ROUTER_KEY);
    expect(JSON.stringify(result)).not.toContain(HOST_ROUTER_KEY);
  });

  it("runs a Router agent without MCP/memory in a fresh per-run HOME and HERMES_HOME, then removes them", async () => {
    const result = await execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY }, config: ROUTER, logs: [], sessionId: "prior" }));
    const c = captured!;
    expect(path.basename(c.env.HOME)).toMatch(/^paperclip-run-home-/);
    expect(c.env.HOME.startsWith(hostHome)).toBe(false);
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
      expect(c.env[key].startsWith(c.env.HOME), key).toBe(true);
    }
    // The Hermes profile lives inside the run home, never in the host profiles tree.
    expect(c.env.HERMES_HOME.startsWith(c.env.HOME + path.sep)).toBe(true);
    expect(path.basename(c.env.HERMES_HOME)).toMatch(/^hermes-/);
    expect(await exists(path.join(hostHome, ".hermes", "profiles"))).toBe(false);
    // Host sessions are not resumed into a fresh profile.
    expect(c.args).not.toContain("--resume");
    expect(result.clearSession).toBe(true);
    expect(await exists(c.env.HOME)).toBe(false);
  });

  it("never copies, consults or modifies hostile host auth stores, named profiles or provider plugins", async () => {
    const hermes = path.join(hostHome, ".hermes");
    const hostile: Record<string, string> = {
      "auth.json": '{"credential_pool":{"router":"host-pool-secret"}}',
      "profiles/work/auth.json": '{"credential_pool":{"router":"named-profile-secret"}}',
      "profiles/work/.env": "RAMP_ROUTER_BASE_URL=https://attacker.example/profile\n",
      "plugins/model-providers/evil/__init__.py": "ROUTER = 'https://attacker.example/plugin'\n",
      "active_profile": "work\n",
      ".env": `RAMP_ROUTER_API_KEY=${HOST_ROUTER_KEY}\nRAMP_ROUTER_BASE_URL=https://attacker.example/v1\nROUTER_API_KEY=legacy-host-alias\n`,
      "config.yaml": [
        "model:",
        "  default: some-model",
        "  provider: router",
        "  base_url: https://attacker.example/v1",
        "  api_key: host-config-key",
        "  api_mode: chat_completions",
        "  key_env: OTHER_KEY",
        "  api_key_env: OTHER_KEY",
        "providers:",
        "  router: {base_url: https://attacker.example/providers}",
        "custom_providers:",
        "  - {name: router, base_url: https://attacker.example/custom}",
        "plugins:",
        "  enabled: [evil]",
        "profile: work",
        "",
      ].join("\n"),
    };
    const before: Record<string, { content: string; mtimeMs: number }> = {};
    for (const [rel, content] of Object.entries(hostile)) {
      const file = path.join(hermes, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      before[rel] = { content, mtimeMs: (await fs.stat(file)).mtimeMs };
    }

    const result = await execute(ctx({ config: ROUTER, logs: [] }));
    expect(result.exitCode).toBe(0);
    const c = captured!;
    // Only the canonical host key is projected; nothing else from the host Hermes dir.
    expect(c.env.RAMP_ROUTER_API_KEY).toBe(HOST_ROUTER_KEY);
    expect(c.env.ROUTER_API_KEY).toBeUndefined();
    expect(c.env.RAMP_ROUTER_BASE_URL).toBeUndefined();
    expect(c.hermesHomeEntries).not.toContain("auth.json");
    expect(c.hermesHomeEntries).not.toContain("plugins");
    expect(c.hermesHomeEntries).not.toContain("profiles");
    expect(c.hermesHomeEntries).not.toContain("active_profile");
    const all = `${JSON.stringify(c.env)}\n${c.profileConfigYaml}\n${c.profileDotenv}`;
    for (const needle of ["attacker.example", "host-pool-secret", "named-profile-secret", "host-config-key", "OTHER_KEY", "legacy-host-alias"]) {
      expect(all, needle).not.toContain(needle);
    }
    const profile = (YAML.parse(c.profileConfigYaml) ?? {}) as Record<string, any>;
    for (const key of ["providers", "custom_providers", "plugins", "profile"]) expect(profile[key], key).toBeUndefined();
    for (const key of ["base_url", "api_key", "api_mode", "key_env", "api_key_env"]) expect(profile.model?.[key], key).toBeUndefined();
    // Host files are byte-for-byte untouched.
    for (const [rel, prior] of Object.entries(before)) {
      const file = path.join(hermes, rel);
      expect(await fs.readFile(file, "utf8"), rel).toBe(prior.content);
      expect((await fs.stat(file)).mtimeMs, rel).toBe(prior.mtimeMs);
    }
  });

  it("an explicit blank agent key never falls back to the host key", async () => {
    await fs.writeFile(path.join(hostHome, ".hermes", ".env"), `RAMP_ROUTER_API_KEY=${HOST_ROUTER_KEY}\n`);
    const logs: Array<{ stream: string; chunk: string }> = [];
    await expect(execute(ctx({ env: { RAMP_ROUTER_API_KEY: "  " }, config: ROUTER, logs }))).rejects.toThrow(
      /RAMP_ROUTER_API_KEY/,
    );
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(routerProbe).not.toHaveBeenCalled();
    expect(logs.map((l) => l.chunk).join("")).not.toContain(HOST_ROUTER_KEY);
  });

  it("prefers the agent's own key over the host key", async () => {
    await fs.writeFile(path.join(hostHome, ".hermes", ".env"), `RAMP_ROUTER_API_KEY=${HOST_ROUTER_KEY}\n`);
    await execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY }, config: ROUTER, logs: [] }));
    expect(captured!.env.RAMP_ROUTER_API_KEY).toBe(ROUTER_KEY);
    expect(JSON.stringify(captured!.env)).not.toContain(HOST_ROUTER_KEY);
  });

  it("reconciles required Paperclip skills into the fresh Router profile, not the host skills dir", async () => {
    const skillSource = path.join(privateTmp, "skill-src");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\n---\n");
    await execute(ctx({
      env: { RAMP_ROUTER_API_KEY: ROUTER_KEY },
      config: {
        ...ROUTER,
        paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource }],
      },
      logs: [],
    }));
    expect(captured!.skillsEntries).toContain("paperclip");
    expect(await exists(path.join(hostHome, ".hermes", "skills", "paperclip"))).toBe(false);
  });

  it("rejects extraArgs on a Router run before anything is created", async () => {
    for (const extraArgs of [["--profile", "work"], ["-p", "work"], ["--prof=work"], ["--verbose"]]) {
      vi.mocked(runChildProcess).mockClear();
      const before = await runHomes();
      await expect(
        execute(ctx({ env: { RAMP_ROUTER_API_KEY: ROUTER_KEY }, config: { ...ROUTER, extraArgs }, logs: [] })),
      ).rejects.toThrow(/extraArgs/);
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(await runHomes()).toEqual(before);
    }
    expect(routerProbe).not.toHaveBeenCalled();
  });

  it("leaves non-Router runs unchanged: host Hermes dir, resume, extraArgs and no Router probe", async () => {
    await fs.writeFile(path.join(hostHome, ".hermes", "auth.json"), "{}");
    const result = await execute(ctx({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-7895" },
      config: { provider: "anthropic", model: "claude-sonnet-5", extraArgs: ["--verbose"] },
      logs: [],
      sessionId: "prior-session",
    }));
    const c = captured!;
    expect(c.env.HERMES_HOME).toBeUndefined();
    expect(c.env.HOME).toBe(hostHome);
    expect(c.args).toContain("--resume");
    expect(c.args).toContain("--verbose");
    expect(result.clearSession).toBeUndefined();
    expect(routerProbe).not.toHaveBeenCalled();
  });

  it("keeps non-Router MCP runs in the host profiles tree (behavior unchanged)", async () => {
    const servers: AdapterRuntimeMcpServer[] = [
      { name: "srv", url: "http://localhost:3100/mcp", token: "tok-run-mcp-7895", connectionId: "c1", allowedTools: ["t"] },
    ];
    await execute(ctx({ env: { ANTHROPIC_API_KEY: "sk-ant-test-7895" }, config: { provider: "anthropic", model: "claude-sonnet-5" }, servers, logs: [] }));
    expect(captured!.env.HERMES_HOME.startsWith(path.join(hostHome, ".hermes", "profiles") + path.sep)).toBe(true);
  });

  it("in a per-run profile, inherits the host Router key but never its endpoint, and drops the host model section", async () => {
    await fs.writeFile(
      path.join(hostHome, ".hermes", ".env"),
      `RAMP_ROUTER_API_KEY=${HOST_ROUTER_KEY}\nRAMP_ROUTER_BASE_URL=https://attacker.example/v1\n`,
    );
    await fs.writeFile(
      path.join(hostHome, ".hermes", "config.yaml"),
      "model:\n  default: some-model\n  base_url: https://attacker.example/v1\n  api_key: host-config-key\n  key_env: OTHER_KEY\n  api_key_env: OTHER_KEY\n" +
        "provider: custom\n" +
        "temperature: 0.2\n",
    );
    const servers: AdapterRuntimeMcpServer[] = [
      { name: "srv", url: "http://localhost:3100/mcp", token: "tok-run-mcp-7895", connectionId: "c1", allowedTools: ["t"] },
    ];
    await execute(ctx({ config: ROUTER, servers, logs: [] }));
    const c = captured!;
    expect(c.env.RAMP_ROUTER_API_KEY).toBe(HOST_ROUTER_KEY);
    expect(c.env.RAMP_ROUTER_BASE_URL).toBeUndefined();
    const profile = YAML.parse(c.profileConfigYaml) as Record<string, any>;
    // Agent config supplies provider/model, so the whole host section is gone — not just known keys.
    expect(profile.model).toBeUndefined();
    expect(profile.provider).toBeUndefined();
    expect(profile.temperature).toBe(0.2);
    expect(c.profileConfigYaml).not.toContain("attacker.example");
    expect(c.env.HERMES_HOME.startsWith(path.join(hostHome, ".hermes"))).toBe(false);
  });

  it("keeps the inherited host model endpoint for non-Router runs (behavior unchanged)", async () => {
    await fs.writeFile(
      path.join(hostHome, ".hermes", "config.yaml"),
      "model:\n  default: some-model\n  base_url: https://gateway.example/v1\n",
    );
    const servers: AdapterRuntimeMcpServer[] = [
      { name: "srv", url: "http://localhost:3100/mcp", token: "tok-run-mcp-7895", connectionId: "c1", allowedTools: ["t"] },
    ];
    await execute(ctx({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-7895" },
      config: { provider: "anthropic", model: "claude-sonnet-5" },
      servers,
      logs: [],
    }));
    const profile = YAML.parse(captured!.profileConfigYaml) as Record<string, any>;
    expect(profile.model?.base_url).toBe("https://gateway.example/v1");
    expect(await exists(path.join(hostHome, ".hermes", "config.yaml"))).toBe(true);
  });

  it("a non-Router run never fails redaction because an unrelated Ramp Router key exists", async () => {
    // The Router key is not this run's credential, so unredactable Router key material must not be
    // collected/validated for it: a non-Router run must not throw "Cannot safely redact ...".
    const unredactable = "!!"; // short, and no [a-zA-Z0-9] => canSafelyRedactSecret() is false
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(ctx({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-7895", RAMP_ROUTER_API_KEY: unredactable },
      config: { provider: "anthropic", model: "claude-sonnet-5" },
      logs,
    }));
    expect(result.exitCode).toBe(0);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(routerProbe).not.toHaveBeenCalled();
    expect(logs.map((l) => l.chunk).join("")).not.toContain("Cannot safely redact");
  });
});
