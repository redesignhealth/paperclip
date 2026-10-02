import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testEnvironment } from "./test.js";

// TECH-7095: under enforced managed_only, Hermes readiness must never read the server's
// process.env provider keys or the server user's ~/.hermes/.env / config.yaml, and its spawns
// must get an explicit allowlisted env + isolated HOME.
const HOST_KEY_SENTINEL = "sk-hermes-host-env-sentinel-7095";
const HOST_FILE_SENTINEL = "sk-hermes-dotenv-sentinel-7095";
const SAVED_KEYS = ["PAPERCLIP_AGENT_AUTH_POLICY", "HOME", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "HERMES_HOME"];

describe("hermes testEnvironment auth policy", () => {
  const saved: Record<string, string | undefined> = {};
  let fakeHome: string;
  let toolsDir: string;
  let cliPath: string;
  let envDump: string;

  beforeEach(async () => {
    for (const key of SAVED_KEYS) saved[key] = process.env[key];
    fakeHome = await mkdtemp(path.join(os.tmpdir(), "hermes-fake-host-home-"));
    toolsDir = await mkdtemp(path.join(os.tmpdir(), "hermes-fake-cli-"));
    await mkdir(path.join(fakeHome, ".hermes"), { recursive: true });
    await writeFile(path.join(fakeHome, ".hermes", ".env"), `MINIMAX_API_KEY=${HOST_FILE_SENTINEL}\n`);
    await writeFile(
      path.join(fakeHome, ".hermes", "config.yaml"),
      `model:\n  default: host-model-sentinel\n  provider: anthropic\n  api_key: ${HOST_FILE_SENTINEL}\n`,
    );
    envDump = path.join(toolsDir, "env-dump.txt");
    cliPath = path.join(toolsDir, "fake-hermes");
    await writeFile(cliPath, `#!/bin/sh\nenv > "${envDump}"\necho fake-hermes 1.2.3\n`, "utf8");
    await chmod(cliPath, 0o755);
    process.env.HOME = fakeHome;
    delete process.env.HERMES_HOME;
    process.env.ANTHROPIC_API_KEY = HOST_KEY_SENTINEL;
    process.env.OPENROUTER_API_KEY = HOST_KEY_SENTINEL;
  });

  afterEach(async () => {
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(fakeHome, { recursive: true, force: true });
    await rm(toolsDir, { recursive: true, force: true });
  });

  it("managed_only: ignores host env and host ~/.hermes files; spawns with isolated env", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { command: cliPath, model: "anthropic/claude-sonnet-4" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HOST_KEY_SENTINEL);
    expect(serialized).not.toContain(HOST_FILE_SENTINEL);
    expect(serialized).not.toContain("host-model-sentinel");
    const apiCheck = result.checks.find((c) => c.code.startsWith("hermes_") && c.code.includes("api_key"));
    expect(apiCheck?.code).toBe("hermes_no_api_keys");
    expect(result.checks.some((c) => c.code === "hermes_api_keys_found")).toBe(false);

    const dumped = await readFile(envDump, "utf8");
    expect(dumped).not.toContain(HOST_KEY_SENTINEL);
    expect(dumped).not.toContain(HOST_FILE_SENTINEL);
    const homeLine = dumped.split("\n").find((line) => line.startsWith("HOME="));
    expect(homeLine).toBeDefined();
    expect(homeLine).not.toBe(`HOME=${fakeHome}`);
    expect(homeLine).toContain("paperclip-run-home-probe-");
  });

  it("managed_only: an explicit config.env key is detected", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { command: cliPath, model: "anthropic/claude-sonnet-4", env: { ANTHROPIC_API_KEY: "sk-explicit-binding" } },
    });
    const found = result.checks.find((c) => c.code === "hermes_api_keys_found");
    expect(found?.message).toContain("Anthropic");
    expect(JSON.stringify(result)).not.toContain("sk-explicit-binding");
  });

  it("host_fallback: legacy host env and ~/.hermes/.env detection still works", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { command: cliPath, model: "anthropic/claude-sonnet-4" },
    });
    const found = result.checks.find((c) => c.code === "hermes_api_keys_found");
    expect(found?.message).toContain("Anthropic");
    expect(found?.message).toContain("OpenRouter");
    expect(found?.message).toContain("MiniMax");
    // Names only, never values.
    expect(JSON.stringify(result)).not.toContain(HOST_KEY_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(HOST_FILE_SENTINEL);
  });
});
