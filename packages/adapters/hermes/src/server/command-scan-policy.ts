/**
 * Enforces command scanning invariants on Hermes execution when
 * PAPERCLIP_HERMES_COMMAND_SCAN=required is set on the parent server process.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { HERMES_CLI } from "../shared/constants.js";

export const MANDATORY_COMMAND_SCANNER_PATH = "/usr/local/bin/tirith";

export const FORBIDDEN_ENV_NAMES = [
  "HERMES_YOLO_MODE",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
] as const;

export const FORBIDDEN_ENV_PREFIXES = [
  "TIRITH_",
  "HERMES_REQUIRE_COMMAND_SCAN",
  "HERMES_COMMAND_SCANNER",
] as const;

export const RESERVED_CLI_FLAGS = [
  "--no-require-command-scan",
  "--without-command-scan",
  "--skip-command-scan",
] as const;

export const TRUSTED_HERMES_LAUNCHERS = new Set([
  "hermes",
  "/opt/hermes/bin/hermes",
  "/usr/local/bin/hermes",
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

/**
 * Validates that the hermes executable resolves to a trusted, root-owned binary.
 */
export function validateHermesLauncher(hermesCmd: string): void {
  const normalized = hermesCmd.trim();
  if (!normalized) {
    throw new Error("Hermes launcher command cannot be empty");
  }

  // If the path exists on disk, resolve symlinks and check root ownership
  if (existsSync(normalized)) {
    let resolved: string;
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = normalized;
    }

    if (!TRUSTED_HERMES_LAUNCHERS.has(normalized) && !TRUSTED_HERMES_LAUNCHERS.has(resolved)) {
      throw new Error(`Untrusted Hermes launcher command: ${normalized}`);
    }

    if (process.platform === "linux") {
      try {
        const st = statSync(resolved);
        if (st.uid !== 0) {
          throw new Error(`Untrusted Hermes launcher: binary must be root-owned`);
        }
      } catch (err: any) {
        if (err?.message?.includes("Untrusted")) throw err;
      }
    }
    return;
  }

  // If not on disk (e.g. non-Linux test env or PATH-based 'hermes'), verify against allowed trusted names
  if (!TRUSTED_HERMES_LAUNCHERS.has(normalized)) {
    throw new Error(`Untrusted Hermes launcher command: ${normalized}`);
  }
}

/**
 * Validates CLI arguments to ensure reserved or bypass flags are not present.
 */
export function validateHermesArgs(args: string[]): void {
  for (const arg of args) {
    for (const reserved of RESERVED_CLI_FLAGS) {
      if (arg === reserved || arg.startsWith(`${reserved}=`)) {
        throw new Error(`Reserved argument flag is not allowed in command-scan mode: ${reserved}`);
      }
    }
    if (arg.startsWith("--require-command-scan=") && !["1", "true"].includes(arg.split("=")[1])) {
      throw new Error(`Reserved argument flag is not allowed in command-scan mode: ${arg.split("=")[0]}`);
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
  validateHermesLauncher(hermesCmd);
  validateHermesArgs(args);

  const env = { ...options.env };

  // Strip forbidden user env keys and prefixes
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENV_NAMES.includes(key as any)) {
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

  // Re-pin mandatory security invariants
  env.PYTHONNOUSERSITE = "1";
  env.HERMES_REQUIRE_COMMAND_SCAN = "1";
  env.HERMES_COMMAND_SCANNER = MANDATORY_COMMAND_SCANNER_PATH;

  // Ensure CLI flag is also passed
  const updatedArgs = [...args];
  if (!updatedArgs.includes("--require-command-scan")) {
    updatedArgs.push("--require-command-scan");
  }

  return {
    env,
    hermesCmd,
    args: updatedArgs,
  };
}
