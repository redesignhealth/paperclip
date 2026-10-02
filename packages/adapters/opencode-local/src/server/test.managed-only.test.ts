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

vi.mock("./models.js", () => ({
  discoverOpenCodeModels: vi.fn(async (input: { env: Record<string, string> }) => {
    captured.push({ command: "opencode", args: ["models"], env: { ...input.env } });
    return [{ id: "openrouter/model", label: "model" }];
  }),
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async (input: { env: Record<string, string> }) => {
    captured.push({ command: "opencode", args: ["models", "--validate"], env: { ...input.env } });
    return [{ id: "openrouter/model", label: "model" }];
  }),
}));

const { testEnvironment } = await import("./test.js");

describe("opencode readiness under the agent auth policy (TECH-7095)", () => {
  beforeEach(() => {
    setupHost();
    writeFakeHostFile(".local/share/opencode/auth.json", JSON.stringify({ openrouter: { key: SENTINEL } }));
  });
  afterEach(teardownHost);

  const ctx = (config: Record<string, unknown> = {}) =>
    ({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command: "opencode", model: "openrouter/model", cwd: fakeHome, ...config },
    }) as never;

  it("managed_only: an unbound agent reports ai_connection_required and never probes", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment(ctx());
    const check = result.checks.find((entry) => entry.code === "ai_connection_required");
    expect(check?.level).toBe("error");
    expect(result.status).toBe("fail");
    expect(captured).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("managed_only: a managed connection probes in an isolated home without host keys", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const result = await testEnvironment(
      ctx({ managedAiConnection: { provider: "openrouter", method: "api_key" }, env: { OPENROUTER_API_KEY: "managed-key" } }),
    );
    expect(result.checks.map((entry) => entry.code)).not.toContain("ai_connection_required");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expectIsolatedProbes();
    for (const call of captured) {
      expect(call.env.OPENROUTER_API_KEY).toBe("managed-key");
      expect(call.env.XDG_CONFIG_HOME).toBeTruthy();
      expect(call.env.XDG_CONFIG_HOME!.startsWith(fakeHome)).toBe(false);
    }
  });

  it("managed_only_report: legacy probing plus an informational ai_connection_required", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only_report";
    const result = await testEnvironment(ctx());
    expect(result.checks.find((entry) => entry.code === "ai_connection_required")?.level).toBe("info");
    expect(captured.length).toBeGreaterThan(0);
  });

  it("host_fallback: legacy probing with no ai_connection_required", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const result = await testEnvironment(ctx());
    expect(result.checks.map((entry) => entry.code)).not.toContain("ai_connection_required");
    expect(captured.length).toBeGreaterThan(0);
  });
});
