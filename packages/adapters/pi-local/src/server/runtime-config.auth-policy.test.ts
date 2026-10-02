import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePiRuntimeConfig } from "./runtime-config.js";

const SENTINEL = "tech7095-pi-server-provider-key";
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];
const KEYS = ["PAPERCLIP_PI_PROVIDERS", "TECH7095_PI_KEY", "PAPERCLIP_AGENT_AUTH_POLICY"];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.TECH7095_PI_KEY = SENTINEL;
  process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify({
    gw: { baseUrl: "http://gw/anthropic", apiKey: "{env:TECH7095_PI_KEY}", api: "anthropic-messages", models: [] },
  });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await Promise.all(cleanup.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

async function modelsJsonText(dir: string): Promise<string> {
  return fs.readFile(path.join(dir, "models.json"), "utf8");
}

describe("pi runtime config {env:} placeholders (TECH-7095)", () => {
  it("does not bake a server env value into the agent-readable models.json under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const prepared = await preparePiRuntimeConfig({ env: {} });
    const dir = prepared.env.PI_CODING_AGENT_DIR;
    if (dir) {
      cleanup.push(dir);
      expect(await modelsJsonText(dir)).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(prepared)).not.toContain(SENTINEL);
    await prepared.cleanup();
  });

  it("still resolves from the run's own env under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const prepared = await preparePiRuntimeConfig({ env: { TECH7095_PI_KEY: "run-own-key" } });
    const dir = prepared.env.PI_CODING_AGENT_DIR;
    cleanup.push(dir);
    expect(await modelsJsonText(dir)).toContain("run-own-key");
    expect(await modelsJsonText(dir)).not.toContain(SENTINEL);
    await prepared.cleanup();
  });

  it("keeps the legacy server-env expansion under host_fallback", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const prepared = await preparePiRuntimeConfig({ env: {} });
    const dir = prepared.env.PI_CODING_AGENT_DIR;
    cleanup.push(dir);
    expect(await modelsJsonText(dir)).toContain(SENTINEL);
    await prepared.cleanup();
  });
});
