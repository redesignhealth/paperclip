#!/usr/bin/env node
// Upstream-sync scripts for the fork (TECH-9827). Usage: node .github/scripts/upstream-sync/cli.mjs <command> [options]
// Node built-ins, git and gh only: nothing to install, nothing but GitHub to reach.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMANDS = {
  next: () => import("./commands/next.mjs"),
  check: () => import("./commands/check.mjs"),
  "merge-clean": () => import("./commands/merge-clean.mjs"),
  "start-conflict": () => import("./commands/start-conflict.mjs"),
  regenerate: async () => ({ run: (await import("./commands/start-conflict.mjs")).runRegenerate }),
  context: () => import("./commands/context.mjs"),
  "resolution-diff": () => import("./commands/resolution-diff.mjs"),
  submit: () => import("./commands/submit.mjs"),
};

export async function main(argv, io = {}) {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || !COMMANDS[name]) {
    const list = Object.keys(COMMANDS).join(", ");
    process.stderr.write(`usage: cli.mjs <${list}> [options]\n`);
    return name && !COMMANDS[name] && name !== "--help" && name !== "-h" ? 2 : 0;
  }
  const mod = await COMMANDS[name]();
  return mod.run(rest, io);
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true; // cannot tell (for example argv[1] is not a path): run rather than exit 0 doing nothing
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(2); // an error, kept apart from the commands' own result codes (1 = failed checks or blocking findings)
    },
  );
}
