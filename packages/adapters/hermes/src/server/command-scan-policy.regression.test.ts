/**
 * TECH-7355 independent security regression (mandatory Hermes command scan).
 *
 * These tests pin the EFFECTIVE contract of the parent-side launcher policy at the
 * real spawn seam — not string assertions on the Dockerfile. They complement (and
 * deliberately do not duplicate) command-scan-policy.test.ts / execute.command-scan.test.ts:
 *
 *  1. H-1 (now fixed in the working tree by resolveTrustedHermesLauncher): under
 *     PAPERCLIP_HERMES_COMMAND_SCAN=required the bare trusted launcher name "hermes"
 *     (the resolveHermesCommand default) used to be resolved by runChildProcess through
 *     the CHILD env PATH — which agent config.env controls — allowing a user-supplied
 *     PATH to shadow the real /usr/local/bin/hermes with an arbitrary executable that
 *     ignores HERMES_REQUIRE_COMMAND_SCAN / --require-command-scan. This test drives the
 *     REAL spawn seam (runChildProcess -> resolveCommandPath -> spawn, shell:false) and
 *     guards the fix: the policy must hand runChildProcess an absolute trusted launcher,
 *     so a PATH-shadowed 'hermes' can never execute (spawn of the trusted absolute path
 *     either runs it or fails closed with ENOENT — never the shadow).
 *  2. Uncovered real branches of command-scan-policy.ts: reserved-flag synonyms and
 *     `--`-terminated argv, `--require-command-scan=<val>` value whitelist, exact-match
 *     forbidden-name stripping vs uppercased prefix stripping, child-side
 *     PAPERCLIP_HERMES_COMMAND_SCAN inertness, parent-gate strict equality, duplicate
 *     flag append behavior, launcher whitespace trimming.
 *
 * This file intentionally does NOT mock @paperclipai/adapter-utils/server-utils:
 * the real runChildProcess / resolveCommandPath / spawn chain is the production seam.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  applyCommandScanPolicy,
  isHermesCommandScanRequired,
  resolveTrustedHermesLauncher,
  validateHermesArgs,
  validateHermesLauncher,
  CANONICAL_HERMES_BIN,
  SYMLINK_HERMES_BIN,
  MANDATORY_COMMAND_SCANNER_PATH,
} from "./command-scan-policy.js";

describe("command-scan-policy security regression (TECH-7355)", () => {
  const originalScanEnv = process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  let workDir: string | null = null;

  beforeEach(() => {
    delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  });

  afterEach(() => {
    if (originalScanEnv !== undefined) {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = originalScanEnv;
    } else {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  describe("MANDATORY-SCAN H-1: agent PATH must not shadow the bare trusted launcher", () => {
    it(
      "required mode must resolve the launcher to the absolute trusted binary, never a PATH shadow (real spawn seam)",
      { timeout: 60_000 },
      async () => {
        process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
        workDir = mkdtempSync(path.join(os.tmpdir(), "cmdscan-regression-"));
        const shadowDir = path.join(workDir, "shadow-bin");
        mkdirSync(shadowDir, { recursive: true });
        const markerPath = path.join(workDir, "shadow-launcher-executed.marker");
        // Benign instrumented stub: records that it ran, exits 0. It represents an
        // attacker-supplied launcher that ignores the mandatory-scan env/argv.
        writeFileSync(
          path.join(shadowDir, "hermes"),
          `#!/bin/sh\nprintf 'shadow-launcher-executed' > ${JSON.stringify(markerPath)}\nexit 0\n`,
          { mode: 0o755 },
        );
        chmodSync(path.join(shadowDir, "hermes"), 0o755);

        const serverPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
        // Agent adapterConfig as wired by execute.ts: userEnv is merged unrestricted
        // (execute.ts:1465-1469) and the default launcher is the bare HERMES_CLI name.
        const agentEnv: Record<string, string | undefined> = {
          PATH: `${shadowDir}:${serverPath}`,
          HOME: workDir,
          HERMES_YOLO_MODE: "1",
          PYTHONPATH: "/attacker/pkg",
        };

        // The policy applies every mandatory invariant AND — per the H-1 fix — must
        // hand back an ABSOLUTE trusted launcher, never the bare PATH-resolved name.
        const policy = applyCommandScanPolicy({
          env: agentEnv,
          hermesCmd: "hermes",
          args: ["chat", "-q", "summarize the repo", "-Q", "--yolo"],
        });
        expect(policy.args).toContain("--require-command-scan");
        expect(policy.env.HERMES_REQUIRE_COMMAND_SCAN).toBe("1");
        expect(policy.env.HERMES_COMMAND_SCANNER).toBe(MANDATORY_COMMAND_SCANNER_PATH);
        expect(policy.env.PYTHONPATH).toBeUndefined();
        expect(policy.hermesCmd).not.toBe("hermes");
        expect(path.isAbsolute(policy.hermesCmd)).toBe(true);
        expect(policy.hermesCmd).toMatch(/^\/(opt|usr\/local)\/hermes/);
        expect(policy.hermesCmd.startsWith(shadowDir)).toBe(false);

        // Drive the REAL production seam with exactly what execute.ts passes. On a
        // host without a real Hermes install the trusted absolute path fails closed
        // with ENOENT; on a host with one it runs the real launcher. Either outcome
        // is acceptable — executing the PATH shadow is NOT.
        let spawnError: Error | null = null;
        try {
          await runChildProcess("cmdscan-regression-h1", policy.hermesCmd, policy.args, {
            cwd: workDir,
            env: policy.env as Record<string, string>,
            timeoutSec: 30,
            graceSec: 5,
            onLog: async () => {},
          });
        } catch (err) {
          spawnError = err instanceof Error ? err : new Error(String(err));
        }
        if (spawnError) {
          // Fail-closed is fine, but only for the TRUSTED path — never the shadow.
          // (The message's PATH diagnostic legitimately echoes env.PATH; assert on
          // the failed COMMAND itself.)
          const failedCmd = spawnError.message.match(/Failed to start command "([^"]+)"/)?.[1] ?? "";
          expect(failedCmd).toMatch(/^\/(opt|usr\/local)\/hermes/);
          expect(failedCmd).not.toBe(path.join(shadowDir, "hermes"));
        }
        expect(
          existsSync(markerPath),
          "MANDATORY SCAN BYPASS (H-1): the bare trusted launcher name 'hermes' resolved through the " +
            "agent-controlled child env PATH and executed a user-supplied binary. applyCommandScanPolicy " +
            "must resolve the launcher to the absolute trusted binary (resolveTrustedHermesLauncher).",
        ).toBe(false);
      },
    );

    it("launcher resolution never returns the bare name or a cwd/temp path, even with decoys on disk", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      workDir = mkdtempSync(path.join(os.tmpdir(), "cmdscan-regression-decoy-"));
      // A cwd-local file literally named 'hermes' must not influence resolution.
      writeFileSync(path.join(workDir, "hermes"), "decoy", { mode: 0o755 });
      const resolved = resolveTrustedHermesLauncher("hermes");
      expect(resolved).not.toBe("hermes");
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toMatch(/^\/(opt|usr\/local)\/hermes/);
      expect(resolved.startsWith(workDir)).toBe(false);
      expect(CANONICAL_HERMES_BIN).toBe("/opt/hermes/bin/hermes");
      expect(SYMLINK_HERMES_BIN).toBe("/usr/local/bin/hermes");
    });

    it("root cause pin: required-mode policy still preserves an agent-supplied PATH verbatim (now inert for launcher resolution)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const agentPath = "/attacker/home/bin:/usr/local/bin:/usr/bin:/bin";
      const result = applyCommandScanPolicy({
        env: { PATH: agentPath, USER_VAR: "x" },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      // PATH is not in FORBIDDEN_ENV_NAMES / FORBIDDEN_ENV_PREFIXES, so a user-controlled
      // PATH still reaches the child. Since the H-1 fix the launcher is absolute, so this
      // can no longer shadow 'hermes' — pinned here so any regression to a bare-name
      // launcher is caught by the seam test above.
      expect(result.env.PATH).toBe(agentPath);
      expect(path.isAbsolute(result.hermesCmd)).toBe(true);
    });
  });

  describe("parent gate is exact-string and process.env-only", () => {
    it("only the exact string 'required' enables the policy (no bool/number coercion, no case/whitespace tolerance)", () => {
      for (const notRequired of ["Required", "REQUIRED", " required", "required ", "1", "true", "yes", "off", ""]) {
        process.env.PAPERCLIP_HERMES_COMMAND_SCAN = notRequired;
        expect(isHermesCommandScanRequired(), `value ${JSON.stringify(notRequired)} must not enable required mode`).toBe(false);
      }
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      expect(isHermesCommandScanRequired()).toBe(true);
    });

    it("agent config.env cannot enable required mode when the parent did not (legacy optional stays unchanged)", () => {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
      const input = {
        env: { PAPERCLIP_HERMES_COMMAND_SCAN: "required", TIRITH_ENABLED: "1", HERMES_YOLO_MODE: "1" },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      };
      // isHermesCommandScanRequired reads process.env only — the agent-supplied value
      // flows to the child (where nothing reads PAPERCLIP_*) but cannot activate policy.
      const result = applyCommandScanPolicy(input);
      expect(result).toEqual(input);
      expect(result.args).not.toContain("--require-command-scan");
    });

    it("child-side PAPERCLIP_HERMES_COMMAND_SCAN=off from agent env cannot disable parent-required enforcement", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const result = applyCommandScanPolicy({
        env: {
          PAPERCLIP_HERMES_COMMAND_SCAN: "off",
          HERMES_REQUIRE_COMMAND_SCAN: "0",
          HERMES_COMMAND_SCANNER: "/attacker/tirith",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      // Enforcement is parent-gated; child invariants are re-pinned after stripping.
      expect(result.env.HERMES_REQUIRE_COMMAND_SCAN).toBe("1");
      expect(result.env.HERMES_COMMAND_SCANNER).toBe(MANDATORY_COMMAND_SCANNER_PATH);
      expect(result.args).toContain("--require-command-scan");
    });
  });

  describe("reserved CLI flags: synonyms, values, and '--' termination", () => {
    it("rejects every reserved bypass synonym, including '='-attached forms", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      for (const flag of ["--no-require-command-scan", "--without-command-scan", "--skip-command-scan"]) {
        expect(() => validateHermesArgs(["chat", flag]), flag).toThrow(/Reserved argument flag/);
        expect(() => validateHermesArgs(["chat", `${flag}=now`]), `${flag}=now`).toThrow(/Reserved argument flag/);
      }
    });

    it("rejects '--require-command-scan=' with any value (Item 8)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      for (const val of ["0", "1", "false", "true", "yes", "no", "off", "1=x"]) {
        expect(() => validateHermesArgs(["chat", `--require-command-scan=${val}`]), `=${val}`).toThrow(
          /--require-command-scan does not accept values/,
        );
      }
      expect(() => validateHermesArgs(["chat", "--require-command-scan"])).not.toThrow();
    });

    it("always prepends mandatory flag at argv[0] even if prompt data contains the flag string (P0)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const promptWithFlag = "How do I configure --require-command-scan?";
      const res = applyCommandScanPolicy({
        env: {},
        hermesCmd: "hermes",
        args: ["chat", "-q", promptWithFlag, "-Q", "-s", "github"],
      });

      expect(res.args[0]).toBe("--require-command-scan");
      expect(res.args[1]).toBe("chat");
      expect(res.args[2]).toBe("-q");
      expect(res.args[3]).toBe(promptWithFlag);
      expect(res.args[4]).toBe("-Q");
    });

    it("inserts mandatory flag before option terminator '--' and after subcommand (Item 9)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const resTerminator = applyCommandScanPolicy({
        env: {},
        hermesCmd: "hermes",
        args: ["chat", "--", "echo", "hello"],
      });
      const dashDashIndex = resTerminator.args.indexOf("--");
      const flagIndex = resTerminator.args.indexOf("--require-command-scan");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(flagIndex).toBeLessThan(dashDashIndex);

      expect(() => validateHermesArgs(["chat", "-m"])).toThrow(/requires a value/);
      expect(() => validateHermesArgs(["chat", "-q"])).toThrow(/requires a value/);
    });

    it("accepts prompt data with -q=... syntax for leading dashes and regular text (Item 10)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      expect(() => validateHermesArgs(["chat", "-q=--no-require-command-scan"])).not.toThrow();
      expect(() => validateHermesArgs(["chat", "--query=--skip-command-scan"])).not.toThrow();
      expect(() => validateHermesArgs(["chat", "-q", "What is --no-require-command-scan?"])).not.toThrow();
      expect(() => validateHermesArgs(["chat", "-q", "--no-require-command-scan"])).toThrow(/Reserved argument flag/);
    });
  });

  describe("forbidden env stripping: exact names vs uppercased prefixes", () => {
    it("strips case-variant scanner/yolo override keys via the uppercased prefix rules", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const result = applyCommandScanPolicy({
        env: {
          tirith_enabled: "0",
          Tirith_Off: "1",
          Hermes_Command_Scanner: "/attacker/tirith",
          hermes_require_command_scan: "0",
          TIRITH_POLICY: "/evil.yaml",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      expect(result.env.tirith_enabled).toBeUndefined();
      expect(result.env["Tirith_Off"]).toBeUndefined();
      expect(result.env.Hermes_Command_Scanner).toBeUndefined();
      expect(result.env.hermes_require_command_scan).toBeUndefined();
      expect(result.env.TIRITH_POLICY).toBeUndefined();
      expect(result.env.HERMES_COMMAND_SCANNER).toBe(MANDATORY_COMMAND_SCANNER_PATH);
      expect(result.env.HERMES_REQUIRE_COMMAND_SCAN).toBe("1");
    });

    it("strips lowercase forbidden keys like 'hermes_yolo_mode' and 'pythonpath'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const result = applyCommandScanPolicy({
        env: { hermes_yolo_mode: "1", pythonpath: "/x" },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      expect(result.env.hermes_yolo_mode).toBeUndefined();
      expect(result.env.pythonpath).toBeUndefined();
      expect(result.env.HERMES_YOLO_MODE).toBeUndefined();
      expect(result.env.PYTHONPATH).toBeUndefined();
      expect(result.env.PYTHONNOUSERSITE).toBe("1");
    });

    it("strips shell startup and python loader control variables (S9)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const result = applyCommandScanPolicy({
        env: {
          BASH_ENV: "/evil/bashrc",
          ENV: "/evil/shrc",
          SHELLOPTS: "xtrace",
          BASHOPTS: "autocd",
          PS4: "+x",
          PROMPT_COMMAND: "echo evil",
          "BASH_FUNC_myfunc%%": "() { echo evil; }",
          PYTHONSAFEPATH: "0",
          PYTHONWARNINGS: "ignore",
          PYTHONBREAKPOINT: "pdb.set_trace",
          PYTHONPYCACHEPREFIX: "/tmp/pycache",
          DYLD_INSERT_LIBRARIES: "/evil/hook.dylib",
          DYLD_LIBRARY_PATH: "/evil/lib",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      expect(result.env.BASH_ENV).toBeUndefined();
      expect(result.env.ENV).toBeUndefined();
      expect(result.env.SHELLOPTS).toBeUndefined();
      expect(result.env.BASHOPTS).toBeUndefined();
      expect(result.env.PS4).toBeUndefined();
      expect(result.env.PROMPT_COMMAND).toBeUndefined();
      expect(result.env["BASH_FUNC_myfunc%%"]).toBeUndefined();
      expect(result.env.PYTHONSAFEPATH).toBeUndefined();
      expect(result.env.PYTHONWARNINGS).toBeUndefined();
      expect(result.env.PYTHONBREAKPOINT).toBeUndefined();
      expect(result.env.PYTHONPYCACHEPREFIX).toBeUndefined();
      expect(result.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(result.env.DYLD_LIBRARY_PATH).toBeUndefined();
    });
  });

  describe("launcher validation", () => {
    it("trims surrounding whitespace before validating the trusted launcher name", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      expect(() => validateHermesLauncher("  /opt/hermes/bin/hermes  ")).not.toThrow();
      expect(() => validateHermesLauncher(" hermes\t")).not.toThrow();
      expect(() => validateHermesLauncher("   ")).toThrow(/cannot be empty/);
      expect(() => validateHermesLauncher("/tmp/fake-hermes")).toThrow(/Untrusted Hermes launcher/);
    });

    it("rejects untrusted file permissions and missing binaries on Linux in production (S8)", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const originalPlatformDesc = Object.getOwnPropertyDescriptor(process, "platform");
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        process.env.NODE_ENV = "production";

        // Missing launcher binary on Linux in production must throw
        expect(() => resolveTrustedHermesLauncher("/opt/hermes/bin/hermes")).toThrow(
          /trusted binary not found on disk/,
        );
      } finally {
        if (originalPlatformDesc) {
          Object.defineProperty(process, "platform", originalPlatformDesc);
        }
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
      }
    });
  });
});
