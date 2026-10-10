import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isHermesCommandScanRequired,
  applyCommandScanPolicy,
  validateHermesLauncher,
  resolveTrustedHermesLauncher,
  validateHermesArgs,
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

  describe("isHermesCommandScanRequired", () => {
    it("returns false when PAPERCLIP_HERMES_COMMAND_SCAN is unset", () => {
      expect(isHermesCommandScanRequired()).toBe(false);
    });

    it("returns false when PAPERCLIP_HERMES_COMMAND_SCAN is not 'required'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "optional";
      expect(isHermesCommandScanRequired()).toBe(false);
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "1";
      expect(isHermesCommandScanRequired()).toBe(false);
    });

    it("returns true only when PAPERCLIP_HERMES_COMMAND_SCAN is 'required'", () => {
      process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
      expect(isHermesCommandScanRequired()).toBe(true);
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

      // Added CLI flag
      expect(result.args).toContain("--require-command-scan");
    });
  });
});
