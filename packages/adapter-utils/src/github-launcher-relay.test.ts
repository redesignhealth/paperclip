import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

const TOKEN = "run-token_123";
const RELAY_KEY = `url.http://paperclip:${TOKEN}@127.0.0.1:41234/api/package-relay/github/redesignhealth/rh-maiea.insteadOf`;

/** Runs the real launcher as `git` in front of a fake git that prints the GIT_CONFIG_* it receives. */
async function run(extra: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-launcher-relay-"));
  roots.push(root);
  const launch = path.join(root, "launch");
  const bin = path.join(root, "bin");
  await mkdir(launch);
  await mkdir(bin);
  await writeFile(path.join(launch, "git"), githubLauncherSource(), { mode: 0o700 });
  await chmod(path.join(launch, "git"), 0o700);
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nenv | grep '^GIT_CONFIG_' | sort\n", { mode: 0o700 });
  const { stdout } = await exec(process.execPath, [path.join(launch, "git")], {
    env: { HOME: root, PATH: `${launch}:${bin}:/usr/bin:/bin`, GH_CONFIG_DIR: root, PAPERCLIP_API_URL: "http://127.0.0.1:41234", PAPERCLIP_API_KEY: TOKEN, ...extra },
  });
  return Object.fromEntries(stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

describe("github launcher keeps the git relay rules (TECH-9786)", () => {
  it("appends the relay insteadOf rules after the launcher's own entries", async () => {
    const env = await run({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: RELAY_KEY, GIT_CONFIG_VALUE_0: "https://github.com/redesignhealth/rh-maiea" });
    expect(env.GIT_CONFIG_COUNT).toBe("6");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_KEY_5).toBe(RELAY_KEY);
    expect(env.GIT_CONFIG_VALUE_5).toBe("https://github.com/redesignhealth/rh-maiea");
  });

  it("still drops any other GIT_CONFIG_* an agent supplies, and relay-shaped rules for another host or token", async () => {
    const env = await run({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "evil",
      GIT_CONFIG_KEY_1: `url.http://paperclip:${TOKEN}@evil.example.com:1/api/package-relay/github/x/y.insteadOf`, GIT_CONFIG_VALUE_1: "https://github.com/x/y",
      GIT_CONFIG_KEY_2: "url.http://paperclip:other-token@127.0.0.1:41234/api/package-relay/github/x/y.insteadOf", GIT_CONFIG_VALUE_2: "https://github.com/x/y",
    });
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(Object.values(env).join("\n")).not.toMatch(/evil|other-token/);
  });

  it("refuses a relay-shaped rule that rewrites something other than a github.com URL", async () => {
    const env = await run({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: RELAY_KEY, GIT_CONFIG_VALUE_0: "https://evil.example.com/x" });
    expect(env.GIT_CONFIG_COUNT).toBe("5");
  });
});
