import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TECH-7095: quota polling uses the SERVER's own Codex login, so it is skipped under managed_only.

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, spawn: (...args: unknown[]) => mockSpawn(...args) };
});

import { CODEX_QUOTA_DISABLED_BY_POLICY_ERROR, getQuotaWindows } from "./quota.js";

const SENTINEL = "sk-host-sentinel-codex-quota-7095";

describe("codex getQuotaWindows under the agent auth policy", () => {
  let fakeHome: string;
  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-host-home-"));
    await fs.mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: SENTINEL, account_id: "acct" } }),
    );
    vi.stubEnv("HOME", fakeHome);
    vi.stubEnv("CODEX_HOME", path.join(fakeHome, ".codex"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockSpawn.mockReset();
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it("returns unavailable without spawning, reading auth, or fetching under managed_only", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "managed_only");
    const readSpy = vi.spyOn(fs, "readFile");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getQuotaWindows();
    expect(result).toEqual({
      provider: "openai",
      ok: false,
      error: CODEX_QUOTA_DISABLED_BY_POLICY_ERROR,
      windows: [],
    });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("still polls under host_fallback", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_AUTH_POLICY", "host_fallback");
    mockSpawn.mockImplementation(() => {
      throw new Error("spawn blocked in test");
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network blocked in test"));
    const result = await getQuotaWindows();
    expect(mockSpawn).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).not.toBe(CODEX_QUOTA_DISABLED_BY_POLICY_ERROR);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
