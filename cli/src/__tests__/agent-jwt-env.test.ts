import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentJwtSecret,
  ensureToolActionSigningSecret,
  loadPaperclipEnvFile,
  mergePaperclipEnvEntries,
  readAgentJwtSecretFromEnv,
  readPaperclipEnvEntries,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import { COMMS_BOARD_PROVISIONER_ENV_KEYS } from "@paperclipai/shared/comms-board-provisioner-env";
import { agentJwtSecretCheck } from "../checks/agent-jwt-secret-check.js";

const ORIGINAL_ENV = { ...process.env };

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-jwt-env-"));
  const configDir = path.join(dir, "custom");
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, "config.json");
}

describe("agent jwt env helpers", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("writes .env next to explicit config path", () => {
    const configPath = tempConfigPath();
    const result = ensureAgentJwtSecret(configPath);

    expect(result.created).toBe(true);

    const envPath = resolveAgentJwtEnvFile(configPath);
    expect(fs.existsSync(envPath)).toBe(true);
    const contents = fs.readFileSync(envPath, "utf-8");
    expect(contents).toContain("PAPERCLIP_AGENT_JWT_SECRET=");
  });

  it("creates an independent tool-action signing secret next to the config", () => {
    const configPath = tempConfigPath();
    const result = ensureToolActionSigningSecret(configPath);

    expect(result.created).toBe(true);
    expect(result.secret).toHaveLength(64);
    const entries = readPaperclipEnvEntries(resolveAgentJwtEnvFile(configPath));
    expect(entries.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(result.secret);
    expect(entries.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
  });

  it("loads secret from .env next to explicit config path", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=test-secret\n", { mode: 0o600 });

    const loaded = readAgentJwtSecretFromEnv(configPath);
    expect(loaded).toBe("test-secret");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("test-secret");
  });

  it("doctor check passes when secret exists in adjacent .env", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=check-secret\n", { mode: 0o600 });

    const result = agentJwtSecretCheck(configPath);
    expect(result.status).toBe("pass");
  });

  it("quotes hash-prefixed env values so dotenv round-trips them", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);

    mergePaperclipEnvEntries(
      {
        PAPERCLIP_WORKTREE_COLOR: "#439edb",
      },
      envPath,
    );

    const contents = fs.readFileSync(envPath, "utf-8");
    expect(contents).toContain('PAPERCLIP_WORKTREE_COLOR="#439edb"');
    expect(readPaperclipEnvEntries(envPath).PAPERCLIP_WORKTREE_COLOR).toBe("#439edb");
  });

  it("preserves operator content and CRLF while updating only managed entries", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    const original = [
      "# operator comment",
      "DATABASE_URL='postgres://operator:encoded@localhost/paperclip'",
      "",
      "export PAPERCLIP_HOME = '/old path'  # managed path",
      "PAPERCLIP_DUPLICATE=stale",
      'PAPERCLIP_DUPLICATE="current"',
      "UNKNOWN_VALUE=operator-owned",
      "",
    ].join("\r\n");
    fs.writeFileSync(envPath, original, { mode: 0o600 });

    mergePaperclipEnvEntries(
      {
        PAPERCLIP_HOME: "/new path",
        PAPERCLIP_DUPLICATE: "current",
        PAPERCLIP_WORKTREE_COLOR: "#439edb",
        DATABASE_URL: "postgres://paperclip-must-not-overwrite",
      },
      envPath,
    );

    const updated = fs.readFileSync(envPath, "utf8");
    expect(updated).toBe([
      "# operator comment",
      "DATABASE_URL='postgres://operator:encoded@localhost/paperclip'",
      "",
      'export PAPERCLIP_HOME = "/new path"  # managed path',
      "PAPERCLIP_DUPLICATE=current",
      'PAPERCLIP_DUPLICATE="current"',
      "UNKNOWN_VALUE=operator-owned",
      'PAPERCLIP_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("does not replace the env file when managed values are already current", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    const original = [
      "# preserve this file byte-for-byte",
      "export PAPERCLIP_HOME = '/same path'",
      "UNKNOWN=\"operator encoding\"",
      "",
    ].join("\n");
    fs.writeFileSync(envPath, original, { mode: 0o600 });
    const previousInode = fs.statSync(envPath).ino;

    mergePaperclipEnvEntries({ PAPERCLIP_HOME: "/same path" }, envPath);

    expect(fs.readFileSync(envPath, "utf8")).toBe(original);
    expect(fs.statSync(envPath).ino).toBe(previousInode);
  });
});

