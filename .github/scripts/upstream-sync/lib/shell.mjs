// Run a command and keep the tail of its output. Used by `check` for typecheck, tests and generators.
import { spawnSync } from "node:child_process";

export function tail(text, max = 4000) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

/** Run an argv array (no shell). */
export function runArgv(cwd, argv, { env } = {}) {
  const [cmd, ...args] = argv;
  // A `node --test` parent marks its children; a nested `node --test` run would then hide failures.
  const base = { ...process.env, ...env };
  delete base.NODE_TEST_CONTEXT;
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: base,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { ok: r.status === 0 && !r.error, status: r.status, output, stdout: r.stdout ?? "" };
}

/** Run an operator-supplied command line through the shell (the `--typecheck-cmd` / `--test-cmd` overrides). */
export function runShell(cwd, line, { env } = {}) {
  return runArgv(cwd, ["sh", "-c", line], { env });
}

/** Single-quote one argument for `sh -c`. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
