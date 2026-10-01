/**
 * TECH-7076 regression: the Hermes agent child must never receive server-only
 * secrets from the server process environment. Previously execute() spread the
 * whole process.env into the child env, so an agent terminal tool could print
 * PAPERCLIP_SSO_PROVIDERS (Okta client secret), Better Auth / master keys, etc.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const SERVER_ONLY_SECRETS: Record<string, string> = {
  PAPERCLIP_SSO_PROVIDERS: "tech7076_sso_providers_okta_client_secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "tech7076_master_key_value",
  PAPERCLIP_AGENT_JWT_SECRET: "tech7076_agent_jwt_secret_value",
  BETTER_AUTH_SECRET: "tech7076_better_auth_secret_value",
  ANTHROPIC_API_KEY: "tech7076_ambient_anthropic_key",
  OPENAI_API_KEY: "tech7076_ambient_openai_key",
  AWS_SECRET_ACCESS_KEY: "tech7076_aws_secret_access_key",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/tech7076",
  DATABASE_URL: "postgres://tech7076-user:tech7076-pass@db.internal/app",
  SOME_FUTURE_UNREVIEWED_SECRET: "tech7076_future_secret_value",
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-env-isolation",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, ...overrides },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

async function runAndGetChildEnv(ctx: ReturnType<typeof makeCtx>): Promise<Record<string, string>> {
  try {
    await execute(ctx as any);
  } catch {
    // execute may fail for unrelated reasons (no real hermes binary); we only inspect the spawn env.
  }
  const mocked = vi.mocked(serverUtils.runChildProcess);
  expect(mocked.mock.calls.length).toBeGreaterThan(0);
  const opts = mocked.mock.calls[mocked.mock.calls.length - 1][3] as { env: Record<string, string> };
  return opts.env;
}

describe("hermes-local child env isolation (TECH-7076)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(SERVER_ONLY_SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("never passes server-only secrets from process.env into the Hermes child env", async () => {
    const env = await runAndGetChildEnv(makeCtx());
    for (const key of Object.keys(SERVER_ONLY_SECRETS)) {
      expect(env[key], `${key} must not reach the Hermes child`).toBeUndefined();
    }
    const serialized = JSON.stringify(env);
    for (const value of Object.values(SERVER_ONLY_SECRETS)) {
      expect(serialized).not.toContain(value);
    }
  });

  it("still passes explicitly configured adapter env (managed AI connection / secret-ref projection)", async () => {
    const env = await runAndGetChildEnv(
      makeCtx({ env: { ANTHROPIC_API_KEY: "tech7076_explicit_managed_key", EXTRA_FLAG: "1" } }),
    );
    expect(env.ANTHROPIC_API_KEY).toBe("tech7076_explicit_managed_key");
    expect(env.EXTRA_FLAG).toBe("1");
    // The explicit managed value wins over, and is not mixed with, the ambient server key.
    expect(JSON.stringify(env)).not.toContain(SERVER_ONLY_SECRETS.ANTHROPIC_API_KEY);
  });

  it("keeps the OS essentials the CLI needs and the run-scoped Paperclip identity", async () => {
    const env = await runAndGetChildEnv(makeCtx());
    expect(typeof env.PATH).toBe("string");
    expect(env.PAPERCLIP_RUN_ID).toBe("test-run-env-isolation");
  });
});
