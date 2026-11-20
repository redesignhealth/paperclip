import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import {
  SHARED_SKILLS_REPOSITORY_ENV,
  startSharedSkillsSync,
  SHARED_SKILLS_TOKEN_ENV,
  readSharedSkillsConfig,
  refreshSharedSkills,
  resolveSharedSkillsRoot,
} from "../services/shared-skills-source.js";
import type { GitSkillSnapshot } from "../services/skill-source-git-snapshot.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const env = { [SHARED_SKILLS_TOKEN_ENV]: "test-token-value", [SHARED_SKILLS_REPOSITORY_ENV]: "example/skills-repo" };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Blob = { path: string; content: string; mode?: string; type?: string };
function snapshot(commitSha: string, blobs: Blob[]): GitSkillSnapshot {
  const entries = blobs.map((b) => ({ path: b.path, type: b.type ?? "blob", mode: b.mode ?? "100644", sha: "0".repeat(40), size: b.content.length }));
  return {
    commitSha, entries,
    readBlob: async (entry) => Buffer.from(blobs.find((b) => b.path === entry.path)!.content),
    release: vi.fn(async () => undefined),
  };
}
const skill = (name: string, extra: Blob[] = []): Blob[] => [{ path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: test\n---\nbody` }, ...extra];

describe("readSharedSkillsConfig", () => {
  it("is off without a token or repository", () => {
    expect(readSharedSkillsConfig({})).toBeNull();
    expect(readSharedSkillsConfig({ [SHARED_SKILLS_REPOSITORY_ENV]: "a/b" })).toBeNull();
    expect(readSharedSkillsConfig({ [SHARED_SKILLS_TOKEN_ENV]: "t" })).toBeNull();
  });
  it("rejects malformed settings instead of widening them", () => {
    expect(readSharedSkillsConfig({ ...env, [SHARED_SKILLS_REPOSITORY_ENV]: "not-a-repo" })).toBeNull();
    expect(readSharedSkillsConfig({ ...env, PAPERCLIP_SHARED_SKILLS_PATH: "../etc" })).toBeNull();
    expect(readSharedSkillsConfig({ ...env, PAPERCLIP_SHARED_SKILLS_REF: "--upload-pack=x" })).toBeNull();
  });
  it("defaults the folder and ref", () => {
    expect(readSharedSkillsConfig(env)).toMatchObject({ repositoryUrl: "https://github.com/example/skills-repo", subpath: "skills", ref: "main" });
  });
});

describe("refreshSharedSkills", () => {
  async function tmp() { const d = await mkdtemp(path.join(os.tmpdir(), "shared-skills-test-")); dirs.push(d); return d; }

  it("does nothing and never opens a download when unconfigured", async () => {
    const open = vi.fn();
    expect(await refreshSharedSkills({ env: {}, directory: await tmp(), openSnapshot: open as never })).toEqual({ status: "not_configured" });
    expect(open).not.toHaveBeenCalled();
  });

  it("publishes only skill folders and is idempotent per commit", async () => {
    const directory = await tmp();
    const blobs = [
      ...skill("alpha", [{ path: "skills/alpha/references/notes.md", content: "n" }, { path: "skills/alpha/run.sh", content: "#!/bin/sh", mode: "100755" }]),
      ...skill("beta"),
      { path: "skills/README.md", content: "loose file" },
      { path: "skills/no-skill-md/other.txt", content: "x" },
      { path: "terraform/main.tf", content: "must not be copied" },
    ];
    const open = vi.fn(async () => snapshot(SHA_A, blobs));
    const first = await refreshSharedSkills({ env, directory, openSnapshot: open });
    expect(first).toEqual({ status: "updated", commitSha: SHA_A, skills: 2 });
    const root = (await resolveSharedSkillsRoot(directory))!;
    expect((await readdir(root)).sort()).toEqual([".complete", "alpha", "beta"]);
    expect(await readFile(path.join(root, "alpha/references/notes.md"), "utf8")).toBe("n");
    expect((await stat(path.join(root, "alpha/run.sh"))).mode & 0o111).not.toBe(0);
    expect(await refreshSharedSkills({ env, directory, openSnapshot: open })).toEqual({ status: "unchanged", commitSha: SHA_A, skills: 2 });
  });

  it("moves the pointer to a new commit and keeps the old snapshot readable", async () => {
    const directory = await tmp();
    await refreshSharedSkills({ env, directory, openSnapshot: async () => snapshot(SHA_A, skill("alpha")) });
    const old = (await resolveSharedSkillsRoot(directory))!;
    await refreshSharedSkills({ env, directory, openSnapshot: async () => snapshot(SHA_B, skill("beta")) });
    const next = (await resolveSharedSkillsRoot(directory))!;
    expect(path.basename(next)).toBe(SHA_B);
    expect(await readdir(old)).toContain("alpha");
  });

  it("skips traversal, git metadata, symlinks and non-blobs", async () => {
    const directory = await tmp();
    const blobs = [
      ...skill("ok"),
      { path: "skills/ok/../../escape.txt", content: "no" },
      { path: "skills/ok/.git/config", content: "no" },
      { path: "skills/ok/link", content: "target", mode: "120000" },
      { path: "skills/ok/sub", content: "", type: "tree" },
      { path: "skills/-bad name/SKILL.md", content: "no" },
    ];
    await refreshSharedSkills({ env, directory, openSnapshot: async () => snapshot(SHA_A, blobs) });
    const root = (await resolveSharedSkillsRoot(directory))!;
    expect((await readdir(root)).sort()).toEqual([".complete", "ok"]);
    expect((await readdir(path.join(root, "ok"))).sort()).toEqual(["SKILL.md"]);
  });

  it("reports a failed download without leaking the token", async () => {
    warn.mockClear();
    const result = await refreshSharedSkills({ env, directory: await tmp(), openSnapshot: async () => { throw new Error("denied for test-token-value"); } });
    expect(result).toEqual({ status: "error", reason: "download_failed" });
    expect(JSON.stringify(result)).not.toContain("test-token-value");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("test-token-value");
  });

  it("reports no_skills when the folder holds none", async () => {
    const result = await refreshSharedSkills({ env, directory: await tmp(), openSnapshot: async () => snapshot(SHA_A, [{ path: "skills/README.md", content: "x" }]) });
    expect(result).toEqual({ status: "error", reason: "no_skills" });
    expect(await resolveSharedSkillsRoot(path.join(os.tmpdir(), "does-not-exist-shared"))).toBeNull();
  });

  it("starts no sync loop when unconfigured", () => {
    const stop = startSharedSkillsSync({ env: {} });
    expect(typeof stop).toBe("function");
    stop();
  });
});
