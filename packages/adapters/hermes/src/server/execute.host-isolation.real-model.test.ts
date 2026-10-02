/**
 * TECH-7089 G2b: isolated Hermes run against a REAL model provider (costs a few cents).
 *
 * Same setup as execute.host-isolation.real-hermes.test.ts (authenticated deployment, sentinel host
 * HOME and ambient secrets) but the explicit provider key is real and nothing is stubbed. Proves the
 * explicit credential authenticates, a real model can drive the terminal tool inside the per-run
 * home, and the run finishes cleanly. Gated: PAPERCLIP_G2_REAL_ANTHROPIC_KEY must be set.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const REAL_KEY = process.env.PAPERCLIP_G2_REAL_ANTHROPIC_KEY;
const AMBIENT_SENTINEL = "SENTINEL-ambient-anthropic-real-7089";
const HOST_SENTINEL = "SENTINEL-host-dotenv-real-7089";

describe.skipIf(!REAL_KEY)("G2b: isolated Hermes with a real model", () => {
  let hostHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "g2b-host-home-"));
    await fs.mkdir(path.join(hostHome, ".hermes"), { recursive: true });
    await fs.writeFile(path.join(hostHome, ".hermes/.env"), `ANTHROPIC_API_KEY=${HOST_SENTINEL}\n`);
    for (const k of ["ANTHROPIC_API_KEY", "HOME", "PAPERCLIP_DEPLOYMENT_MODE"]) saved[k] = process.env[k];
    Object.assign(process.env, { ANTHROPIC_API_KEY: AMBIENT_SENTINEL, HOME: hostHome, PAPERCLIP_DEPLOYMENT_MODE: "authenticated" });
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await fs.rm(hostHome, { recursive: true, force: true });
  });

  it("authenticates with the explicit key, runs a tool, and answers", async () => {
    const logs: string[] = [];
    const ctx = {
      runId: "g2b-run-1",
      agent: { id: "agent-g2b", companyId: "company-g2b", name: "G2b", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "hermes", timeoutSec: 180, graceSec: 2, provider: "anthropic", model: "claude-haiku-4-5-20251001",
        maxTurns: 6,
        promptTemplate: "Run the terminal command `echo $HOME`, then reply with one line in exactly this form: REAL-MODEL-OK home=<the output of that command>. Do nothing else.",
        env: { ANTHROPIC_API_KEY: REAL_KEY! },
      },
      context: { issueId: "issue-g2b", wakeReason: "manual" },
      authToken: "paperclip-run-token",
      onLog: async (_s: string, c: string) => { logs.push(c); },
      onSpawn: async () => {},
    } as unknown as AdapterExecutionContext;

    const result = await execute(ctx);
    const out = logs.join("") + JSON.stringify(result);
    expect(result.exitCode, out.slice(-2000)).toBe(0);
    expect(out).toContain("REAL-MODEL-OK");
    expect(out).toMatch(/REAL-MODEL-OK home=\S*paperclip-run-home-/);
    expect(out).not.toContain(AMBIENT_SENTINEL);
    expect(out).not.toContain(HOST_SENTINEL);
    expect(out).not.toContain(REAL_KEY!);
    expect((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("paperclip-run-home-"))).toEqual([]);
  }, 240_000);
});
