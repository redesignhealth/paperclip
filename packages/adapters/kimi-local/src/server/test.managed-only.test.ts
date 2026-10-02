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
const { testKimiAcpEnvironment } = await import("./acp.js");

describe("kimi readiness under the agent auth policy (TECH-7095)", () => {
  beforeEach(() => {
    setupHost();
    writeFakeHostFile(".kimi-code/credentials/token.json", JSON.stringify({ token: SENTINEL }));
  });
  afterEach(teardownHost);

  const ctx = (env: Record<string, unknown> = {}, engine = "cli") =>
    ({
      companyId: "company-1",
      adapterType: "kimi_local",
      config: { command: "kimi", engine, cwd: fakeHome, env },
    }) as never;

  it("managed_only CLI lane: ignores host env pair and ~/.kimi-code login; isolated probe home", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment(ctx());
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("kimi_auth_missing");
    expect(codes).not.toContain("kimi_auth_detected");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(".kimi-code");
    expectIsolatedProbes();
  });

  it("managed_only CLI lane: explicit config.env pair counts", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment(ctx({ KIMI_MODEL_NAME: "kimi-k2", KIMI_MODEL_API_KEY: "explicit-config-key" }));
    expect(result.checks.find((check) => check.code === "kimi_auth_detected")?.detail).toContain("adapter env");
    expectIsolatedProbes();
  });

  it("host_fallback CLI lane: keeps legacy host env detection", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await testEnvironment(ctx());
    expect(result.checks.map((check) => check.code)).toContain("kimi_auth_detected");
  });

  it("host_fallback CLI lane: keeps legacy ~/.kimi-code login detection", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    delete process.env.KIMI_MODEL_API_KEY;
    const result = await testEnvironment(ctx());
    expect(result.checks.find((check) => check.code === "kimi_auth_detected")?.detail).toContain("kimi login OAuth");
  });

  it("managed_only ACP lane: does not report host credentials", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testKimiAcpEnvironment(ctx({}, "acp"));
    const codes = result.checks.map((check) => check.code);
    expect(codes).not.toContain("kimi_acp_credentials_detected");
    expect(codes).toContain("kimi_acp_credentials_not_detected");
  });

  it("host_fallback ACP lane: keeps legacy host detection", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await testKimiAcpEnvironment(ctx({}, "acp"));
    expect(result.checks.map((check) => check.code)).toContain("kimi_acp_credentials_detected");
  });
});
