import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectModel } from "./detect-model.js";

let home: string;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "tech7095-detect-model-"));
  await mkdir(path.join(home, ".hermes"));
  await writeFile(path.join(home, ".hermes", "config.yaml"), "model:\n  default: tech7095-host-model\n  provider: zai\n");
  for (const k of ["HOME", "HERMES_HOME", "PAPERCLIP_AGENT_AUTH_POLICY"]) saved[k] = process.env[k];
  process.env.HOME = home;
  delete process.env.HERMES_HOME;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

describe("detectModel host config (TECH-7095)", () => {
  it("does not read the host Hermes config under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    expect(await detectModel()).toBeNull();
  });

  it("still honors an explicit config path under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const explicit = path.join(home, "explicit.yaml");
    await writeFile(explicit, "model:\n  default: explicit-model\n");
    expect((await detectModel(explicit))?.model).toBe("explicit-model");
  });

  it("keeps the legacy host read under host_fallback", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    expect((await detectModel())?.model).toBe("tech7095-host-model");
  });
});
