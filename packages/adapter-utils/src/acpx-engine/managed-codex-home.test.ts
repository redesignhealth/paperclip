import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome } from "./execute.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tech7095-acpx-codex-home-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const noLog = async () => {};

describe("prepareManagedCodexHome with no source home (managed_only) (TECH-7095)", () => {
  it("removes an auth.json symlink left by an earlier host_fallback seed, without touching the host file", async () => {
    const hostAuth = path.join(root, "host-auth.json");
    await fs.writeFile(hostAuth, JSON.stringify({ OPENAI_API_KEY: "sk-tech7095-host" }));
    const target = path.join(root, "managed-home");
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(hostAuth, path.join(target, "auth.json"));
    const result = await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: target, onLog: noLog });
    expect(result).toBe(target);
    await expect(fs.lstat(path.join(target, "auth.json"))).rejects.toThrow();
    expect(await fs.readFile(hostAuth, "utf8")).toContain("sk-tech7095-host");
  });

  it("creates an empty home and leaves a subscription-identity auth.json alone", async () => {
    const target = path.join(root, "managed-home");
    await fs.mkdir(target, { recursive: true });
    const promoted = JSON.stringify({ tokens: { account_id: "acct-keep" } });
    await fs.writeFile(path.join(target, "auth.json"), promoted);
    await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: target, onLog: noLog });
    expect(await fs.readFile(path.join(target, "auth.json"), "utf8")).toBe(promoted);
    const fresh = path.join(root, "fresh-home");
    await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: fresh, onLog: noLog });
    expect((await fs.stat(fresh)).isDirectory()).toBe(true);
  });
});

describe("prepareManagedCodexHome stale regular auth.json (managed_only, no source) (TECH-7095)", () => {
  it("removes a regular-file auth.json that is an API-key or unreadable residue (e.g. a symlinkOrCopyFile copy)", async () => {
    for (const payload of [JSON.stringify({ OPENAI_API_KEY: "sk-tech7095-copied" }), "not json", "{}"]) {
      const target = path.join(root, `home-${Math.random().toString(16).slice(2)}`);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "auth.json"), payload);
      await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: target, onLog: noLog });
      await expect(fs.lstat(path.join(target, "auth.json")), payload).rejects.toThrow();
    }
  });

  it("keeps a promoted subscription-identity auth.json (a device login's durable outcome)", async () => {
    const target = path.join(root, "promoted-home");
    await fs.mkdir(target, { recursive: true });
    const promoted = JSON.stringify({ tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acct-1" } });
    await fs.writeFile(path.join(target, "auth.json"), promoted);
    await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: target, onLog: noLog });
    expect(await fs.readFile(path.join(target, "auth.json"), "utf8")).toBe(promoted);
  });
});
