import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureAndScrubPlatformDefaultRouterKey,
  PAPERCLIP_DEFAULT_ROUTER_API_KEY,
  readPlatformDefaultRouterKey,
  PAPERCLIP_PLATFORM_ROUTER_RECONCILE,
  isPlatformRouterReconcileEnabled,
  __resetForTests,
} from "../platform-default-router-key.js";

describe("platform-default-router-key", () => {
  beforeEach(() => {
    __resetForTests();
    delete process.env[PAPERCLIP_DEFAULT_ROUTER_API_KEY];
  });

  afterEach(() => {
    __resetForTests();
    delete process.env[PAPERCLIP_DEFAULT_ROUTER_API_KEY];
  });

  it("captures valid printable non-whitespace ASCII key and immediately deletes it from env", () => {
    const validKey = "sk-test-valid-key-with-enough-characters-1234567890";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: validKey,
      OTHER_VAR: "preserve-me",
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: true, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBe(validKey);
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
    expect(PAPERCLIP_DEFAULT_ROUTER_API_KEY in testEnv).toBe(false);
    expect(testEnv.OTHER_VAR).toBe("preserve-me");
  });

  it("trims surrounding whitespace from valid key", () => {
    const validKey = "sk-test-valid-key-with-enough-characters-1234567890";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: `  \n\t  ${validKey}  \r\n `,
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: true, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBe(validKey);
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("marks invalid and sets captured to null when key is too short (< 20 chars)", () => {
    const shortKey = "sk-too-short-123";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: shortKey,
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: true });
    expect(readPlatformDefaultRouterKey()).toBeNull();
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("marks invalid and sets captured to null when key is too long (> 512 chars)", () => {
    const longKey = "a".repeat(513);
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: longKey,
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: true });
    expect(readPlatformDefaultRouterKey()).toBeNull();
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("marks invalid when key contains whitespace or control characters", () => {
    const keyWithSpace = "sk-test-valid-length-but-with space-in-middle";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: keyWithSpace,
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: true });
    expect(readPlatformDefaultRouterKey()).toBeNull();
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("marks invalid when key contains non-ASCII characters", () => {
    const keyWithUnicode = "sk-test-valid-length-with-unicode-🔑-1234567";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: keyWithUnicode,
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: true });
    expect(readPlatformDefaultRouterKey()).toBeNull();
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("marks invalid when key is empty or whitespace-only", () => {
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: "   \n\t ",
    };

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: true });
    expect(readPlatformDefaultRouterKey()).toBeNull();
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
  });

  it("treats missing key as not configured and not invalid", () => {
    const testEnv: NodeJS.ProcessEnv = {};

    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);

    expect(status).toEqual({ configured: false, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBeNull();
  });

  it("is idempotent: later repopulation is deleted from env and NOT adopted", () => {
    const initialKey = "sk-initial-valid-key-with-enough-characters-12345";
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: initialKey,
    };

    const firstStatus = captureAndScrubPlatformDefaultRouterKey(testEnv);
    expect(firstStatus).toEqual({ configured: true, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBe(initialKey);
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();

    // Later, something repopulates the env var
    testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY] = "sk-second-repopulated-key-12345678901234567890";

    const secondStatus = captureAndScrubPlatformDefaultRouterKey(testEnv);
    // Returns original status
    expect(secondStatus).toEqual({ configured: true, invalid: false });
    // Value remains the first captured value, second value is NOT adopted
    expect(readPlatformDefaultRouterKey()).toBe(initialKey);
    // Repopulated env var is scrubbed from env
    expect(testEnv[PAPERCLIP_DEFAULT_ROUTER_API_KEY]).toBeUndefined();
    expect(PAPERCLIP_DEFAULT_ROUTER_API_KEY in testEnv).toBe(false);
  });

  it("accepts boundary lengths: exactly 20 and exactly 512 printable ASCII chars", () => {
    const minKey = `sk-${"a".repeat(17)}`; // exactly 20 printable ASCII chars
    const maxKey = "k".repeat(512); // exactly 512 printable ASCII chars
    expect(minKey).toHaveLength(20);
    expect(maxKey).toHaveLength(512);

    const minStatus = captureAndScrubPlatformDefaultRouterKey({
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: minKey,
    });
    expect(minStatus).toEqual({ configured: true, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBe(minKey);

    // Reset between the two independent capture attempts.
    __resetForTests();

    const maxStatus = captureAndScrubPlatformDefaultRouterKey({
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: maxKey,
    });
    expect(maxStatus).toEqual({ configured: true, invalid: false });
    expect(readPlatformDefaultRouterKey()).toBe(maxKey);
  });

  it("does not leak secret value, length, hash, or fingerprint in status return", () => {
    const testEnv: NodeJS.ProcessEnv = {
      [PAPERCLIP_DEFAULT_ROUTER_API_KEY]: "sk-secret-confidential-key-123456789012345",
    };
    const status = captureAndScrubPlatformDefaultRouterKey(testEnv);
    const keys = Object.keys(status).sort();
    expect(keys).toEqual(["configured", "invalid"]);
  });
  it("does not match the Router override prefix (the adapter's host-fallback guard stays intact)", () => {
    expect(PAPERCLIP_DEFAULT_ROUTER_API_KEY.startsWith("RAMP_ROUTER_")).toBe(false);
    expect(PAPERCLIP_DEFAULT_ROUTER_API_KEY).not.toBe("ROUTER_API_KEY");
  });

  it("freezes the reconcile flag at the first capture: default off, only an exact 'true' enables it", () => {
    captureAndScrubPlatformDefaultRouterKey({});
    expect(isPlatformRouterReconcileEnabled()).toBe(false);
    // A later environment change is never adopted.
    captureAndScrubPlatformDefaultRouterKey({ [PAPERCLIP_PLATFORM_ROUTER_RECONCILE]: "true" });
    expect(isPlatformRouterReconcileEnabled()).toBe(false);

    for (const [raw, expected] of [["true", true], [" TRUE ", true], ["1", false], ["yes", false], ["", false]] as const) {
      __resetForTests();
      captureAndScrubPlatformDefaultRouterKey({ [PAPERCLIP_PLATFORM_ROUTER_RECONCILE]: raw });
      expect(isPlatformRouterReconcileEnabled(), raw).toBe(expected);
    }
  });
});
