import { describe, expect, it } from "vitest";
import { findInErrorCauseChain, isPostgresError } from "../errors.js";

describe("isPostgresError", () => {
  it("detects a code on the top-level error", () => {
    const error = { code: "42703" };
    expect(isPostgresError(error, "42703")).toBe(true);
  });

  it("detects a code on a wrapped .cause error (drizzle-style wrapping)", () => {
    const wrapped = {
      message: "Failed query",
      cause: { code: "42703", message: "column does not exist" },
    };
    expect(isPostgresError(wrapped, "42703")).toBe(true);
  });

  it("walks multiple levels of .cause", () => {
    const deeplyWrapped = {
      cause: {
        cause: { code: "23505" },
      },
    };
    expect(isPostgresError(deeplyWrapped, "23505")).toBe(true);
  });

  it("returns false when no node in the chain matches the code", () => {
    const error = { code: "23505", cause: { code: "42P01" } };
    expect(isPostgresError(error, "42703")).toBe(false);
  });

  it("returns false for non-object errors", () => {
    expect(isPostgresError("boom", "42703")).toBe(false);
    expect(isPostgresError(null, "42703")).toBe(false);
    expect(isPostgresError(undefined, "42703")).toBe(false);
  });

  it("does not infinite-loop on a cyclical cause chain", () => {
    const cyclical: { code?: string; cause?: unknown } = { code: "other" };
    cyclical.cause = cyclical;
    expect(isPostgresError(cyclical, "42703")).toBe(false);
  });
});

describe("findInErrorCauseChain", () => {
  it("returns the first extracted value found while walking the chain", () => {
    const error = { cause: { constraint: "some_unique_idx", code: "23505" } };
    const found = findInErrorCauseChain(error, (node) => {
      const maybe = node as { code?: string; constraint?: string };
      return maybe.code === "23505" ? maybe.constraint : undefined;
    });
    expect(found).toBe("some_unique_idx");
  });

  it("returns undefined when extract never matches", () => {
    const error = { cause: { code: "42P01" } };
    const found = findInErrorCauseChain(error, (node) => {
      const maybe = node as { code?: string };
      return maybe.code === "23505" ? true : undefined;
    });
    expect(found).toBeUndefined();
  });
});