// TECH-7228: the four comms-board provisioner settings are reserved for the deployment environment.
// The CLI preload never takes them from the instance .env (so a file URL can never be paired with a
// deployment token), while every other key keeps loading with `override:false` semantics.
describe("CLI .env preload reserves the comms-board provisioner keys (TECH-7228)", () => {
  const FILE_VALUES: Record<string, string> = {
    PAPERCLIP_COMMS_BOARD_MCP_URL: "https://file.test/mcp",
    PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN: "file-admin-token-fixture",
    PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: "https://file.test/api",
    PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN: "file-ownership-token-fixture",
  };
  const fileContents = (extra: string[] = []) =>
    [...Object.entries(FILE_VALUES).map(([k, v]) => `${k}=${v}`), ...extra, ""].join("\n");

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of COMMS_BOARD_PROVISIONER_ENV_KEYS) delete process.env[key];
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_TEST_ORDINARY_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reserves exactly the four canonical keys", () => {
    expect([...COMMS_BOARD_PROVISIONER_ENV_KEYS].sort()).toEqual(Object.keys(FILE_VALUES).sort());
    expect(Object.isFrozen(COMMS_BOARD_PROVISIONER_ENV_KEYS)).toBe(true);
  });

  it("never loads the four reserved keys from the .env, but still loads the JWT secret and ordinary keys", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolveAgentJwtEnvFile(configPath),
      fileContents(["PAPERCLIP_AGENT_JWT_SECRET=jwt-from-file", "PAPERCLIP_TEST_ORDINARY_KEY=ordinary-from-file"]),
      { mode: 0o600 },
    );

    loadPaperclipEnvFile(configPath);

    for (const key of Object.keys(FILE_VALUES)) expect(Object.hasOwn(process.env, key)).toBe(false);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("jwt-from-file");
    expect(process.env.PAPERCLIP_TEST_ORDINARY_KEY).toBe("ordinary-from-file");
  });

  it("preserves pre-existing comms values in the environment and never replaces them from the file", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(resolveAgentJwtEnvFile(configPath), fileContents(), { mode: 0o600 });
    const deployment: Record<string, string> = {
      PAPERCLIP_COMMS_BOARD_MCP_URL: "https://deploy.test/mcp",
      PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN: "deploy-admin-token-fixture",
      PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: "https://deploy.test/api",
      PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN: "deploy-ownership-token-fixture",
    };
    Object.assign(process.env, deployment);

    loadPaperclipEnvFile(configPath);

    for (const [key, value] of Object.entries(deployment)) expect(process.env[key]).toBe(value);
  });

  it("leaves tokens-only deployment environments without file URLs (they can never be paired)", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(resolveAgentJwtEnvFile(configPath), fileContents(), { mode: 0o600 });
    process.env.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN = "deploy-admin-token-fixture";
    process.env.PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN = "deploy-ownership-token-fixture";

    loadPaperclipEnvFile(configPath);

    expect(Object.hasOwn(process.env, "PAPERCLIP_COMMS_BOARD_MCP_URL")).toBe(false);
    expect(Object.hasOwn(process.env, "PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL")).toBe(false);
    expect(process.env.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN).toBe("deploy-admin-token-fixture");
  });

  it("an existing empty-string variable still wins over the file (override:false semantics)", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolveAgentJwtEnvFile(configPath),
      "PAPERCLIP_AGENT_JWT_SECRET=jwt-from-file\nPAPERCLIP_TEST_ORDINARY_KEY=ordinary-from-file\n",
      { mode: 0o600 },
    );
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "";
    process.env.PAPERCLIP_TEST_ORDINARY_KEY = "";

    loadPaperclipEnvFile(configPath);

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("");
    expect(process.env.PAPERCLIP_TEST_ORDINARY_KEY).toBe("");
  });

  it("an unreadable .env path is skipped quietly without loading anything", () => {
    const configPath = tempConfigPath();
    fs.mkdirSync(resolveAgentJwtEnvFile(configPath));
    expect(() => loadPaperclipEnvFile(configPath)).not.toThrow();
    for (const key of Object.keys(FILE_VALUES)) expect(Object.hasOwn(process.env, key)).toBe(false);
  });

  it("keeps ensure/read helpers working on the same file (JWT and tool-action signing secrets unchanged)", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolveAgentJwtEnvFile(configPath),
      fileContents(["PAPERCLIP_AGENT_JWT_SECRET=jwt-from-file"]),
      { mode: 0o600 },
    );

    expect(ensureAgentJwtSecret(configPath)).toEqual({ secret: "jwt-from-file", created: false });
    const signing = ensureToolActionSigningSecret(configPath);
    expect(signing.created).toBe(true);
    const entries = readPaperclipEnvEntries(resolveAgentJwtEnvFile(configPath));
    expect(entries.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET).toBe(signing.secret);
    // The file itself is never rewritten to drop operator-owned keys.
    expect(entries.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN).toBe(FILE_VALUES.PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN);
  });
});
