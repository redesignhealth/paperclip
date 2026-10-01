/**
 * TECH-7095: prepareHermesMcpHome / Hermes home resolution under the agent auth policy.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupHermesMcpHome, prepareHermesMcpHome } from "./mcp-config.js";
import {
  listHermesSkills,
  resolveChildHermesHome,
  resolveHermesHome,
  resolveHostHermesDir,
  syncHermesSkills,
} from "./skills.js";

const HOST_DOTENV_KEY = "sk-SENTINEL-mcp-config-host-dotenv";
const HOST_CONFIG_MODEL = "sentinel-mcp-config-host-model";
const HOST_SKILL = "sentinel-mcp-config-host-skill";

const ENV_KEYS = ["PAPERCLIP_AGENT_AUTH_POLICY", "HOME", "HERMES_HOME"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fakeHostHome: string;
let runHome: string;

async function exists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

async function listRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...(await listRecursive(full)));
  }
  return out;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  fakeHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
  runHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-home-test-"));
  const hermes = path.join(fakeHostHome, ".hermes");
  await fs.mkdir(path.join(hermes, "skills", "cat", HOST_SKILL), { recursive: true });
  await fs.writeFile(path.join(hermes, ".env"), `ANTHROPIC_API_KEY=${HOST_DOTENV_KEY}\n`);
  await fs.writeFile(path.join(hermes, "auth.json"), `{"token":"${HOST_DOTENV_KEY}"}`);
  await fs.writeFile(path.join(hermes, "config.yaml"), `model:\n  default: ${HOST_CONFIG_MODEL}\n`);
  await fs.writeFile(path.join(hermes, "skills", "cat", HOST_SKILL, "SKILL.md"), `---\nname: ${HOST_SKILL}\n---\n`);
  process.env.HOME = fakeHostHome;
  process.env.HERMES_HOME = hermes;
  vi.spyOn(os, "homedir").mockReturnValue(fakeHostHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(fakeHostHome, { recursive: true, force: true }).catch(() => {});
  await fs.rm(runHome, { recursive: true, force: true }).catch(() => {});
});

describe("prepareHermesMcpHome under managed_only", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
  });

  it("prepares an isolated home inside the child HOME with no servers or memory and reads nothing from the host", async () => {
    const prepared = await prepareHermesMcpHome({ config: { env: { HOME: runHome } } });
    try {
      expect(prepared.homeDir.startsWith(runHome + path.sep)).toBe(true);
      expect(prepared.providerEnv).toEqual({});
      expect(prepared.serverCount).toBe(0);
      expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);
      const files = await listRecursive(prepared.homeDir);
      expect(files.map((f) => path.basename(f)).sort()).toEqual([".env", "config.yaml"]);
      for (const file of files) {
        const content = await fs.readFile(file, "utf8");
        expect(content).not.toContain(HOST_DOTENV_KEY);
        expect(content).not.toContain(HOST_CONFIG_MODEL);
        expect(content).not.toContain(HOST_SKILL);
      }
      expect((await fs.stat(prepared.homeDir)).mode & 0o777).toBe(0o700);
    } finally {
      await cleanupHermesMcpHome(prepared.homeDir);
    }
  });

  it("ignores a config.env.HERMES_HOME pointing at a host profile", async () => {
    const prepared = await prepareHermesMcpHome({
      config: { env: { HOME: runHome, HERMES_HOME: path.join(fakeHostHome, ".hermes") } },
    });
    try {
      expect(prepared.homeDir.startsWith(runHome + path.sep)).toBe(true);
      expect(prepared.providerEnv).toEqual({});
    } finally {
      await cleanupHermesMcpHome(prepared.homeDir);
    }
  });

  it("refuses without a child HOME instead of falling back to the host home", async () => {
    await expect(prepareHermesMcpHome({ config: {} })).rejects.toMatchObject({
      code: "agent_home_isolation_required",
    });
    expect(await exists(path.join(fakeHostHome, ".hermes", "profiles"))).toBe(false);
  });
});

describe("prepareHermesMcpHome legacy policies", () => {
  it.each(["host_fallback", "managed_only_report"] as const)(
    "%s keeps host config/.env/skills inheritance under <hostHermes>/profiles",
    async (policy) => {
      process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
      const prepared = await prepareHermesMcpHome({
        servers: [{ name: "s", url: "http://localhost:3100/mcp", token: "tok", connectionId: "c", allowedTools: ["t"] }],
        config: {},
      });
      try {
        expect(prepared.homeDir.startsWith(path.join(fakeHostHome, ".hermes", "profiles") + path.sep)).toBe(true);
        expect(prepared.providerEnv.ANTHROPIC_API_KEY).toBe(HOST_DOTENV_KEY);
        expect(await fs.readFile(prepared.configPath, "utf8")).toContain(HOST_CONFIG_MODEL);
        expect(await exists(path.join(prepared.homeDir, "skills", "cat", HOST_SKILL, "SKILL.md"))).toBe(true);
      } finally {
        await cleanupHermesMcpHome(prepared.homeDir);
      }
    },
  );

  it("host_fallback still refuses an empty isolated home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    await expect(prepareHermesMcpHome({ config: {} })).rejects.toThrow(/no servers or memory/);
  });
});

describe("Hermes home resolution", () => {
  it("managed_only derives only from the child env HOME", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const config = { env: { HOME: runHome, HERMES_HOME: path.join(fakeHostHome, ".hermes") } };
    expect(resolveChildHermesHome(config)).toBe(runHome);
    expect(resolveHermesHome(config)).toBe(runHome);
    expect(resolveHostHermesDir(config)).toBe(path.join(runHome, ".hermes"));
    expect(() => resolveHostHermesDir({})).toThrow(expect.objectContaining({ code: "agent_home_isolation_required" }));
    expect(() => resolveHermesHome()).toThrow(expect.objectContaining({ code: "agent_home_isolation_required" }));
  });

  it("host_fallback keeps HERMES_HOME / HOME / os.homedir() resolution", () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect(resolveHostHermesDir({})).toBe(path.join(fakeHostHome, ".hermes"));
    delete process.env.HERMES_HOME;
    delete process.env.HOME;
    expect(resolveHostHermesDir({})).toBe(path.join(fakeHostHome, ".hermes"));
    expect(resolveHermesHome({})).toBe(fakeHostHome);
  });

  it("managed_only skills listing/sync without a child HOME never scans or writes the host skills dir", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const ctx = { agentId: "a", companyId: "c", adapterType: "hermes_local", config: { paperclipRuntimeSkills: [] } };
    const listed = await listHermesSkills(ctx as any);
    expect(listed.entries.some((e) => e.key === HOST_SKILL)).toBe(false);
    const synced = await syncHermesSkills(ctx as any, []);
    expect(synced.entries.some((e) => e.key === HOST_SKILL)).toBe(false);
    expect(await fs.readdir(path.join(fakeHostHome, ".hermes", "skills"))).toEqual(["cat"]);
  });

  it("host_fallback skills listing still shows host Hermes skills", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const ctx = { agentId: "a", companyId: "c", adapterType: "hermes_local", config: { paperclipRuntimeSkills: [] } };
    const listed = await listHermesSkills(ctx as any);
    expect(listed.entries.some((e) => e.key === HOST_SKILL)).toBe(true);
  });
});
