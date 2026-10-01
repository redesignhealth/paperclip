import { afterEach, describe, expect, it } from "vitest";
import { createClaudeProbeEnv } from "./quota.js";

const NAMES = ["ANTHROPIC_API_KEY", "DATABASE_URL", "BETTER_AUTH_SECRET", "CLAUDE_CONFIG_DIR"];
const saved: Record<string, string | undefined> = {};
for (const k of NAMES) saved[k] = process.env[k];

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("createClaudeProbeEnv (TECH-7076)", () => {
  it("forwards CLAUDE_CONFIG_DIR but no ambient server secrets or ANTHROPIC_* keys", () => {
    process.env.ANTHROPIC_API_KEY = "tech7076-anthropic";
    process.env.DATABASE_URL = "postgres://u:tech7076@h/db";
    process.env.BETTER_AUTH_SECRET = "tech7076-better-auth";
    process.env.CLAUDE_CONFIG_DIR = " /tech7076/claude ";
    const env = createClaudeProbeEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tech7076/claude");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("tech7076-");
  });
});
