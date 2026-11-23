import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { wrapCommandWithCwd, wrapCommandWithEnv } from "../../src/pod-exec.js";

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "wrap-cwd-")));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function run(argv: string[]) {
  const [cmd, ...args] = argv;
  return spawnSync(cmd!, args, { cwd: "/", encoding: "utf8" });
}

describe("wrapCommandWithCwd", () => {
  it("returns the command unchanged without an absolute cwd", () => {
    const cmd = ["pwd"];
    expect(wrapCommandWithCwd(cmd, undefined)).toBe(cmd);
    expect(wrapCommandWithCwd(cmd, "")).toBe(cmd);
    expect(wrapCommandWithCwd(cmd, "relative/dir")).toBe(cmd);
  });

  it("runs the command from the requested workspace directory, not the process default", () => {
    const result = run(wrapCommandWithCwd(["pwd"], DIR));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(DIR);
  });

  it("keeps the default directory when the cwd does not exist", () => {
    const result = run(wrapCommandWithCwd(["pwd"], join(DIR, "missing")));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/");
  });

  it("passes arguments and shell metacharacters in cwd through verbatim", () => {
    const result = run(wrapCommandWithCwd(["/bin/sh", "-c", 'echo "$1"', "x", "a b;c"], `${DIR}/$(touch pwned)`));
    expect(result.stdout.trim()).toBe("a b;c");
  });

  it("composes with the env wrapper (cwd applied, env exported)", () => {
    const wrapped = wrapCommandWithEnv(
      wrapCommandWithCwd(["/bin/sh", "-c", 'echo "$PWD:$FOO"'], DIR),
      { FOO: "bar" },
    );
    const [cmd, ...args] = wrapped.command;
    const result = spawnSync(cmd!, args, { cwd: "/", input: wrapped.stdin as Buffer, encoding: "utf8" });
    expect(result.stdout.trim()).toBe(`${DIR}:bar`);
  });
});
