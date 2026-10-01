import { describe, expect, it } from "vitest";
import { escapeRegExp } from "./regex.js";

describe("escapeRegExp", () => {
  it("escapes all regex metacharacters correctly", () => {
    const metachars = ".*+?^${}()|[]\\";
    const escaped = escapeRegExp(metachars);
    expect(escaped).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");

    const regex = new RegExp(`^${escaped}$`);
    expect(regex.test(metachars)).toBe(true);
    expect(regex.test("any other text")).toBe(false);
  });

  it("leaves strings without regex metacharacters unchanged", () => {
    expect(escapeRegExp("plainText123_abc-xyz")).toBe("plainText123_abc-xyz");
    expect(escapeRegExp("")).toBe("");
  });
});
