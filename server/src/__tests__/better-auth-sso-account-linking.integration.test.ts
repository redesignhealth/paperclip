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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, boardApiKeys, createDb } from "@paperclipai/db";
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

  // Round 2 (Argus, test-coverage): each test below stubs `fetch` for its own
  // IdP(s) explicitly rather than relying on a prior test's stub carrying
  // over, so unstub between every test regardless of which one ran before.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to link a plain SSO provider's unverified email into the existing verified account", async () => {
    mockSsoFetch({ trustedAccessToken: "trusted-access-token", plainAccessToken: "plain-access-token" });
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
    mockSsoFetch({ trustedAccessToken: "trusted-access-token", plainAccessToken: "plain-access-token" });
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

    const [attackerBoardKey] = await db
      .insert(boardApiKeys)
      .values({ userId: userBeforeLink!.id, name: "attacker-minted-key", keyHash: "test-key-hash-pre-hijack" })
      .returning();
    expect(attackerBoardKey?.revokedAt).toBeNull();

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

    // Exactly one session survives: the new one this login just created. A
    // hook that deleted everyone's sessions unconditionally (round 1) and a
    // hook that deleted none of them (a no-op) would both leave this at
    // zero-vs-nonzero only -- asserting the exact count (not just "greater
    // than zero") is what actually distinguishes "old sessions revoked, new
    // one preserved" from either failure mode.
    const sessionsAfterLink = await db.select().from(authSessions).where(eq(authSessions.userId, userBeforeLink!.id));
    expect(sessionsAfterLink).toHaveLength(1);
    const sessionTokensBeforeLink = new Set(sessionsBeforeLink.map((s) => s.token));
    expect(sessionTokensBeforeLink.has(sessionsAfterLink[0]!.token)).toBe(false);

    const boardKeyAfterLink = (
      await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, attackerBoardKey!.id))
    )[0];
    expect(boardKeyAfterLink?.revokedAt).not.toBeNull();

    const attackerPasswordSignIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: hijackedEmail, password: attackerPassword });
    expect(attackerPasswordSignIn.status).toBe(401);
  });

  // TECH-7181 PR #42 round 2 (Argus, security): the mitigation hook must not
  // fire only for providers in `computeSsoAccountLinkingTrustedProviders` --
  // Better Auth's own link decision allows a link whenever
  // `isTrustedProvider || userInfo.emailVerified`, so an UNTRUSTED provider
  // that itself asserts a verified email can link too, and the attacker's
  // pre-registered password must not survive that path either.
  it("also revokes a pre-existing password credential when an untrusted provider links in by asserting a verified email itself", async () => {
    const hijackedEmail = "untrusted-but-verified@example.com";
    const attackerPassword = "attacker-chosen-password-456";
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: hijackedEmail, password: attackerPassword, name: "Attacker 2" });
    expect(signUp.status).toBe(200);
    const [userBeforeLink] = await db.select().from(authUsers).where(eq(authUsers.email, hijackedEmail));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (href === "https://idp-plain.example.com/.well-known/openid-configuration") {
          return json(discoveryDocFor("https://idp-plain.example.com"));
        }
        if (href === "https://idp-plain.example.com/token") {
          return json({ access_token: "plain-access-token-verified", token_type: "Bearer", scope: "openid email" });
        }
        if (href === "https://idp-plain.example.com/userinfo") {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          if (auth !== "Bearer plain-access-token-verified") return json({ error: "invalid_token" }, 401);
          // Untrusted provider (no trustEmailVerified) asserting its OWN
          // genuinely verified email -- Better Auth's
          // `!isTrustedProvider && !userInfo.emailVerified` allows this link
          // on the real `emailVerified: true` alone, independent of trust.
          return json({ sub: "plain-sub-verified", email: hijackedEmail, email_verified: true, name: "Real Owner 2" });
        }
        throw new Error(`Unexpected fetch in SSO account-linking test: ${href}`);
      }),
    );

    const { state, stateCookie } = await startSocialSignIn(app, "generic-plain");
    const callback = await request(app)
      .get("/api/auth/callback/generic-plain")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toMatch(/\/api\/auth\/error/);
    expect(sessionCookies(callback).length).toBeGreaterThan(0);

    const accountsAfterLink = await db.select().from(authAccounts).where(eq(authAccounts.userId, userBeforeLink!.id));
    expect(accountsAfterLink.some((account) => account.providerId === "credential")).toBe(false);
    expect(accountsAfterLink.some((account) => account.providerId === "generic-plain")).toBe(true);

    const attackerPasswordSignIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: hijackedEmail, password: attackerPassword });
    expect(attackerPasswordSignIn.status).toBe(401);
  });

  // TECH-7181 PR #42 round 2 (Argus, security/data-loss): the hook must only
  // remove the `credential` account, never a legitimately-linked second
  // OAuth provider or the sessions that go with it. Simulate a user who
  // already linked "okta" cleanly (no credential account ever existed, so
  // nothing to revoke) and then also links a second trusted provider --
  // the first provider's account and the session from this test's own login
  // must both survive.
  it("does not delete a legitimately-linked second OAuth provider or its sessions when another trusted provider links in", async () => {
    const SECOND_TRUSTED_PROVIDER: SsoProviderConfig = {
      // better-auth's auth0() plugin helper hardcodes its registered
      // providerId to "auth0" regardless of this field (see
      // node_modules/better-auth/dist/plugins/generic-oauth/providers/
      // auth0.mjs) -- set to match, the same constraint TRUSTED_PROVIDER
      // above already documents for okta(). type "auth0", not "okta": a
      // second provider also typed "okta" collides with TRUSTED_PROVIDER
      // ("Duplicate provider IDs found: okta").
      providerId: "auth0",
      type: "auth0",
      clientId: "second-trusted-client",
      clientSecret: "second-trusted-secret",
      issuer: "https://idp-second-trusted.example.com",
      trustEmailVerified: true,
    };
    const multiProviderEmail = "multi-provider-user@example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (href === "https://idp-trusted.example.com/.well-known/openid-configuration") {
          return json(discoveryDocFor("https://idp-trusted.example.com"));
        }
        if (href === "https://idp-second-trusted.example.com/.well-known/openid-configuration") {
          return json(discoveryDocFor("https://idp-second-trusted.example.com"));
        }
        if (href === "https://idp-plain.example.com/.well-known/openid-configuration") {
          // Not used by this test's logins, but PLAIN_PROVIDER is still in
          // this instance's configured ssoProviders, and the generic-oauth
          // plugin fetches every configured provider's discovery document at
          // construction time regardless of which one a test logs in with.
          return json(discoveryDocFor("https://idp-plain.example.com"));
        }
        if (href === "https://idp-trusted.example.com/token") {
          return json({ access_token: "trusted-access-token-multi-1", token_type: "Bearer", scope: "openid email" });
        }
        if (href === "https://idp-second-trusted.example.com/token") {
          return json({ access_token: "trusted-access-token-multi-2", token_type: "Bearer", scope: "openid email" });
        }
        if (href === "https://idp-trusted.example.com/userinfo") {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          if (auth !== "Bearer trusted-access-token-multi-1") return json({ error: "invalid_token" }, 401);
          return json({ sub: "multi-sub-1", email: multiProviderEmail, email_verified: false, name: "Multi User" });
        }
        if (href === "https://idp-second-trusted.example.com/userinfo") {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
          if (auth !== "Bearer trusted-access-token-multi-2") return json({ error: "invalid_token" }, 401);
          return json({ sub: "multi-sub-2", email: multiProviderEmail, email_verified: false, name: "Multi User" });
        }
        throw new Error(`Unexpected fetch in SSO account-linking test: ${href}`);
      }),
    );
    const multiProviderAuth = createBetterAuthInstance(
      db,
      { ...testConfig(), ssoProviders: [TRUSTED_PROVIDER, PLAIN_PROVIDER, SECOND_TRUSTED_PROVIDER] } as Config,
      [ORIGIN],
    );
    const multiProviderApp = express();
    multiProviderApp.all("/api/auth/{*authPath}", createBetterAuthHandler(multiProviderAuth));

    const firstLink = await startSocialSignIn(multiProviderApp, "okta");
    const firstCallback = await request(multiProviderApp)
      .get("/api/auth/callback/okta")
      .set("origin", ORIGIN)
      .set("Cookie", firstLink.stateCookie)
      .query({ state: firstLink.state, code: "fake-auth-code" });
    expect(firstCallback.status).toBe(302);
    expect(firstCallback.headers.location).not.toMatch(/\/api\/auth\/error/);
    const firstSessionCookie = requestCookieHeader(firstCallback);
    expect(firstSessionCookie).not.toBe("");

    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, multiProviderEmail));
    const sessionsBeforeSecondLink = await db.select().from(authSessions).where(eq(authSessions.userId, user!.id));
    expect(sessionsBeforeSecondLink.length).toBeGreaterThan(0);

    const secondLink = await startSocialSignIn(multiProviderApp, "auth0");
    const secondCallback = await request(multiProviderApp)
      .get("/api/auth/callback/auth0")
      .set("origin", ORIGIN)
      .set("Cookie", secondLink.stateCookie)
      .query({ state: secondLink.state, code: "fake-auth-code" });
    expect(secondCallback.status).toBe(302);
    expect(secondCallback.headers.location).not.toMatch(/\/api\/auth\/error/);

    const accountsAfterSecondLink = await db.select().from(authAccounts).where(eq(authAccounts.userId, user!.id));
    expect(accountsAfterSecondLink.some((account) => account.providerId === "okta")).toBe(true);
    expect(accountsAfterSecondLink.some((account) => account.providerId === "auth0")).toBe(true);

    const sessionTokensAfterSecondLink = new Set(
      (await db.select().from(authSessions).where(eq(authSessions.userId, user!.id))).map((s) => s.token),
    );
    for (const session of sessionsBeforeSecondLink) {
      expect(sessionTokensAfterSecondLink.has(session.token)).toBe(true);
    }
  });
});
