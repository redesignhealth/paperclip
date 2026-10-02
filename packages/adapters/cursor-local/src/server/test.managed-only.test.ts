import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
let probeResult = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" } as Record<string, unknown>;

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    runAdapterExecutionTargetProcess: vi.fn(
      async (_runId: string, _target: unknown, command: string, args: string[], options: { env: Record<string, string> }) => {
        captured.push({ command, args, env: { ...options.env } });
        return { ...probeResult };
      },
    ),
  };
});

const SENTINEL = "sentinel-host-secret-7095";
const SENTINEL_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_NAME",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
const SAVED_KEYS = [...SENTINEL_KEYS, "HOME", "PAPERCLIP_AGENT_AUTH_POLICY", "GOOGLE_GENAI_USE_GCA", "KIMI_CODE_HOME"];

let saved: Record<string, string | undefined> = {};
let fakeHome = "";

function setupHost() {
  saved = Object.fromEntries(SAVED_KEYS.map((key) => [key, process.env[key]]));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
  for (const key of SENTINEL_KEYS) process.env[key] = SENTINEL;
  process.env.GOOGLE_GENAI_USE_GCA = "true";
  delete process.env.KIMI_CODE_HOME;
  process.env.HOME = fakeHome;
  captured.length = 0;
  probeResult = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
}

function teardownHost() {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

function writeFakeHostFile(rel: string, contents: string) {
  const full = path.join(fakeHome, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function expectIsolatedProbes() {
  expect(captured.length).toBeGreaterThan(0);
  for (const call of captured) {
    expect(JSON.stringify(call.env)).not.toContain(SENTINEL);
    expect(call.env.HOME).toBeTruthy();
    expect(call.env.HOME).not.toBe(fakeHome);
    expect(path.basename(call.env.HOME!)).toMatch(/^paperclip-run-home-probe-/);
    // the isolated probe home is removed after the test
    expect(fs.existsSync(call.env.HOME!)).toBe(false);
  }
}

const { testEnvironment } = await import("./test.js");

describe("cursor readiness under the agent auth policy (TECH-7095)", () => {
  beforeEach(() => {
    setupHost();
    writeFakeHostFile(".cursor/cli-config.json", JSON.stringify({ authInfo: { email: `${SENTINEL}@example.com` } }));
  });
  afterEach(teardownHost);

  const run = (env: Record<string, unknown> = {}) =>
    testEnvironment({
      companyId: "company-1",
      adapterType: "cursor",
      config: { command: "agent", cwd: fakeHome, env },
    } as never);

  it("managed_only: ignores host CURSOR_API_KEY and ~/.cursor login; probes in an isolated home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await run();
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("cursor_api_key_missing");
    expect(codes).not.toContain("cursor_api_key_present");
    expect(codes).not.toContain("cursor_native_auth_present");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("server environment");
    expectIsolatedProbes();
  });

  it("managed_only: an explicit config.env key is detected and forwarded to the probe", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await run({ CURSOR_API_KEY: "explicit-config-key" });
    const present = result.checks.find((check) => check.code === "cursor_api_key_present");
    expect(present?.detail).toBe("Detected in adapter config env.");
    expectIsolatedProbes();
    expect(captured.every((call) => call.env.CURSOR_API_KEY === "explicit-config-key")).toBe(true);
  });

  it("host_fallback: keeps legacy host key detection", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await run();
    const present = result.checks.find((check) => check.code === "cursor_api_key_present");
    expect(present?.detail).toBe("Detected in server environment.");
  });

  it("host_fallback: keeps legacy ~/.cursor login detection when no key is set", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    delete process.env.CURSOR_API_KEY;
    const result = await run();
    expect(result.checks.map((check) => check.code)).toContain("cursor_native_auth_present");
  });
});
