/**
 * TECH-6956 round 4 (Argus): end-to-end coverage for the account-takeover-
 * via-unverified-email-linking vulnerability, driven through the real
 * Better Auth mount (not a unit-level call into our own wrapper) so the
 * actual `accountLinking.trustedProviders` decision inside Better Auth's
 * own callback handler is what's under test.
 *
 * Scenario: an existing, already-verified local account
 * ("victim@example.com") exists. Two SSO providers are configured:
 *  - "okta", with `trustEmailVerified: true` -- a deliberately trusted
 *    enterprise IdP that doesn't reliably assert `email_verified`.
 *  - "generic-plain", a plain "oidc" provider with no such override.
 *
 * Both IdPs are simulated (via a mocked `fetch`) to assert the SAME email,
 * with `email_verified: false`. The plain provider must NOT be able to log
 * in as (link into) the victim's account on that unverified assertion alone
 * -- that is the account-takeover path. The deliberately trusted enterprise
 * provider still can, because its `trustEmailVerified` override forces
 * `emailVerified: true` before Better Auth's own linking check ever runs,
 * independent of `trustedProviders` -- preserving the legitimate path this
 * fix must not break.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, createDb } from "@paperclipai/db";
import type { SsoProviderConfig } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const VICTIM_EMAIL = "victim@example.com";
const VICTIM_PASSWORD = "correct-horse-battery-staple";

const TRUSTED_PROVIDER: SsoProviderConfig = {
  providerId: "okta", // better-auth's okta() helper hardcodes providerId to "okta".
  type: "okta",
  clientId: "trusted-client",
  clientSecret: "trusted-secret",
  issuer: "https://idp-trusted.example.com",
  trustEmailVerified: true,
};

const PLAIN_PROVIDER: SsoProviderConfig = {
  providerId: "generic-plain",
  type: "oidc",
  clientId: "plain-client",
  clientSecret: "plain-secret",
  discoveryUrl: "https://idp-plain.example.com/.well-known/openid-configuration",
};

// The SSRF guard on discovery-sourced endpoints resolves hostnames via real
// DNS before allowing a fetch. Neither fake IdP hostname is real/resolvable,
// so stub the lookup -- this suite runs as authenticated+private, which
// allows private-network targets anyway, so the resolved address only needs
// to exist, not be public.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "10.0.0.1", family: 4 }],
}));

function discoveryDocFor(issuer: string) {
  // No `jwks_uri` -- Better Auth's own id_token verification only activates
  // when discovery provides one, and this suite never sends an id_token
  // back from the (mocked) token endpoint, so it stays irrelevant here. Only
  // the access_token + userinfo_endpoint path is exercised.
  return {
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
  };
}

function mockSsoFetch(input: {
  trustedAccessToken: string;
  plainAccessToken: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (href === "https://idp-trusted.example.com/.well-known/openid-configuration") {
        return json(discoveryDocFor("https://idp-trusted.example.com"));
      }
      if (href === "https://idp-plain.example.com/.well-known/openid-configuration") {
        return json(discoveryDocFor("https://idp-plain.example.com"));
      }
      if (href === "https://idp-trusted.example.com/token") {
        return json({ access_token: input.trustedAccessToken, token_type: "Bearer", scope: "openid email" });
      }
      if (href === "https://idp-plain.example.com/token") {
        return json({ access_token: input.plainAccessToken, token_type: "Bearer", scope: "openid email" });
      }
      if (href === "https://idp-trusted.example.com/userinfo") {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth !== `Bearer ${input.trustedAccessToken}`) return json({ error: "invalid_token" }, 401);
        return json({ sub: "trusted-sub", email: VICTIM_EMAIL, email_verified: false, name: "Trusted IdP User" });
      }
      if (href === "https://idp-plain.example.com/userinfo") {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth !== `Bearer ${input.plainAccessToken}`) return json({ error: "invalid_token" }, 401);
        return json({ sub: "plain-sub", email: VICTIM_EMAIL, email_verified: false, name: "Plain IdP User" });
      }
      throw new Error(`Unexpected fetch in SSO account-linking test: ${href}`);
    }),
  );
}

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
    ssoProviders: [TRUSTED_PROVIDER, PLAIN_PROVIDER],
  } as unknown as Config;
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

function requestCookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function startSocialSignIn(
  app: express.Express,
  providerId: string,
): Promise<{ state: string; stateCookie: string }> {
  const res = await request(app)
    .post("/api/auth/sign-in/social")
    .set("origin", ORIGIN)
    .send({ provider: providerId, callbackURL: ORIGIN });
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  // Better Auth's default (non-cookie) state strategy persists state server
  // side, keyed by the `state` value, but ALSO requires a signed `state`
  // cookie minted on this same sign-in response to be replayed on the
  // callback -- the real browser carries this automatically via the
  // redirect round trip; a test driving both requests independently has to
  // forward it explicitly.
  return { state: url.searchParams.get("state")!, stateCookie: requestCookieHeader(res) };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Better Auth SSO account-linking trust boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-sso-linking-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-sso-linking-");
    db = createDb(database.connectionString);

    // Stubbed before `createBetterAuthInstance` runs: the generic-oauth
    // plugin fetches each provider's discovery document at construction
    // time, not per-login.
    mockSsoFetch({ trustedAccessToken: "trusted-access-token", plainAccessToken: "plain-access-token" });

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

    // Seed the existing, already-verified victim account exactly as a real
    // deployment would have one: created via credential sign-up, later
    // verified (emailVerified flips to true independently of this test --
    // set directly here rather than driving the full email-verification
    // flow, which is not what this suite is about).
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: VICTIM_EMAIL, password: VICTIM_PASSWORD, name: "Victim" });
    expect(signUp.status).toBe(200);
    await db.update(authUsers).set({ emailVerified: true }).where(eq(authUsers.email, VICTIM_EMAIL));
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllGlobals();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("refuses to link a plain SSO provider's unverified email into the existing verified account", async () => {
    const { state, stateCookie } = await startSocialSignIn(app, "generic-plain");
    const callback = await request(app)
      .get("/api/auth/callback/generic-plain")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });

    // Rejected: no session cookie is ever set on the "account not linked"
    // path (Better Auth only calls setSessionCookie after a successful
    // link/create). This is the exact attack this fix closes -- without it,
    // this request would log the attacker in as the victim.
    expect(sessionCookies(callback)).toHaveLength(0);
  });

  it("still allows the deliberately trusted enterprise provider to link, preserving the legitimate path", async () => {
    const { state, stateCookie } = await startSocialSignIn(app, "okta");
    const callback = await request(app)
      .get("/api/auth/callback/okta")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });

    expect(sessionCookies(callback).length).toBeGreaterThan(0);
  });

  // TECH-7181: this app has no email-verification flow, so a password-created
  // account's `emailVerified` column stays `false` forever -- unlike the
  // "victim" fixture above, which the suite manually flips to `true` to
  // isolate the trustedProviders behavior. A real admin account created via
  // sign-up (e.g. the bootstrap-CEO flow) looks like THIS fixture, not that
  // one. Without `requireLocalEmailVerified: false`, Better Auth's default
  // would refuse to link even the deliberately trusted "okta" provider here,
  // making SSO permanently unusable for every such account.
  it("still allows the trusted enterprise provider to link into an existing account whose local emailVerified was never set true", async () => {
    const unverifiedEmail = "unverified-admin@example.com";
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: unverifiedEmail, password: "another-correct-horse-battery", name: "Unverified Admin" });
    expect(signUp.status).toBe(200);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, unverifiedEmail));
    expect(user?.emailVerified).toBe(false);

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (href === "https://idp-trusted.example.com/.well-known/openid-configuration") {
          return json(discoveryDocFor("https://idp-trusted.example.com"));
        }
        if (href === "https://idp-trusted.example.com/token") {
          return json({ access_token: "trusted-access-token-3", token_type: "Bearer", scope: "openid email" });
        }
        if (href === "https://idp-trusted.example.com/userinfo") {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          if (auth !== "Bearer trusted-access-token-3") return json({ error: "invalid_token" }, 401);
          return json({ sub: "trusted-sub-2", email: unverifiedEmail, email_verified: false, name: "Trusted IdP User 2" });
        }
        throw new Error(`Unexpected fetch in SSO account-linking test: ${href}`);
      }),
    );

    const { state, stateCookie } = await startSocialSignIn(app, "okta");
    const callback = await request(app)
      .get("/api/auth/callback/okta")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toMatch(/\/api\/auth\/error/);
    expect(sessionCookies(callback).length).toBeGreaterThan(0);
  });

  // TECH-7181 PR #42 round 1 (Argus, BLOCKING): `requireLocalEmailVerified:
  // false` above closes one hole but opens an account pre-hijacking path --
  // credential sign-up is open by default and nothing verifies email, so an
  // attacker can register the victim's email with a password of their
  // choosing before the victim's first trusted-SSO login, then keep using
  // that password afterward. This confirms the `databaseHooks.account.create.
  // after` mitigation actually closes it: once the trusted "okta" identity
  // links into the attacker's pre-created account, the attacker's password
  // credential and any session they were holding must both be gone, and a
  // direct password sign-in with that credential must be rejected.
  it("revokes a pre-existing password credential and session once a trusted SSO identity links into that account (TECH-7181 pre-hijacking fix)", async () => {
    const hijackedEmail = "pre-hijacked@example.com";
    const attackerPassword = "attacker-chosen-password-123";
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: hijackedEmail, password: attackerPassword, name: "Attacker-Controlled Name" });
    expect(signUp.status).toBe(200);
    const attackerSessionCookie = requestCookieHeader(signUp);
    expect(attackerSessionCookie).not.toBe("");

    const [userBeforeLink] = await db.select().from(authUsers).where(eq(authUsers.email, hijackedEmail));
    expect(userBeforeLink?.emailVerified).toBe(false);
    const accountsBeforeLink = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, userBeforeLink!.id));
    expect(accountsBeforeLink.some((account) => account.providerId === "credential")).toBe(true);
    const sessionsBeforeLink = await db.select().from(authSessions).where(eq(authSessions.userId, userBeforeLink!.id));
    expect(sessionsBeforeLink.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (href === "https://idp-trusted.example.com/.well-known/openid-configuration") {
          return json(discoveryDocFor("https://idp-trusted.example.com"));
        }
        if (href === "https://idp-trusted.example.com/token") {
          return json({ access_token: "trusted-access-token-hijack", token_type: "Bearer", scope: "openid email" });
        }
        if (href === "https://idp-trusted.example.com/userinfo") {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          if (auth !== "Bearer trusted-access-token-hijack") return json({ error: "invalid_token" }, 401);
          return json({ sub: "trusted-sub-hijack", email: hijackedEmail, email_verified: false, name: "Real Owner" });
        }
        throw new Error(`Unexpected fetch in SSO account-linking test: ${href}`);
      }),
    );

    const { state, stateCookie } = await startSocialSignIn(app, "okta");
    const callback = await request(app)
      .get("/api/auth/callback/okta")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toMatch(/\/api\/auth\/error/);
    expect(sessionCookies(callback).length).toBeGreaterThan(0);

    const accountsAfterLink = await db.select().from(authAccounts).where(eq(authAccounts.userId, userBeforeLink!.id));
    expect(accountsAfterLink.some((account) => account.providerId === "credential")).toBe(false);
    expect(accountsAfterLink.some((account) => account.providerId === "okta")).toBe(true);

    const sessionTokensAfterLink = new Set(
      (await db.select().from(authSessions).where(eq(authSessions.userId, userBeforeLink!.id))).map((s) => s.token),
    );
    for (const session of sessionsBeforeLink) {
      expect(sessionTokensAfterLink.has(session.token)).toBe(false);
    }

    const attackerPasswordSignIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: hijackedEmail, password: attackerPassword });
    expect(attackerPasswordSignIn.status).not.toBe(200);
  });
});
