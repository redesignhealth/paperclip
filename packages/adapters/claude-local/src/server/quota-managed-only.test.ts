import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { CLAUDE_QUOTA_MANAGED_ONLY_UNAVAILABLE, getQuotaWindows } from "./quota.js";

const SENTINEL = "tech7095-claude-quota-sentinel";
const NAMES = ["PAPERCLIP_AGENT_AUTH_POLICY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME"];
const saved: Record<string, string | undefined> = {};
let fakeHome: string;

beforeEach(async () => {
  for (const k of NAMES) saved[k] = process.env[k];
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "tech7095-claude-quota-home-"));
  await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(fakeHome, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: SENTINEL } }),
  );
  process.env.HOME = fakeHome;
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
  process.env.ANTHROPIC_API_KEY = SENTINEL;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  execFileMock.mockReset();
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe("claude getQuotaWindows under the agent auth policy (TECH-7095)", () => {
  it("returns an unavailable result without reading the host login or spawning under managed_only", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const readSpy = vi.spyOn(fs, "readFile");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getQuotaWindows();
    expect(result).toEqual({
      provider: "anthropic",
      source: "managed_only_policy",
      ok: false,
      error: CLAUDE_QUOTA_MANAGED_ONLY_UNAVAILABLE,
      windows: [],
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("still polls the host login under host_fallback", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "host_fallback";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as ((err: Error) => void) | undefined;
      cb?.(new Error("no cli"));
    });
    const result = await getQuotaWindows();
    expect(result.source).not.toBe("managed_only_policy");
    expect(fetchSpy).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
