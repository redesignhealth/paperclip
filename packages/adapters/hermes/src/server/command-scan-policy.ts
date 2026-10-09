/**
 * Enforces command scanning invariants on Hermes execution when
 * PAPERCLIP_HERMES_COMMAND_SCAN=required is set on the parent server process.
 */

import { existsSync, realpathSync, statSync } from "node:fs";

export const MANDATORY_COMMAND_SCANNER_PATH = "/usr/local/bin/tirith";

export const FORBIDDEN_ENV_NAMES = [
  "HERMES_YOLO_MODE",
  "HERMES_COMMAND_SCAN_TIMEOUT",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PYTHONINSPECT",
  "PYTHONEXECUTABLE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
] as const;

export const FORBIDDEN_ENV_PREFIXES = [
  "TIRITH_",
  "HERMES_REQUIRE_COMMAND_SCAN",
  "HERMES_COMMAND_SCANNER",
  "LD_",
] as const;

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
    throw new Error(`Untrusted Hermes launcher command: ${normalized}`);
  }

  // If the path exists on disk, resolve symlinks and check root ownership
  if (existsSync(CANONICAL_HERMES_BIN)) {
    let resolved = CANONICAL_HERMES_BIN;
    try {
      resolved = realpathSync(CANONICAL_HERMES_BIN);
    } catch {}

    if (process.platform === "linux") {
      try {
        const st = statSync(resolved);
        if (st.uid !== 0) {
          throw new Error("Untrusted Hermes launcher: binary must be root-owned");
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith("Untrusted")) {
          throw err;
        }
        throw new Error(
          `Untrusted Hermes launcher: stat failed on ${resolved}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return CANONICAL_HERMES_BIN;
  }

  if (existsSync(SYMLINK_HERMES_BIN)) {
    let resolved = SYMLINK_HERMES_BIN;
    try {
      resolved = realpathSync(SYMLINK_HERMES_BIN);
    } catch {}

    if (process.platform === "linux") {
      try {
        const st = statSync(resolved);
        if (st.uid !== 0) {
          throw new Error("Untrusted Hermes launcher: binary must be root-owned");
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith("Untrusted")) {
          throw err;
        }
        throw new Error(
          `Untrusted Hermes launcher: stat failed on ${resolved}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return resolved;
  }

  // In test / development environment without files on disk, replace bare "hermes" with canonical absolute path
  return CANONICAL_HERMES_BIN;
}

export function validateHermesLauncher(hermesCmd: string): void {
  resolveTrustedHermesLauncher(hermesCmd);
}

/**
 * Validates CLI arguments to ensure reserved or bypass flags are not present.
 */
export function validateHermesArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const reserved of RESERVED_CLI_FLAGS) {
      if (arg === reserved || arg.startsWith(`${reserved}=`)) {
        throw new Error(`Reserved argument flag is not allowed in command-scan mode: ${reserved}`);
      }
    }
    if (arg === "--require-command-scan" && i + 1 < args.length) {
      const next = args[i + 1];
      if (["0", "false", "no", "off"].includes(next.toLowerCase())) {
        throw new Error("Reserved argument flag is not allowed in command-scan mode: --require-command-scan");
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
  const trustedHermesCmd = resolveTrustedHermesLauncher(hermesCmd);
  validateHermesArgs(args);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

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
    hermesCmd: trustedHermesCmd,
    args: updatedArgs,
  };
}
