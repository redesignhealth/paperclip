/**
 * Enforces command scanning invariants on Hermes execution when
 * PAPERCLIP_HERMES_COMMAND_SCAN=required is set on the parent server process.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const MANDATORY_COMMAND_SCANNER_PATH = "/usr/local/bin/tirith";

export const FORBIDDEN_ENV_NAMES: Set<string> = new Set([
  "HERMES_YOLO_MODE",
  "HERMES_COMMAND_SCAN_TIMEOUT",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

export const FORBIDDEN_ENV_PREFIXES: string[] = [
  "TIRITH_",
  "HERMES_REQUIRE_COMMAND_SCAN",
  "HERMES_COMMAND_SCANNER",
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
];

export const RESERVED_CLI_FLAGS = [
  "--no-require-command-scan",
  "--without-command-scan",
  "--skip-command-scan",
] as const;

export const CANONICAL_HERMES_BIN = "/opt/hermes/bin/hermes";
export const SYMLINK_HERMES_BIN = "/usr/local/bin/hermes";

export const TRUSTED_HERMES_LAUNCHERS = new Set([
  "hermes",
  CANONICAL_HERMES_BIN,
  SYMLINK_HERMES_BIN,
]);

export interface CommandScanPolicyOptions {
  env: Record<string, string | undefined>;
  hermesCmd: string;
  args: string[];
}

export interface CommandScanPolicyResult {
  env: Record<string, string | undefined>;
  hermesCmd: string;
  args: string[];
}

/**
 * Returns true if the parent server requires mandatory command scanning.
 * Must be read from process.env, never from agent-supplied env.
 */
export function isHermesCommandScanRequired(): boolean {
  return process.env.PAPERCLIP_HERMES_COMMAND_SCAN === "required";
}

function isNonWritableByGroupOrOther(mode: number): boolean {
  return (mode & 0o022) === 0;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function validateFileTrust(filePath: string): void {
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    throw new Error("Untrusted Hermes launcher: stat failed");
  }

  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error("Untrusted Hermes launcher: not a regular file");
  }

  if (st.uid !== 0) {
    throw new Error("Untrusted Hermes launcher: binary must be root-owned");
  }

  if (!isNonWritableByGroupOrOther(st.mode)) {
    throw new Error("Untrusted Hermes launcher: binary is group or world writable");
  }

  if (!isExecutable(st.mode)) {
    throw new Error("Untrusted Hermes launcher: binary is not executable");
  }

  // Ancestry check: validate all parent directories up through root '/'
  let curr = path.dirname(path.resolve(filePath));
  while (curr && curr !== "/") {
    let pst;
    try {
      pst = lstatSync(curr);
    } catch {
      throw new Error("Untrusted Hermes launcher: parent directory stat failed");
    }
    if (pst.isSymbolicLink() || !pst.isDirectory()) {
      throw new Error("Untrusted Hermes launcher: parent directory untrusted");
    }
    if (pst.uid !== 0) {
      throw new Error("Untrusted Hermes launcher: parent directory must be root-owned");
    }
    if (!isNonWritableByGroupOrOther(pst.mode)) {
      throw new Error("Untrusted Hermes launcher: parent directory is group or world writable");
    }
    curr = path.dirname(curr);
  }

  // Validate root '/'
  try {
    const rst = lstatSync("/");
    if (rst.isSymbolicLink() || rst.uid !== 0 || !isNonWritableByGroupOrOther(rst.mode)) {
      throw new Error("Untrusted Hermes launcher: root directory untrusted");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Untrusted Hermes launcher")) {
      throw err;
    }
    throw new Error("Untrusted Hermes launcher: root directory stat failed");
  }
}

/**
 * Validates and resolves the hermes executable to an absolute, trusted, root-owned binary.
 * Prevents PATH shadowing attacks where a user-provided PATH contains a malicious 'hermes'.
 */
export function resolveTrustedHermesLauncher(hermesCmd: string): string {
  const normalized = hermesCmd.trim();
  if (!normalized) {
    throw new Error("Hermes launcher command cannot be empty");
  }

  // Reject anything that is not explicitly named "hermes" or the canonical paths
  if (normalized !== "hermes" && normalized !== CANONICAL_HERMES_BIN && normalized !== SYMLINK_HERMES_BIN) {
    throw new Error("Untrusted Hermes launcher command");
  }

  // If the path exists on disk, resolve symlinks and check root ownership
  if (existsSync(CANONICAL_HERMES_BIN)) {
    let resolved: string;
    try {
      resolved = realpathSync(CANONICAL_HERMES_BIN);
    } catch {
      throw new Error("Untrusted Hermes launcher: realpath resolution failed");
    }

    if (resolved !== CANONICAL_HERMES_BIN && resolved !== SYMLINK_HERMES_BIN) {
      throw new Error("Untrusted Hermes launcher: resolved target is not trusted");
    }

    if (process.platform === "linux") {
      validateFileTrust(resolved);
    }
    return resolved;
  }

  if (existsSync(SYMLINK_HERMES_BIN)) {
    let resolved: string;
    try {
      resolved = realpathSync(SYMLINK_HERMES_BIN);
    } catch {
      throw new Error("Untrusted Hermes launcher: realpath resolution failed");
    }

    if (resolved !== CANONICAL_HERMES_BIN && resolved !== SYMLINK_HERMES_BIN) {
      throw new Error("Untrusted Hermes launcher: resolved target is not trusted");
    }

    if (process.platform === "linux") {
      validateFileTrust(resolved);
    }
    return resolved;
  }

  // Required launcher must exist on disk on production Linux; no unvalidated fallback in production
  if (process.platform === "linux" && process.env.NODE_ENV === "production") {
    throw new Error("Untrusted Hermes launcher: trusted binary not found on disk");
  }

  return CANONICAL_HERMES_BIN;
}

