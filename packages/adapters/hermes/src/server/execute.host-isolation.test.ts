/**
 * TECH-7102: in an isolated (hosted) deployment a Hermes run never reads the server host's
 * ~/.hermes (.env provider keys, config.yaml, auth.json, skills, profiles); it gets a fresh per-run
 * home and only an explicit provider credential from its own resolved adapter env.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

interface Captured {
  args: string[];
  env: Record<string, string>;
  hermesHome: string | null;
  hermesHomeEntries: string[];
  hermesDotenv: string;
  hermesConfigYaml: string;
  skillsEntries: string[];
}

let captured: Captured | null = null;
let childBehavior: "ok" | "timeout" | "throw" = "ok";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _cmd: string, args: string[], opts: any) => {
      const hermesHome: string | null = opts.env?.HERMES_HOME ?? null;
      const read = (p: string) => fs.readFile(p, "utf8").catch(() => "");
      captured = {
        args,
        env: { ...opts.env },
        hermesHome,
        hermesHomeEntries: hermesHome ? await fs.readdir(hermesHome).catch(() => []) : [],
        hermesDotenv: hermesHome ? await read(path.join(hermesHome, ".env")) : "",
        hermesConfigYaml: hermesHome ? await read(path.join(hermesHome, "config.yaml")) : "",
        skillsEntries: hermesHome ? await fs.readdir(path.join(hermesHome, "skills")).catch(() => []) : [],
      };
      if (childBehavior === "throw") throw new Error("spawn exploded");
      return {
        exitCode: childBehavior === "timeout" ? null : 0,
        signal: null,
        timedOut: childBehavior === "timeout",
        stdout: "done\n\nsession_id: sess-1",
        stderr: "",
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

import { execute } from "./execute.js";
import { detectModel } from "./detect-model.js";
import {
  hasExplicitHermesProviderCredential,
  hermesHostIsolationEnabled,
  isHermesProviderCredentialName,
} from "./isolation.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

// Sentinels planted on the fake HOST. None may ever reach the child, the generated home or logs.
const HOST_DOTENV_KEY = "sk-ant-SENTINEL-host-dotenv-7102";
const HOST_PROCESS_KEY = "sk-ant-SENTINEL-host-process-7102";
const HOST_AUTH_JSON = "SENTINEL-host-auth-json-7102";
const HOST_CONFIG_MODEL = "sentinel-host-config-model-7102";
const HOST_SKILL = "sentinel-host-skill-7102";
const SENTINELS = [HOST_DOTENV_KEY, HOST_PROCESS_KEY, HOST_AUTH_JSON, HOST_CONFIG_MODEL, HOST_SKILL];
const EXPLICIT_KEY = "explicit-secret-ref-value-7102";

const ENV_KEYS = [
  "PAPERCLIP_HERMES_HOST_ISOLATION",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEFAULT_OPENAI_API_KEY",
  "HOME",
  "HERMES_HOME",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

let fakeHostHome: string;
let skillSource: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

async function plantFakeHost(root: string) {
  const hermes = path.join(root, ".hermes");
  await fs.mkdir(path.join(hermes, "skills", "cat", HOST_SKILL), { recursive: true });
  await fs.writeFile(path.join(hermes, ".env"), `ANTHROPIC_API_KEY=${HOST_DOTENV_KEY}\nOPENAI_API_KEY=${HOST_DOTENV_KEY}\n`);
  await fs.writeFile(path.join(hermes, "auth.json"), JSON.stringify({ token: HOST_AUTH_JSON }));
  await fs.writeFile(path.join(hermes, "config.yaml"), `model:\n  default: ${HOST_CONFIG_MODEL}\n  provider: anthropic\n`);
  await fs.writeFile(
    path.join(hermes, "skills", "cat", HOST_SKILL, "SKILL.md"),
    `---\nname: ${HOST_SKILL}\ndescription: ${HOST_SKILL}\n---\n`,
  );
}

function makeContext(options: {
  env?: Record<string, string>;
  servers?: AdapterRuntimeMcpServer[];
  sessionId?: string;
  extraConfig?: Record<string, unknown>;
  logs: Array<{ stream: string; chunk: string }>;
}): AdapterExecutionContext {
  return {
    runId: "run-host-isolation-1",
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
      ...(options.extraConfig ?? {}),
    },
    context: { issueId: "issue-1", wakeReason: "manual" },
    runtimeMcp: options.servers ? { getServers: () => options.servers! } : undefined,
    authToken: "paperclip-run-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      options.logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

function expectNoSentinels(haystack: string) {
  for (const sentinel of SENTINELS) expect(haystack).not.toContain(sentinel);
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const runHomesInTmp = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("paperclip-run-home-")).sort();

describe("hermesHostIsolationEnabled (TECH-7102)", () => {
  it("defaults ON for an authenticated deployment and OFF otherwise", () => {
    expect(hermesHostIsolationEnabled({ PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(true);
    expect(hermesHostIsolationEnabled({ PAPERCLIP_DEPLOYMENT_MODE: "local_trusted" })).toBe(false);
    expect(hermesHostIsolationEnabled({})).toBe(false);
  });

  it("an explicit value overrides the deployment mode in both directions", () => {
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "true" })).toBe(true);
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "false", PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(false);
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: " OFF ", PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(false);
  });

  it("a blank override is treated as unset and uses the deployment-mode default", () => {
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "  ", PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(true);
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "", PAPERCLIP_DEPLOYMENT_MODE: "local_trusted" })).toBe(false);
  });

  it("fails closed: an unrecognised explicit value keeps isolation ON", () => {
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "flase", PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(true);
    expect(hermesHostIsolationEnabled({ PAPERCLIP_HERMES_HOST_ISOLATION: "flase" })).toBe(true);
  });
});

describe("explicit provider credential detection (TECH-7102)", () => {
  it("counts allowlisted provider credentials but not base URLs/hosts/endpoints", () => {
    expect(isHermesProviderCredentialName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isHermesProviderCredentialName("OPENROUTER_API_KEY")).toBe(true);
    expect(isHermesProviderCredentialName("ANTHROPIC_BASE_URL")).toBe(false);
    expect(isHermesProviderCredentialName("OLLAMA_HOST")).toBe(false);
    expect(isHermesProviderCredentialName("BEDROCK_AWS_REGION")).toBe(false);
    for (const meta of ["X_PROJECT_ID", "X_ORG_ID", "X_TENANT_ID"]) expect(isHermesProviderCredentialName(meta), meta).toBe(false);
    expect(isHermesProviderCredentialName("AZURE_OPENAI_ENDPOINT")).toBe(false);
    expect(isHermesProviderCredentialName("DATABASE_URL")).toBe(false);
    expect(isHermesProviderCredentialName("HOME")).toBe(false);
  });

  it("requires a non-empty value in the run's own env only", () => {
    expect(hasExplicitHermesProviderCredential({ ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hasExplicitHermesProviderCredential({ ANTHROPIC_API_KEY: "   " })).toBe(false);
    expect(hasExplicitHermesProviderCredential({ ANTHROPIC_BASE_URL: "https://x" })).toBe(false);
    expect(hasExplicitHermesProviderCredential(undefined)).toBe(false);
    expect(hasExplicitHermesProviderCredential(null)).toBe(false);
    expect(hasExplicitHermesProviderCredential(["ANTHROPIC_API_KEY"])).toBe(false);
  });
});

describe("hermes execute with host isolation (TECH-7102)", () => {
  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    captured = null;
    childBehavior = "ok";
    vi.mocked(runChildProcess).mockClear();
    fakeHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
    skillSource = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-src-"));
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\n---\n");
    await plantFakeHost(fakeHostHome);
    process.env.HOME = fakeHostHome;
    process.env.HERMES_HOME = path.join(fakeHostHome, ".hermes");
    process.env.ANTHROPIC_API_KEY = HOST_PROCESS_KEY;
    process.env.OPENAI_API_KEY = HOST_PROCESS_KEY;
    vi.spyOn(os, "homedir").mockReturnValue(fakeHostHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const dir of [fakeHostHome, skillSource]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  describe("isolation ON", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
    });

    it("runs in a fresh per-run home with the explicit key, never the host ~/.hermes, and cleans up", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeContext({ env: { ANTHROPIC_API_KEY: EXPLICIT_KEY }, sessionId: "prior-session", logs }),
      );
      expect(result.exitCode).toBe(0);
      const c = captured!;

      // Fresh per-run home: HOME/XDG/TMPDIR inside it, none under the fake host home.
      expect(path.basename(c.env.HOME)).toMatch(/^paperclip-run-home-/);
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
        expect(c.env[key].startsWith(c.env.HOME), key).toBe(true);
        expect(c.env[key].startsWith(fakeHostHome), key).toBe(false);
      }
      expect(c.hermesHome!.startsWith(c.env.HOME + path.sep)).toBe(true);
      expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);

      // Nothing from the host Hermes dir copied in.
      expect(c.hermesHomeEntries).not.toContain("auth.json");
      expect(c.skillsEntries).not.toContain("cat");
      expect(c.hermesDotenv).not.toContain("ANTHROPIC_API_KEY");
      expect(c.hermesConfigYaml).not.toContain(HOST_CONFIG_MODEL);

      // The explicit key reaches the child; the host/ambient keys do not.
      expect(c.env.ANTHROPIC_API_KEY).toBe(EXPLICIT_KEY);
      expect(c.env.OPENAI_API_KEY).toBeUndefined();
      expectNoSentinels(JSON.stringify(c.env));
      expectNoSentinels(c.args.join("\n"));
      expectNoSentinels(logs.map((l) => l.chunk).join(""));

      // No resume (the home is per-run), and everything is removed afterwards.
      expect(c.args).not.toContain("--resume");
      expect(result.clearSession).toBe(true);
      expect(await exists(c.env.HOME)).toBe(false);
      expect(await exists(c.hermesHome!)).toBe(false);
      expect(await fs.readFile(path.join(fakeHostHome, ".hermes", ".env"), "utf8")).toContain(HOST_DOTENV_KEY);
    });

    it("a config.env HOME/XDG/TMPDIR/HERMES_HOME override cannot redirect the child back to the host", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      await execute(
        makeContext({
          env: {
            ANTHROPIC_API_KEY: EXPLICIT_KEY,
            HOME: fakeHostHome,
            XDG_CONFIG_HOME: path.join(fakeHostHome, ".config"),
            TMPDIR: path.join(fakeHostHome, "tmp"),
            HERMES_HOME: path.join(fakeHostHome, ".hermes"),
          },
          logs,
        }),
      );
      const c = captured!;
      expect(c.env.HOME.startsWith(fakeHostHome)).toBe(false);
      expect(c.env.XDG_CONFIG_HOME.startsWith(c.env.HOME)).toBe(true);
      expect(c.env.TMPDIR.startsWith(c.env.HOME)).toBe(true);
      expect(c.env.HERMES_HOME.startsWith(c.env.HOME + path.sep)).toBe(true);
      expectNoSentinels(JSON.stringify(c.env));
    });

    it("never injects host .env provider keys alongside runtime MCP servers; the run's MCP token and explicit key do reach the child", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const servers: AdapterRuntimeMcpServer[] = [
        { name: "test-server", url: "http://localhost:3100/mcp", token: "tok-run-mcp", connectionId: "c1", allowedTools: ["tool_a"] },
      ];
      const result = await execute(makeContext({ env: { OPENAI_API_KEY: EXPLICIT_KEY }, servers, logs }));
      expect(result.exitCode).toBe(0);
      const c = captured!;
      expect(c.env.HERMES_MCP_TOKEN_TEST_SERVER).toBe("tok-run-mcp");
      expect(c.env.OPENAI_API_KEY).toBe(EXPLICIT_KEY);
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.hermesDotenv).toContain("HERMES_MCP_TOKEN_TEST_SERVER");
      expect(c.hermesDotenv).not.toContain("ANTHROPIC_API_KEY");
      expect(c.hermesConfigYaml).toContain("mcp_servers:");
      expect(c.hermesConfigYaml).not.toContain(HOST_CONFIG_MODEL);
      expectNoSentinels(JSON.stringify(c.env));
      expectNoSentinels(c.args.join("\n"));
      expectNoSentinels(logs.map((l) => l.chunk).join(""));
    });

    it("materializes Paperclip-managed skills into the isolated home, never the host skills dir", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeContext({
          env: { ANTHROPIC_API_KEY: EXPLICIT_KEY },
          extraConfig: {
            paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource }],
          },
          logs,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(captured!.skillsEntries).toEqual(["paperclip"]);
      expect(await exists(path.join(fakeHostHome, ".hermes", "skills", "paperclip"))).toBe(false);
      // The skill source survives cleanup of the run home (the symlink is removed, not its target).
      expect(await exists(path.join(skillSource, "SKILL.md"))).toBe(true);
    });

    it.each([
      ["no env at all", undefined],
      ["only a base URL", { ANTHROPIC_BASE_URL: "https://gateway.example" }],
      ["an empty key", { ANTHROPIC_API_KEY: "  " }],
    ] as const)("fails clearly BEFORE spawn when the run has no explicit provider credential (%s)", async (_label, env) => {
      const before = await runHomesInTmp();
      const logs: Array<{ stream: string; chunk: string }> = [];
      await expect(execute(makeContext({ env: env as Record<string, string> | undefined, logs }))).rejects.toThrow(
        /no explicit provider credential/,
      );
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(await runHomesInTmp()).toEqual(before);
      expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);
      const text = logs.map((l) => l.chunk).join("");
      expect(text).toContain("no explicit provider credential");
      expectNoSentinels(text);
    });

    it("does not fall back to the ambient server provider env or host .env when the explicit key is missing", async () => {
      // process.env and the host .env both hold provider keys (planted in beforeEach): still refused.
      await expect(execute(makeContext({ logs: [] }))).rejects.toThrow(/no explicit provider credential/);
      expect(runChildProcess).not.toHaveBeenCalled();
    });

    it("an ambient control plane default key on the host never satisfies the explicit provider credential check", async () => {
      process.env.PAPERCLIP_DEFAULT_OPENAI_API_KEY = "ambient-control-default-key-7102-test";
      const logs: Array<{ stream: string; chunk: string }> = [];
      await expect(execute(makeContext({ env: undefined, logs }))).rejects.toThrow(
        /no explicit provider credential/,
      );
      // but once userEnv has a resolved explicit key, it succeeds
      const result = await execute(makeContext({ env: { OPENAI_API_KEY: EXPLICIT_KEY }, logs }));
      expect(result.exitCode).toBe(0);
      expect(captured!.env.OPENAI_API_KEY).toBe(EXPLICIT_KEY);
      expect(captured!.env.PAPERCLIP_DEFAULT_OPENAI_API_KEY).toBeUndefined();
    });

    it.each(["timeout", "throw"] as const)("removes the run home when the child %s", async (behavior) => {
      childBehavior = behavior;
      const before = await runHomesInTmp();
      const run = execute(makeContext({ env: { ANTHROPIC_API_KEY: EXPLICIT_KEY }, logs: [] }));
      if (behavior === "throw") await expect(run).rejects.toThrow("spawn exploded");
      else await run;
      expect(await exists(captured!.env.HOME)).toBe(false);
      expect(await runHomesInTmp()).toEqual(before);
    });
  });

  describe("detectModel host config", () => {
    it("does not read the host Hermes config when isolation is on; explicit paths still work", async () => {
      process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "true";
      expect(await detectModel()).toBeNull();
      const explicit = path.join(fakeHostHome, "explicit.yaml");
      await fs.writeFile(explicit, "model:\n  default: explicit-model\n");
      expect((await detectModel(explicit))?.model).toBe("explicit-model");
    });

    it("keeps the legacy host read when isolation is off", async () => {
      process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "false";
      expect((await detectModel())?.model).toBe(HOST_CONFIG_MODEL);
    });
  });

  describe("isolation switched on by the deployment mode alone", () => {
    it("PAPERCLIP_DEPLOYMENT_MODE=authenticated isolates the run (no override variable set)", async () => {
      delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
      process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeContext({ env: { ANTHROPIC_API_KEY: EXPLICIT_KEY }, sessionId: "prior-session", logs }),
      );
      expect(result.exitCode).toBe(0);
      expect(path.basename(captured!.env.HOME)).toMatch(/^paperclip-run-home-/);
      expect(captured!.env.OPENAI_API_KEY).toBeUndefined();
      expect(captured!.args).not.toContain("--resume");
      expect(logs.map((l) => l.chunk).join("")).toContain("per-run isolated home");
      expectNoSentinels(JSON.stringify(captured!.env));
    });

    it("PAPERCLIP_DEPLOYMENT_MODE=authenticated with no explicit key is refused before spawn", async () => {
      delete process.env.PAPERCLIP_HERMES_HOST_ISOLATION;
      process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
      await expect(execute(makeContext({ logs: [] }))).rejects.toThrow(/no explicit provider credential/);
      expect(runChildProcess).not.toHaveBeenCalled();
    });
  });

  describe("isolation OFF (local development) keeps the legacy behaviour", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_HERMES_HOST_ISOLATION = "false";
    });

    it("no MCP/memory: runs in the host home, needs no explicit key, and keeps --resume", async () => {
      const before = await runHomesInTmp();
      const result = await execute(makeContext({ sessionId: "prior-session", logs: [] }));
      expect(result.exitCode).toBe(0);
      expect(captured!.hermesHome).toBeNull();
      expect(captured!.args).toContain("--resume");
      expect(captured!.env.HOME).toBe(fakeHostHome);
      expect(await runHomesInTmp()).toEqual(before);
    });

    it("MCP run: the host .env provider key is still injected (legacy)", async () => {
      delete process.env.HERMES_HOME;
      const servers: AdapterRuntimeMcpServer[] = [
        { name: "s", url: "http://localhost:3100/mcp", token: "tok-s", connectionId: "c", allowedTools: ["t"] },
      ];
      const result = await execute(makeContext({ servers, logs: [] }));
      expect(result.exitCode).toBe(0);
      expect(captured!.hermesHome!.startsWith(path.join(fakeHostHome, ".hermes", "profiles") + path.sep)).toBe(true);
      expect(captured!.env.ANTHROPIC_API_KEY).toBe(HOST_DOTENV_KEY);
    });
  });
});
