import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  getHermesCommandScanMode,
  isHermesCommandScanRequired,
  applyCommandScanPolicy,
  validateHermesLauncher,
  resolveTrustedHermesLauncher,
  validateHermesArgs,
  VALUE_TAKING_OPTIONS,
  MANDATORY_COMMAND_SCANNER_PATH,
  CANONICAL_HERMES_BIN,
} from "./command-scan-policy.js";

describe("command-scan-policy", () => {
  const originalEnv = process.env.PAPERCLIP_HERMES_COMMAND_SCAN;

  beforeEach(() => {
    delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = originalEnv;
    } else {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    }
  });

  describe("getHermesCommandScanMode", () => {
    it("returns 'off' when PAPERCLIP_HERMES_COMMAND_SCAN is unset", () => {
      expect(getHermesCommandScanMode()).toBe("off");
    });

    it("returns 'off' when PAPERCLIP_HERMES_COMMAND_SCAN is 'off'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
      expect(getHermesCommandScanMode()).toBe("off");
    });

    it("returns 'required' when PAPERCLIP_HERMES_COMMAND_SCAN is 'required'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      expect(getHermesCommandScanMode()).toBe("required");
    });

    it("throws safe error refusing to run Hermes on any invalid value without echoing raw value", () => {
      const invalidValues = [
        "",
        " ",
        "Required",
        "REQUIRED",
        " required",
        "required ",
        "Off",
        "OFF",
        "optional",
        "true",
        "false",
        "1",
        "0",
        "disabled",
      ];
      for (const val of invalidValues) {
        process.env.PAPERCLIP_HERMES_COMMAND_SCAN = val;
        expect(
          () => getHermesCommandScanMode(),
          `expected getHermesCommandScanMode to throw for ${JSON.stringify(val)}`
        ).toThrow(
          'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes'
        );
        try {
          getHermesCommandScanMode();
        } catch (err: unknown) {
          const msg = (err as Error).message;
          if (val.trim()) {
            expect(msg).not.toContain(val);
          }
        }
      }
    });
  });

  describe("isHermesCommandScanRequired", () => {
    it("returns false when PAPERCLIP_HERMES_COMMAND_SCAN is unset or 'off'", () => {
      expect(isHermesCommandScanRequired()).toBe(false);
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "off";
      expect(isHermesCommandScanRequired()).toBe(false);
    });

    it("returns true only when PAPERCLIP_HERMES_COMMAND_SCAN is 'required'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      expect(isHermesCommandScanRequired()).toBe(true);
    });

    it("throws when PAPERCLIP_HERMES_COMMAND_SCAN has an invalid value", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "optional";
      expect(() => isHermesCommandScanRequired()).toThrow(
        'Invalid PAPERCLIP_HERMES_COMMAND_SCAN: expected "required" or "off" (unset = off); refusing to run Hermes'
      );
    });
  });

  describe("validateHermesLauncher", () => {
    it("accepts trusted launchers and resolves to absolute binary", () => {
      expect(resolveTrustedHermesLauncher("hermes")).toMatch(/^\/(opt|usr\/local)\/hermes\/bin\/hermes/);
      expect(resolveTrustedHermesLauncher("/opt/hermes/bin/hermes")).toMatch(/^\/(opt|usr\/local)\/hermes\/bin\/hermes/);
      expect(resolveTrustedHermesLauncher("/usr/local/bin/hermes")).toMatch(/^\/(opt|usr\/local)\/hermes/);
    });

    it("rejects untrusted launchers and fake path shadowing", () => {
      expect(() => validateHermesLauncher("bash")).toThrow(/Untrusted Hermes launcher/);
      expect(() => validateHermesLauncher("python3")).toThrow(/Untrusted Hermes launcher/);
      expect(() => validateHermesLauncher("/tmp/fake-hermes")).toThrow(/Untrusted Hermes launcher/);
      expect(() => validateHermesLauncher("/home/node/bin/hermes")).toThrow(/Untrusted Hermes launcher/);
      expect(() => validateHermesLauncher("")).toThrow(/cannot be empty/);
    });
  });

  describe("validateHermesArgs", () => {
    it("accepts normal args", () => {
      expect(() =>
        validateHermesArgs(["chat", "-q", "hello", "-Q", "--yolo", "-m", "anthropic/claude-sonnet-4"])
      ).not.toThrow();
    });

    it("rejects reserved flags that try to bypass or disable scanning", () => {
      expect(() => validateHermesArgs(["chat", "--no-require-command-scan"])).toThrow(
        /Reserved argument flag is not allowed in command-scan mode: --no-require-command-scan/
      );
      expect(() => validateHermesArgs(["chat", "--require-command-scan=false"])).toThrow(
        /--require-command-scan does not accept values/
      );
    });

    it("pins the exact VALUE_TAKING_OPTIONS surface (kept in lockstep with the real patched parser)", () => {
      // Cross-language parity: every entry must be a REAL value flag of the
      // patched Hermes chat parser (or the pre-argparse -p/--profile pair),
      // and every real required-value chat flag must be present. Verified
      // adversarially against the LOCKED patched parser by
      // scripts/tirith-mandatory-regression.py
      // (TestAdapterArgvParserParity.test_ts_value_taking_options_mirror_the_real_parser_surface).
      // Update BOTH sides in lockstep; do not invent entries here.
      expect([...VALUE_TAKING_OPTIONS].sort()).toEqual([
        "--image",
        "--in",
        "--max-turns",
        "--model",
        "--profile",
        "--provider",
        "--query",
        "--query-file",
        "--reasoning",
        "--resume",
        "--run-budget",
        "--skills",
        "--source",
        "--toolsets",
        "-m",
        "-p",
        "-q",
        "-r",
        "-s",
        "-t",
      ]);
    });

    it("accepts prompt data in the forms the real patched parser treats as data (parity pins)", () => {
      // Paired with the REAL parser facts pinned in
      // tirith-mandatory-regression.py TestAdapterArgvParserParity:
      // real argparse parses each of these as -q/--query DATA.
      expect(() => validateHermesArgs(["chat", "-q", "-5", "-Q"])).not.toThrow(); // negative number value
      expect(() => validateHermesArgs(["chat", "-q=--no-require-command-scan"])).not.toThrow(); // attached '=' data
      expect(() => validateHermesArgs(["chat", "--query=--skip-command-scan"])).not.toThrow();
      expect(() => validateHermesArgs(["chat", "-q=hello world"])).not.toThrow();
      expect(() =>
        validateHermesArgs(["chat", "-q", "What is --no-require-command-scan? and --require-command-scan?"])
      ).not.toThrow();
      expect(() =>
        validateHermesArgs(["chat", "-q", "--no-require-command-scan=explain this option", "-Q"])
      ).not.toThrow();
      expect(() => validateHermesArgs(["chat", "-q", "- bullet point", "-Q"])).not.toThrow();
    });

    it("rejects the argv forms the real patched parser rejects (parity pins)", () => {
      // Paired with the REAL parser facts pinned in
      // tirith-mandatory-regression.py TestAdapterArgvParserParity:
      // real argparse raises SystemExit(2) for each of these.
      expect(() => validateHermesArgs(["chat", "-q"])).toThrow(/Option -q requires a value/); // parser: expected one argument
      expect(() => validateHermesArgs(["chat", "-q", "--", "x"])).toThrow(/Option -q requires a value/); // parser: expected one argument
      expect(() => validateHermesArgs(["chat", "--require-command-scan=false"])).toThrow(
        /--require-command-scan does not accept values/, // parser: ignored explicit argument 'false'
      );
      expect(() => validateHermesArgs(["chat", "--no-require-command-scan"])).toThrow(/Reserved argument flag/); // parser: unrecognized
      expect(() => validateHermesArgs(["chat", "-q", "-Q"])).toThrow(/Option -q requires a value/);
      expect(() => validateHermesArgs(["chat", "-q", "--yolo"])).toThrow(/Option -q requires a value/);
      expect(() => validateHermesArgs(["chat", "-q", "--require-command-scan"])).toThrow(/Option -q requires a value/);
      expect(() => validateHermesArgs(["chat", "-q", "-m=foo bar", "-Q"])).toThrow(/Option -q requires a value/);
      expect(() => validateHermesArgs(["chat", "-q", "--require-command-scan=foo bar", "-Q"])).toThrow(
        /--require-command-scan does not accept values/,
      );
      expect(() => validateHermesArgs(["chat", "-q", "--no-require-command-scan", "-Q"])).toThrow(
        /Reserved argument flag/,
      );
      expect(() => validateHermesArgs(["chat", "-q", "--no-require-command-scan=foo", "-Q"])).toThrow(
        /Reserved argument flag/,
      );
    });

    it("pins the R3-list validator's CURRENT context-blind behavior against the real parser facts (documented divergences)", () => {
      // CURRENT R3-list behavior: the validator is context-blind and does not
      // reject unknown flags. Each acceptance below is paired with a REAL
      // patched-parser fact pinned in tirith-mandatory-regression.py
      // (TestAdapterArgvParserParity): the real parser raises SystemExit(2)
      // for every one of these argv, so the child fails closed at argparse —
      // an availability divergence, never a scan bypass.
      expect(() => validateHermesArgs(["chat", "--workdir", "/tmp"])).not.toThrow(); // parser: unrecognized --workdir (INVENTED entry)
      expect(() => validateHermesArgs(["chat", "--usage-file", "x"])).not.toThrow(); // parser: top-only flag after chat
      expect(() => validateHermesArgs(["chat", "-q", "hi", "--", "--no-require-command-scan"])).not.toThrow(); // parser: post-'--' positionals unrecognized in chat
      expect(() => validateHermesArgs(["chat", "-q", "hi", "--"])).not.toThrow(); // parser: trailing bare '--' unrecognized
    });
  });

  describe("applyCommandScanPolicy", () => {
    it("is a no-op when command scan is not required", () => {
      const input = {
        env: {
          USER_VAR: "hello",
          HERMES_YOLO_MODE: "1",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi"],
      };
      const result = applyCommandScanPolicy(input);
      expect(result).toEqual(input);
    });

    it("enforces invariants and strips forbidden user overrides when required", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const input = {
        env: {
          PATH: "/custom/bin:/usr/bin",
          USER_SETTING: "value",
          TIRITH_ENABLED: "0",
          TIRITH_OFF: "1",
          TIRITH_TIMEOUT: "999",
          HERMES_YOLO_MODE: "1",
          HERMES_REQUIRE_COMMAND_SCAN: "0",
          HERMES_COMMAND_SCANNER: "/untrusted/scanner",
          PYTHONPATH: "/malicious/pkg",
          PYTHONHOME: "/malicious/python",
          PYTHONSTARTUP: "/malicious/startup.py",
          PYTHONUSERBASE: "/malicious/site-packages",
          LD_PRELOAD: "/malicious/lib.so",
          LD_LIBRARY_PATH: "/malicious/lib",
          LD_AUDIT: "/malicious/audit.so",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "do work", "-Q"],
      };

      const result = applyCommandScanPolicy(input);

      // Preserved legitimate environment
      expect(result.env.PATH).toBe("/custom/bin:/usr/bin");
      expect(result.env.USER_SETTING).toBe("value");

      // Replaced bare hermes with validated absolute executable
      expect(result.hermesCmd).toMatch(/^\/(opt|usr\/local)\/hermes/);

      // Stripped forbidden keys
      expect(result.env.TIRITH_ENABLED).toBeUndefined();
      expect(result.env.TIRITH_OFF).toBeUndefined();
      expect(result.env.TIRITH_TIMEOUT).toBeUndefined();
      expect(result.env.HERMES_YOLO_MODE).toBeUndefined();
      expect(result.env.PYTHONPATH).toBeUndefined();
      expect(result.env.PYTHONHOME).toBeUndefined();
      expect(result.env.PYTHONSTARTUP).toBeUndefined();
      expect(result.env.PYTHONUSERBASE).toBeUndefined();
      expect(result.env.LD_PRELOAD).toBeUndefined();
      expect(result.env.LD_LIBRARY_PATH).toBeUndefined();
      expect(result.env.LD_AUDIT).toBeUndefined();

      // Pinned mandatory invariants
      expect(result.env.PYTHONNOUSERSITE).toBe("1");
      expect(result.env.HERMES_REQUIRE_COMMAND_SCAN).toBe("1");
      expect(result.env.HERMES_COMMAND_SCANNER).toBe(MANDATORY_COMMAND_SCANNER_PATH);

      // Added CLI flag prepended at index 0
      expect(result.args[0]).toBe("--require-command-scan");
      expect(result.args).toContain("--require-command-scan");
    });

    it("strips every PYTHON* env key in any case and re-pins PYTHONNOUSERSITE=1 after stripping", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";

      const result = applyCommandScanPolicy({
        env: {
          PYTHONPLATLIBDIR: "/attacker/lib",
          PYTHON_FROZEN_MODULES: "0",
          python_frozen_modules: "0",
          PYTHONWARNINGS: "ignore",
          pythonwarnings: "ignore::DeprecationWarning",
          PYTHONNOUSERSITE: "0", // must be stripped and re-pinned below
          PYTHONHASHSEED: "0",
          pythondontwritebytecode: "0",
          USER_KEEP: "value",
        },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });

      expect(result.env.PYTHONPLATLIBDIR).toBeUndefined();
      expect(result.env.PYTHON_FROZEN_MODULES).toBeUndefined();
      expect(result.env.python_frozen_modules).toBeUndefined();
      expect(result.env.PYTHONWARNINGS).toBeUndefined();
      expect(result.env.pythonwarnings).toBeUndefined();
      expect(result.env.PYTHONHASHSEED).toBeUndefined();
      expect(result.env.pythondontwritebytecode).toBeUndefined();
      // The agent's PYTHONNOUSERSITE=0 was stripped and the invariant re-pinned.
      expect(result.env.PYTHONNOUSERSITE).toBe("1");
      expect(result.env.USER_KEEP).toBe("value");
    });

    it("pins NODE_ENV to the parent server's value and never lets the agent override it in either direction", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const originalNodeEnv = process.env.NODE_ENV;

      try {
        // Parent set: agent's NODE_ENV is overridden by the parent's pin.
        process.env.NODE_ENV = "production";
        const overridden = applyCommandScanPolicy({
          env: { NODE_ENV: "development", USER_VAR: "x" },
          hermesCmd: "hermes",
          args: ["chat", "-q", "hi", "-Q"],
        });
        expect(overridden.env.NODE_ENV).toBe("production");

        // Parent unset: the agent's NODE_ENV is removed entirely.
        delete process.env.NODE_ENV;
        const removed = applyCommandScanPolicy({
          env: { NODE_ENV: "development", USER_VAR: "x" },
          hermesCmd: "hermes",
          args: ["chat", "-q", "hi", "-Q"],
        });
        expect(removed.env.NODE_ENV).toBeUndefined();
      } finally {
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
      }
    });

    it("preserves the user-supplied PATH verbatim", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      const agentPath = "/agent/home/bin:/usr/local/bin:/usr/bin:/bin";
      const result = applyCommandScanPolicy({
        env: { PATH: agentPath },
        hermesCmd: "hermes",
        args: ["chat", "-q", "hi", "-Q"],
      });
      expect(result.env.PATH).toBe(agentPath);
      // PATH is preserved, so the launcher must be the resolved absolute
      // trusted binary (PATH-shadowing guard is pinned in the regression file).
      expect(path.isAbsolute(result.hermesCmd)).toBe(true);
    });
  });
});
