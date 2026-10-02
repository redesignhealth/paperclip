import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileHermesPaperclipSkills } from "./skills.js";

let root: string;
let hostHome: string;
let source: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tech7102-skills-"));
  hostHome = path.join(root, "host");
  source = path.join(root, "skill-src");
  await fs.mkdir(path.join(hostHome, ".hermes"), { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: paperclip\n---\n");
  for (const k of ["HOME", "HERMES_HOME"]) saved[k] = process.env[k];
  process.env.HOME = hostHome;
  delete process.env.HERMES_HOME;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const config = () => ({
  paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source }],
});

describe("reconcileHermesPaperclipSkills skillsHome (TECH-7102)", () => {
  it("links the managed skills into the explicit skillsHome and never touches the host skills dir", async () => {
    const skillsHome = path.join(root, "run-home", "skills");
    const selected = await reconcileHermesPaperclipSkills(config(), undefined, { skillsHome });
    expect(selected.length).toBeGreaterThan(0);
    expect(await fs.readdir(skillsHome)).toEqual(["paperclip"]);
    await expect(fs.access(path.join(hostHome, ".hermes", "skills"))).rejects.toThrow();
  });

  it("without skillsHome it still reconciles into the host skills dir (legacy)", async () => {
    await reconcileHermesPaperclipSkills(config());
    expect(await fs.readdir(path.join(hostHome, ".hermes", "skills"))).toEqual(["paperclip"]);
  });
});
