/**
 * TECH-7149: production Okta SSO login was 404ing before it ever reached
 * Okta, because the UI called a Better Auth route (`/sign-in/oauth2`) and
 * body shape that don't exist -- the real contract for a registered social
 * provider is `POST /sign-in/social` with `{ provider, callbackURL }` and
 * `GET /callback/:providerId` (see better-auth-sso-account-linking.
 * integration.test.ts's `startSocialSignIn` helper, which this borrows).
 *
 * This suite is the regression test for that contract, driven through the
 * real Better Auth mount, plus coverage for the SSO-only enforcement this
 * incident also required: once `disablePasswordAuth` is set (with Okta
 * configured), direct API calls to the password sign-up/sign-in routes must
 * be rejected -- not merely hidden in the UI.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, createDb } from "@paperclipai/db";
import type { SsoProviderConfig } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41997";
const VALID_USER_EMAIL = "existing-user@example.com";
const VALID_USER_PASSWORD = "correct-horse-battery-staple";

const OKTA_PROVIDER: SsoProviderConfig = {
  providerId: "okta", // better-auth's okta() helper hardcodes providerId to "okta".
  type: "okta",
  clientId: "test-client",
  clientSecret: "test-secret",
  issuer: "https://idp.example.com",
};

// The SSRF guard on discovery-sourced endpoints resolves hostnames via real
// DNS; the fake IdP hostname here isn't real/resolvable. Stub it the same
// way the account-linking suite does.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "10.0.0.1", family: 4 }],
}));

// Better Auth's okta() helper fetches the issuer's discovery document at
// construction time to resolve authorization/token/userinfo endpoints, and
// also uses it to classify the provider as OIDC-vs-plain-OAuth (see
// `fetchUserInfoViaDiscovery`'s comment in ../auth/better-auth.ts): a
// discovery document advertising `id_token_signing_alg_values_supported` --
// which every real OIDC IdP's discovery document does, Okta included --
// makes Better Auth resolve the account key from `profile.sub` instead of
// `profile.id`. Omitting that field here (as an earlier version of this
// mock did) makes the provider look like a plain OAuth provider instead of
// OIDC, which hid the OAUTH_ACCOUNT_SUBJECT_INVALID bug this suite now
// covers (TECH-7181) -- it never reached the `profile.sub` lookup at all.
function mockOktaFetch(input: { accessToken: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = url.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (href === "https://idp.example.com/.well-known/openid-configuration") {
        return json({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp.example.com/auth",
          token_endpoint: "https://idp.example.com/token",
          userinfo_endpoint: "https://idp.example.com/userinfo",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (href === "https://idp.example.com/token") {
        return json({ access_token: input.accessToken, token_type: "Bearer", scope: "openid email" });
      }
      if (href === "https://idp.example.com/userinfo") {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth !== `Bearer ${input.accessToken}`) return json({ error: "invalid_token" }, 401);
        return json({ sub: "okta-user-sub-1", email: "sso-user@example.com", email_verified: true, name: "SSO User" });
      }
      throw new Error(`Unexpected fetch in SSO-only enforcement test: ${href}`);
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
    port: 41997,
    ssoProviders: [OKTA_PROVIDER],
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
): Promise<{ state: string; stateCookie: string }> {
  const res = await request(app)
    .post("/api/auth/sign-in/social")
    .set("origin", ORIGIN)
    .send({ provider: "okta", callbackURL: ORIGIN });
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  return { state: url.searchParams.get("state")!, stateCookie: requestCookieHeader(res) };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Better Auth Okta SSO contract + SSO-only enforcement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let appPasswordDisabled!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-sso-only-enforcement-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-sso-only-");
    db = createDb(database.connectionString);

    // Stubbed before either `createBetterAuthInstance` call runs: the
    // generic-oauth plugin fetches each provider's discovery document at
    // construction time, not per-login.
    mockOktaFetch({ accessToken: "okta-test-access-token" });

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

    // Same config, but with disablePasswordAuth: true -- the state the
    // production instance moves to once Okta is confirmed working.
    const authPasswordDisabled = createBetterAuthInstance(db, testConfig(), [ORIGIN], {
      allowedEmailDomains: [],
      disablePasswordAuth: true,
    });
    appPasswordDisabled = express();
    appPasswordDisabled.all("/api/auth/{*authPath}", createBetterAuthHandler(authPasswordDisabled));

    // Both apps share the same underlying `db` -- create this account
    // through the password-enabled instance so the sign-in-rejected test
    // below exercises a real, existing credential account, not a
    // nonexistent one. That's what makes the rejection attributable to
    // disablePasswordAuth specifically, rather than indistinguishable from
    // an ordinary "no such user" 401/400.
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: VALID_USER_EMAIL, password: VALID_USER_PASSWORD, name: "Existing User" });
    if (signUp.status !== 200) {
      throw new Error(`Failed to seed the existing user for this suite: ${signUp.status} ${JSON.stringify(signUp.body)}`);
    }
  }, 60_000);

  afterAll(async () => {
    // If cleanup() throws, the fetch stub and these env vars must still be
    // restored -- otherwise they leak into every test file that runs after
    // this one in the same worker.
    try {
      await database?.cleanup();
    } finally {
      vi.unstubAllGlobals();
      if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
      if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
      else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
    }
  });

  it("POST /sign-in/social with the Okta provider returns a redirect whose callback path is /callback/okta, not /oauth2/callback/okta", async () => {
    const res = await request(app)
      .post("/api/auth/sign-in/social")
      .set("origin", ORIGIN)
      .send({ provider: "okta", callbackURL: ORIGIN });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
    const redirectUrl = new URL(res.body.url);
    expect(redirectUrl.hostname).toBe("idp.example.com");
    const redirectUri = redirectUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(new URL(redirectUri!).pathname).toBe("/api/auth/callback/okta");
  });

  it("a full Okta sign-in and callback round trip completes with a real session, not OAUTH_ACCOUNT_SUBJECT_INVALID (TECH-7181)", async () => {
    const { state, stateCookie } = await startSocialSignIn(app);
    const callback = await request(app)
      .get("/api/auth/callback/okta")
      .set("origin", ORIGIN)
      .set("Cookie", stateCookie)
      .query({ state, code: "fake-auth-code" });

    // A redirect to /api/auth/error (with no session cookie) is exactly
    // what production showed as `?error=unable_to_get_user_info` once the
    // browser followed through: Better Auth's account-key resolution threw
    // OAUTH_ACCOUNT_SUBJECT_INVALID because the discovered provider was
    // classified OIDC (real Okta discovery docs advertise
    // id_token_signing_alg_values_supported) and our userinfo result only
    // ever set `id`, never `sub`. A real session cookie here is the actual
    // fix verification -- the earlier tests in this file never exercised
    // the callback far enough to hit this.
    //
    // Assert the redirect status and a defined `location` explicitly --
    // `not.toMatch` on `undefined` passes vacuously, which would make this
    // assertion inert against exactly the kind of 4xx/5xx failure a
    // regression in this path would produce.
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBeTruthy();
    expect(callback.headers.location).not.toMatch(/\/api\/auth\/error/);
    expect(sessionCookies(callback).length).toBeGreaterThan(0);

    // The actual invariant this fix restores: the stored account is keyed
    // by the IdP's `sub` claim, not an empty/undefined subject.
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.accountId, "okta-user-sub-1"));
    expect(account).toBeTruthy();
    expect(account?.providerId).toBe("okta");
  });

  it("the old broken contract (/sign-in/oauth2 with providerId) is not a registered route", async () => {
    const res = await request(app)
      .post("/api/auth/sign-in/oauth2")
      .set("origin", ORIGIN)
      .send({ providerId: "okta", callbackURL: ORIGIN });

    expect(res.status).toBe(404);
  });

  it("rejects direct password sign-up once disablePasswordAuth is set, even though Okta is configured", async () => {
    const res = await request(appPasswordDisabled)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "attacker@example.com", password: "correct-horse-battery-staple", name: "Attacker" });

    expect(res.status).toBe(400);
  });

  it("rejects direct password sign-in once disablePasswordAuth is set, for a real existing account", async () => {
    const res = await request(appPasswordDisabled)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: VALID_USER_EMAIL, password: VALID_USER_PASSWORD });

    expect(res.status).toBe(400);
  });

  it("still allows Okta sign-in to start once password auth is disabled", async () => {
    const res = await request(appPasswordDisabled)
      .post("/api/auth/sign-in/social")
      .set("origin", ORIGIN)
      .send({ provider: "okta", callbackURL: ORIGIN });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
  });
});
