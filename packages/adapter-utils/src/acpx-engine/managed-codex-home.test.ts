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

  it("creates an empty home and leaves a regular auth.json (managed credential) alone", async () => {
    const target = path.join(root, "managed-home");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "auth.json"), "{}");
    await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: target, onLog: noLog });
    expect(await fs.readFile(path.join(target, "auth.json"), "utf8")).toBe("{}");
    const fresh = path.join(root, "fresh-home");
    await prepareManagedCodexHome({ companyId: "c", sourceHome: null, targetHome: fresh, onLog: noLog });
    expect((await fs.stat(fresh)).isDirectory()).toBe(true);
  });
});