export function validateHermesLauncher(hermesCmd: string): void {
  resolveTrustedHermesLauncher(hermesCmd);
}

export const VALUE_TAKING_OPTIONS = new Set([
  "-q",
  "--query",
  "--query-file",
  "-m",
  "--model",
  "--provider",
  "--reasoning",
  "-s",
  "--skills",
  "-t",
  "--toolsets",
  "--image",
  "-p",
  "--profile",
  "--workdir",
  "--source",
]);

/**
 * Validates CLI arguments to ensure reserved or bypass flags are not present.
 * Uses position-aware parsing:
 * - Skips option values for recognized value-taking options (e.g. -m model)
 * - Recognizes -q=... / --query=... as prompt data
 * - If -q / --query is followed by a token starting with '--', argparse parses it as an option
 * - Rejects any --require-command-scan=... equals-value syntax (store_true does not accept values)
 * - Stops checking controls at '--' option terminator
 */
export function validateHermesArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      break;
    }

    const eqIdx = arg.indexOf("=");
    const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;

    if (VALUE_TAKING_OPTIONS.has(flagName)) {
      if (eqIdx !== -1) {
        // Value is attached via '=' (e.g. -q=--prompt-text) -> value is data, not control
        continue;
      }
      if (i + 1 >= args.length || args[i + 1] === "--") {
        throw new Error(`Option ${flagName} requires a value`);
      }
      const nextToken = args[i + 1];
      // In Python argparse, if nextToken starts with '-', argparse treats it as a flag unless attached with '='.
      // If it does not start with '-', it is normal argument data.
      if (!nextToken.startsWith("-")) {
        i++; // Safely skip the data argument
        continue;
      }
      // If it starts with '-', argparse will parse it as a flag, so do not skip; validate it in the next loop iteration.
      continue;
    }

    for (const reserved of RESERVED_CLI_FLAGS) {
      if (arg === reserved || arg.startsWith(`${reserved}=`)) {
        throw new Error(`Reserved argument flag is not allowed in command-scan mode: ${reserved}`);
      }
    }

    if (arg === "--require-command-scan") {
      if (i + 1 < args.length) {
        const next = args[i + 1];
        if (["0", "false", "no", "off"].includes(next.toLowerCase())) {
          throw new Error("Reserved argument flag is not allowed in command-scan mode: --require-command-scan");
        }
      }
    } else if (arg.startsWith("--require-command-scan=")) {
      throw new Error("Invalid argument syntax: --require-command-scan does not accept values; pass bare flag instead");
    }
  }
}

/**
 * Applies the mandatory command-scan policy to child process execution options.
 *
 * Strips user-supplied overrides (TIRITH_*, HERMES_YOLO_MODE, loader paths),
 * forces HERMES_REQUIRE_COMMAND_SCAN=1 and HERMES_COMMAND_SCANNER to root-owned tirith,
 * ensures PYTHONNOUSERSITE=1, preserves user PATH, and validates the launcher.
 */
export function applyCommandScanPolicy(options: CommandScanPolicyOptions): CommandScanPolicyResult {
  if (!isHermesCommandScanRequired()) {
    return options;
  }

  const { hermesCmd, args } = options;
  const trustedHermesCmd = resolveTrustedHermesLauncher(hermesCmd);
  validateHermesArgs(args);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  // Strip untrusted PYTHON* variables, forbidden user env keys, and prefixes
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("PYTHON") || FORBIDDEN_ENV_NAMES.has(upper)) {
      delete env[key];
      continue;
    }
    for (const prefix of FORBIDDEN_ENV_PREFIXES) {
      if (upper.startsWith(prefix)) {
        delete env[key];
        break;
      }
    }
  }

  // Agent cannot override parent NODE_ENV
  if (process.env.NODE_ENV !== undefined) {
    env.NODE_ENV = process.env.NODE_ENV;
  } else {
    delete env.NODE_ENV;
  }

  // Re-pin mandatory security invariants
  env.PYTHONNOUSERSITE = "1";
  env.HERMES_REQUIRE_COMMAND_SCAN = "1";
  env.HERMES_COMMAND_SCANNER = MANDATORY_COMMAND_SCANNER_PATH;

  // Always prepend mandatory flag at argv[0] so top-level root parser consumes it,
  // avoiding false negative matches if prompt data contains the string '--require-command-scan'.
  const updatedArgs = [...args];
  if (updatedArgs[0] !== "--require-command-scan") {
    updatedArgs.unshift("--require-command-scan");
  }

  return {
    env,
    hermesCmd: trustedHermesCmd,
    args: updatedArgs,
  };
}
