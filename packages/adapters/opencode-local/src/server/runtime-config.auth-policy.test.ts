import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const SENTINEL = "tech7095-opencode-server-provider-key";
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];
const KEYS = ["PAPERCLIP_OPENCODE_PROVIDERS", "TECH7095_OC_KEY", "PAPERCLIP_AGENT_AUTH_POLICY"];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TECH7095_OC_KEY = SENTINEL;
  process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify({
    gw: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://gw/v1", apiKey: "{env:TECH7095_OC_KEY}" },
      models: { "example/model-a": {} },
    },
  });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await Promise.all(cleanup.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

async function run(policy: string, runEnv: Record<string, string> = {}) {
  process.env.PAPERCLIP_AGENT_AUTH_POLICY = policy;
  const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "tech7095-oc-config-"));
  cleanup.push(configHome);
  await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
  await fs.writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({ permission: { read: "allow" } }));
  const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome, ...runEnv }, config: {} });
  cleanup.push(prepared.env.XDG_CONFIG_HOME);
  const text = await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8");
  await prepared.cleanup();
  return text;
}

describe("opencode runtime config {env:} placeholders (TECH-7095)", () => {
  it("does not bake a server env value into the agent-readable opencode.json under managed_only", async () => {
    expect(await run("managed_only")).not.toContain(SENTINEL);
  });

  it("still resolves from the run's own env under managed_only", async () => {
    const text = await run("managed_only", { TECH7095_OC_KEY: "run-own-key" });
    expect(text).toContain("run-own-key");
    expect(text).not.toContain(SENTINEL);
  });

  it("keeps the legacy server-env expansion under host_fallback", async () => {
    expect(await run("host_fallback")).toContain(SENTINEL);
  });
});
