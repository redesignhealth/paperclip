/**
 * TECH-7095: under the enforced managed-only agent auth policy, Hermes must never read host
 * credentials/config (host ~/.hermes/.env, config.yaml, auth.json, skills, profiles) and must
 * always run with an isolated HERMES_HOME inside the child's own per-run HOME.
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
      return { exitCode: 0, signal: null, timedOut: false, stdout: "done\n\nsession_id: sess-1", stderr: "" };
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
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

// Sentinels: fake values planted on the fake HOST. None may ever reach the child or logs.
const HOST_DOTENV_KEY = "sk-ant-SENTINEL-host-dotenv-7095";
const HOST_PROCESS_KEY = "sk-ant-SENTINEL-host-process-7095";
const HOST_AUTH_JSON = "SENTINEL-host-auth-json-7095";
const HOST_CONFIG_MODEL = "sentinel-host-config-model-7095";
const HOST_SKILL = "sentinel-host-skill-7095";
const SENTINELS = [HOST_DOTENV_KEY, HOST_PROCESS_KEY, HOST_AUTH_JSON, HOST_CONFIG_MODEL, HOST_SKILL];

const ENV_KEYS = [
  "PAPERCLIP_AGENT_AUTH_POLICY",
  "HOME",
  "HERMES_HOME",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

let fakeHostHome: string;
let runHome: string;
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
    runId: "run-auth-policy-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
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

async function exists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

describe("hermes execute under the agent auth policy (TECH-7095)", () => {
  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    captured = null;
    vi.mocked(runChildProcess).mockClear();
    fakeHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
    runHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-home-test-"));
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
    for (const dir of [fakeHostHome, runHome, skillSource]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("managed_only (enforced)", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    });

    it("uses an isolated HERMES_HOME inside the run home even with no MCP servers or memory", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeContext({ env: { HOME: runHome }, sessionId: "prior-session", logs }),
      );
      expect(result.exitCode).toBe(0);
      expect(captured).not.toBeNull();
      const c = captured!;

      // Isolated home lives under the child's own HOME, never under the host Hermes dir.
      expect(c.hermesHome).toBeTruthy();
      expect(c.hermesHome!.startsWith(runHome + path.sep)).toBe(true);
      expect(c.hermesHome!.startsWith(fakeHostHome)).toBe(false);
      expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);

      // Child HOME is exactly the supplied config env HOME.
      expect(c.env.HOME).toBe(runHome);

      // Nothing from the host Hermes dir was copied in.
      expect(c.hermesHomeEntries).not.toContain("auth.json");
      expect(c.skillsEntries).not.toContain("cat");
      expect(c.hermesDotenv).not.toContain("ANTHROPIC_API_KEY");
      expect(c.hermesConfigYaml).not.toContain(HOST_CONFIG_MODEL);

      // No host secret/config value anywhere in the child env, args or logs.
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.env.OPENAI_API_KEY).toBeUndefined();
      expectNoSentinels(JSON.stringify(c.env));
      expectNoSentinels(c.args.join("\n"));
      expectNoSentinels(logs.map((l) => l.chunk).join(""));

      // Ephemeral state: no resume, session cleared, temp home removed afterwards.
      expect(c.args).not.toContain("--resume");
      expect(result.clearSession).toBe(true);
      expect(result.sessionParams).toBeUndefined();
      expect(await exists(c.hermesHome!)).toBe(false);
      // Host files untouched.
      expect(await fs.readFile(path.join(fakeHostHome, ".hermes", ".env"), "utf8")).toContain(HOST_DOTENV_KEY);
    });

    it("never injects host .env provider keys alongside runtime MCP servers; explicit bindings still reach the child", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const servers: AdapterRuntimeMcpServer[] = [
        {
          name: "test-server",
          url: "http://localhost:3100/mcp",
          token: "tok-run-mcp",
          connectionId: "c1",
          allowedTools: ["tool_a"],
        },
      ];
      // Even if the run home itself carried a Hermes .env, it is not consulted.
      await plantFakeHost(runHome);
      const result = await execute(
        makeContext({
          env: { HOME: runHome, OPENAI_API_KEY: "explicit-binding-value" },
          servers,
          logs,
        }),
      );
      expect(result.exitCode).toBe(0);
      const c = captured!;
      expect(c.hermesHome!.startsWith(runHome + path.sep)).toBe(true);
      expect(c.env.HERMES_MCP_TOKEN_TEST_SERVER).toBe("tok-run-mcp");
      expect(c.env.OPENAI_API_KEY).toBe("explicit-binding-value");
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.hermesDotenv).toContain("HERMES_MCP_TOKEN_TEST_SERVER");
      expect(c.hermesDotenv).not.toContain("ANTHROPIC_API_KEY");
      expect(c.hermesConfigYaml).toContain("mcp_servers:");
      expect(c.hermesConfigYaml).not.toContain(HOST_CONFIG_MODEL);
      expect(c.hermesHomeEntries).not.toContain("auth.json");
      expectNoSentinels(JSON.stringify(c.env));
      expectNoSentinels(c.args.join("\n"));
      expectNoSentinels(logs.map((l) => l.chunk).join(""));
    });

    it("materializes Paperclip-managed skills into the isolated home, never the host skills dir", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeContext({
          env: { HOME: runHome },
          extraConfig: {
            paperclipRuntimeSkills: [
              { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource },
            ],
          },
          logs,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(captured!.skillsEntries).toEqual(["paperclip"]);
      expect(await exists(path.join(fakeHostHome, ".hermes", "skills", "paperclip"))).toBe(false);
      expect(await exists(path.join(runHome, ".hermes", "skills", "paperclip"))).toBe(false);
      // The skill source itself survives cleanup of the isolated home (symlink removed, not target).
      expect(await exists(path.join(skillSource, "SKILL.md"))).toBe(true);
    });

    it("refuses before spawn when the run has no explicit HOME", async () => {
      const logs: Array<{ stream: string; chunk: string }> = [];
      await expect(execute(makeContext({ logs }))).rejects.toMatchObject({
        name: "AgentAuthPolicyError",
        code: "agent_home_isolation_required",
      });
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);
      expectNoSentinels(logs.map((l) => l.chunk).join(""));
    });
  });

  describe("legacy policies keep host behaviour", () => {
    it.each(["host_fallback", "managed_only_report"] as const)(
      "%s: no MCP/memory runs without an isolated home and keeps --resume",
      async (policy) => {
        process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
        const logs: Array<{ stream: string; chunk: string }> = [];
        const result = await execute(makeContext({ env: { HOME: runHome }, sessionId: "prior-session", logs }));
        expect(result.exitCode).toBe(0);
        expect(captured!.hermesHome).toBeNull();
        expect(captured!.args).toContain("--resume");
      },
    );

    it("host_fallback: host .env provider key is still injected for MCP runs", async () => {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
      delete process.env.HERMES_HOME;
      const logs: Array<{ stream: string; chunk: string }> = [];
      const servers: AdapterRuntimeMcpServer[] = [
        { name: "s", url: "http://localhost:3100/mcp", token: "tok-s", connectionId: "c", allowedTools: ["t"] },
      ];
      const result = await execute(makeContext({ env: { HOME: fakeHostHome }, servers, logs }));
      expect(result.exitCode).toBe(0);
      expect(captured!.hermesHome!.startsWith(path.join(fakeHostHome, ".hermes", "profiles") + path.sep)).toBe(true);
      expect(captured!.env.ANTHROPIC_API_KEY).toBe(HOST_DOTENV_KEY);
    });
  });
});
