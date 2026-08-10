import { describe, expect, it } from "vitest";
import { sanitizeLoggedProviderError } from "../lib/sanitize-logged-error.js";

describe("sanitizeLoggedProviderError", () => {
  it("passes clean ASCII through unchanged", () => {
    expect(sanitizeLoggedProviderError("invalid_grant: token expired")).toBe("invalid_grant: token expired");
  });

  it("strips control characters", () => {
    expect(sanitizeLoggedProviderError("bad\x00token\x01here\nnow")).toBe("badtokenherenow");
  });

  it("strips non-ASCII bytes", () => {
    expect(sanitizeLoggedProviderError("Ungültiger Token")).toBe("Ungltiger Token");
  });

  it("passes a string of exactly 512 characters through unchanged", () => {
    const value = "a".repeat(512);
    expect(sanitizeLoggedProviderError(value)).toBe(value);
    expect(sanitizeLoggedProviderError(value)).toHaveLength(512);
  });

  it("truncates a string longer than 512 characters after stripping", () => {
    const value = "b".repeat(600);
    expect(sanitizeLoggedProviderError(value)).toHaveLength(512);
  });

  it("returns an empty string for all-control-character input, without throwing", () => {
    expect(() => sanitizeLoggedProviderError("\x00\x01\x02\x1f")).not.toThrow();
    expect(sanitizeLoggedProviderError("\x00\x01\x02\x1f")).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeLoggedProviderError("")).toBe("");
  });
});
