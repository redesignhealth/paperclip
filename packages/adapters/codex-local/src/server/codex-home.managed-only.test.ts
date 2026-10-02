import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedManagedCodexHome } from "./codex-home.js";

const API_KEY_SENTINEL = "sk-tech7095-stale-api-key";
let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tech7095-codex-home-"));
  saved = process.env.PAPERCLIP_AGENT_AUTH_POLICY;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.PAPERCLIP_AGENT_AUTH_POLICY;
  else process.env.PAPERCLIP_AGENT_AUTH_POLICY = saved;
  await fs.rm(root, { recursive: true, force: true });
});

const noLog = async () => {};

describe("seedManagedCodexHome stale credentials under managed_only (TECH-7095)", () => {
  it("removes an apikey-mode auth.json left by a previous bound run", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const home = path.join(root, "company-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: API_KEY_SENTINEL }));
    await seedManagedCodexHome(home, {}, noLog);
    await expect(fs.lstat(path.join(home, "auth.json"))).rejects.toThrow();
  });

  it("removes an unreadable / non-credential regular auth.json", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const home = path.join(root, "company-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), "not json");
    await seedManagedCodexHome(home, {}, noLog);
    await expect(fs.lstat(path.join(home, "auth.json"))).rejects.toThrow();
  });

  it("keeps a promoted subscription-identity auth.json (a device login's durable outcome)", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const home = path.join(root, "company-home");
    await fs.mkdir(home, { recursive: true });
    const promoted = JSON.stringify({
      tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acct-1" },
      last_refresh: "2026-07-09T00:00:00Z",
    });
    await fs.writeFile(path.join(home, "auth.json"), promoted);
    await seedManagedCodexHome(home, {}, noLog);
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(promoted);
  });

  it("still removes a host-linked symlink", async () => {
    process.env.PAPERCLIP_AGENT_AUTH_POLICY = "managed_only";
    const hostAuth = path.join(root, "host-auth.json");
    await fs.writeFile(hostAuth, JSON.stringify({ OPENAI_API_KEY: API_KEY_SENTINEL }));
    const home = path.join(root, "company-home");
    await fs.mkdir(home, { recursive: true });
    await fs.symlink(hostAuth, path.join(home, "auth.json"));
    await seedManagedCodexHome(home, {}, noLog);
    await expect(fs.lstat(path.join(home, "auth.json"))).rejects.toThrow();
    expect(await fs.readFile(hostAuth, "utf8")).toContain(API_KEY_SENTINEL);
  });
});
