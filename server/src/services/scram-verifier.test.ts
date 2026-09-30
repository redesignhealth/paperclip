import { describe, expect, it } from "vitest";
import {
  generateScramVerifier,
  rederiveScramVerifier,
  assertValidScramVerifier,
  SCRAM_VERIFIER_REGEX,
} from "./scram-verifier.js";

describe("scram-verifier", () => {
  it("generates a valid RFC 5802 / PostgreSQL SCRAM-SHA-256 verifier", () => {
    const result = generateScramVerifier("test_password_123");
    expect(result.password).toBe("test_password_123");
    expect(result.iterations).toBe(4096);
    expect(result.saltBase64).toBeTruthy();
    expect(result.storedKeyBase64).toBeTruthy();
    expect(result.serverKeyBase64).toBeTruthy();

    expect(result.verifier).toMatch(SCRAM_VERIFIER_REGEX);
    expect(result.verifier.startsWith("SCRAM-SHA-256$4096:")).toBe(true);
    expect(() => assertValidScramVerifier(result.verifier)).not.toThrow();
  });

  it("deterministically rederives the identical verifier given the same password, salt, and iterations", () => {
    const initial = generateScramVerifier("my_random_pass");
    const rederived = rederiveScramVerifier("my_random_pass", initial.saltBase64, initial.iterations);

    expect(rederived.verifier).toBe(initial.verifier);
    expect(rederived.storedKeyBase64).toBe(initial.storedKeyBase64);
    expect(rederived.serverKeyBase64).toBe(initial.serverKeyBase64);
  });

  it("rejects malformed verifier strings", () => {
    expect(() => assertValidScramVerifier("invalid")).toThrow("Invalid PostgreSQL SCRAM-SHA-256 verifier format");
    expect(() => assertValidScramVerifier("SCRAM-SHA-256$bad")).toThrow("Invalid PostgreSQL SCRAM-SHA-256 verifier format");
    expect(() => assertValidScramVerifier("")).toThrow("Invalid PostgreSQL SCRAM-SHA-256 verifier format");
  });
});
