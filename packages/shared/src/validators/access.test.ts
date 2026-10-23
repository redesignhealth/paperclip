import { describe, expect, it } from "vitest";
import {
  ADMIN_ADD_MEMBER_CONFIRMATION,
  adminAddCompanyMemberSchema,
  authSessionSchema,
  currentUserProfileSchema,
} from "./access.js";

describe("currentUserProfileSchema", () => {
  it("coerces empty-string name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces whitespace-only name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "   ",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("preserves a real name unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe("Jane");
  });

  it("preserves null name as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: null,
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces empty-string email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("coerces whitespace-only email to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "   ",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("preserves a real email unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe("a@b.com");
  });

  it("preserves null email as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: null,
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe(null);
  });

  it("still rejects a malformed non-empty email", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "not-an-email",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("authSessionSchema", () => {
  it("parses a session where user name is empty string (identity provider without a name)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user has a real name", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe("Jane");
    expect(result.success && result.data.sentryDsn).toBe(null);
  });

  it("parses a session where user name is null", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: null, image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user email is empty string (identity provider without an email)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "", name: "Jane", image: null },
      sentryDsn: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.email).toBe(null);
  });

  it("rejects a payload with no sentryDsn field", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
    });
    expect(result.success).toBe(false);
  });

  it.each([undefined, null, "staging", "production"])(
    "preserves the optional Sentry environment (%s)",
    (environment) => {
      const result = authSessionSchema.parse({
        session: { id: "s1", userId: "u1" },
        user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
        sentryDsn: null,
        ...(environment === undefined ? {} : { sentryEnvironment: environment }),
      });
      expect(result.sentryEnvironment).toBe(environment);
    },
  );

  it("accepts a real sentryDsn value", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
      sentryDsn: "https://public@o0.ingest.sentry.io/1",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.sentryDsn).toBe("https://public@o0.ingest.sentry.io/1");
  });
});

describe("adminAddCompanyMemberSchema", () => {
  const valid = { userId: "u1", role: "owner", reason: "ticket", confirm: ADMIN_ADD_MEMBER_CONFIRMATION };

  it("trims userId and reason and keeps the explicit role", () => {
    const result = adminAddCompanyMemberSchema.safeParse({ ...valid, userId: " u1 ", reason: "  why  " });
    expect(result.success && result.data).toEqual({ userId: "u1", reason: "why", role: "owner", confirm: ADMIN_ADD_MEMBER_CONFIRMATION });
  });

  it.each([
    ["blank userId", { userId: "   " }],
    ["oversized userId", { userId: "u".repeat(256) }],
    ["blank reason", { reason: "  " }],
    ["oversized reason", { reason: "x".repeat(501) }],
    ["wrong confirm", { confirm: "yes" }],
    ["missing confirm", { confirm: undefined }],
    ["invalid role", { role: "superuser" }],
    ["missing role (no implicit owner)", { role: undefined }],
    ["unknown field", { extra: true }],
  ])("rejects %s", (_name, override) => {
    expect(adminAddCompanyMemberSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it("accepts the bounds and an explicit non-default role", () => {
    const result = adminAddCompanyMemberSchema.safeParse({
      userId: "u".repeat(255), reason: "x".repeat(500), confirm: ADMIN_ADD_MEMBER_CONFIRMATION, role: "viewer",
    });
    expect(result.success && result.data.role).toBe("viewer");
  });
});
