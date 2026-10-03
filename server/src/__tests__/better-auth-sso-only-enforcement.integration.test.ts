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
import { createDb } from "@paperclipai/db";
import type { SsoProviderConfig } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41997";

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

// Better Auth's okta() helper still fetches the issuer's discovery document
// at construction time to resolve authorization/token endpoints; stub the
// one request this suite needs (sign-in never reaches the token/userinfo
// endpoints, so only discovery is mocked).
function mockOktaDiscoveryFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href === "https://idp.example.com/.well-known/openid-configuration") {
        return new Response(
          JSON.stringify({
            issuer: "https://idp.example.com",
            authorization_endpoint: "https://idp.example.com/auth",
            token_endpoint: "https://idp.example.com/token",
            userinfo_endpoint: "https://idp.example.com/userinfo",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
    mockOktaDiscoveryFetch();

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
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllGlobals();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
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

    expect(res.status).not.toBe(200);
  });

  it("rejects direct password sign-in once disablePasswordAuth is set", async () => {
    const res = await request(appPasswordDisabled)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: "attacker@example.com", password: "whatever" });

    expect(res.status).not.toBe(200);
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
