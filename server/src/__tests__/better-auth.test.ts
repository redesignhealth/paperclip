import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import type { SsoProviderConfig } from "@paperclipai/shared";
import { shouldAllowPrivateNetworkTargets } from "@paperclipai/shared";
import type { SsoRoleRequirement } from "@paperclipai/shared";
import {
  buildBetterAuthAdvancedOptions,
  buildBetterAuthRateLimitOptions,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
  isEmailDomainAllowed,
  mapSsoProviderToOAuthConfig,
  shouldDisableSecureAuthCookies,
  userHasRequiredRole,
} from "../auth/better-auth.js";

// The discovery-sourced userinfo_endpoint SSRF guard resolves hostnames via
// DNS before allowing a fetch. "idp.example.com" isn't a real, resolvable
// host, so stub the lookup to a public IP for it -- the guard's own private
// IP logic is covered directly in remote-http-endpoint-guard.test.ts; here we
// only need a same-origin, non-private stand-in so the happy-path tests can
// reach the "endpoint is safe" branch.
vi.mock("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    if (hostname === "idp.example.com") return [{ address: "93.184.216.34", family: 4 }];
    return [{ address: "169.254.169.254", family: 4 }];
  },
}));


const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;
const ORIGINAL_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
  else process.env.PAPERCLIP_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toMatch(
      /paperclip-sat-worktree\.session_token$/,
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
    expect(getCookies({
      advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: true }),
    } as BetterAuthOptions).sessionToken.name).toBe("paperclip-pap-worktree.session_token");
  });

  it("enables Better Auth rate limiting for authenticated private instances by default", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
    })).toEqual({ enabled: true });
  });

  it("keeps Better Auth rate limiting enabled for authenticated public instances", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    })).toEqual({ enabled: true });
  });

  it("allows an explicit Better Auth rate-limit override", () => {
    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      override: "true",
    })).toEqual({ enabled: true });

    expect(buildBetterAuthRateLimitOptions({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      override: "false",
    })).toEqual({ enabled: false });
  });

  it("disables secure cookies for authenticated private auto-origin dev servers", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: undefined,
    })).toBe(true);
  });

  it("keeps secure cookies for authenticated public auto-origin servers", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: undefined,
    })).toBe(false);
  });

  it("uses an explicit public URL when deciding whether secure cookies are required", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      publicUrl: "https://paperclip.example.test",
    })).toBe(false);

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://paperclip.local.test:3100",
      publicUrl: undefined,
    })).toBe(true);
  });

  it("disables secure cookies when no canonical public auth URL is configured", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
  });

  it("derives secure cookie behavior from the configured public auth URL", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://paperclip-dev:46259",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example.test",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(false);
  });

  it("uses the caller-resolved public URL for cookie security", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://ignored.example.test";

    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example.test",
      publicUrl: "http://paperclip-dev:46259",
    } as Parameters<typeof shouldDisableSecureAuthCookies>[0])).toBe(true);
  });

  it("disables secure cookies for private authenticated auto mode without a public URL", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
    })).toBe(true);
  });

  it("disables secure cookies for explicit HTTP public URLs", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://board.example.test:3101",
    })).toBe(true);
  });

  it("keeps secure cookies for explicit HTTPS public URLs", () => {
    expect(shouldDisableSecureAuthCookies({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://board.example.test",
    })).toBe(false);
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});

describe("userHasRequiredRole (SSO role-enforcement gate, TECH-4916)", () => {
  const requirement: SsoRoleRequirement = {
    claimPath: "resource_access.paperclip.roles",
    roles: ["human", "operator"],
  };

  it("allows when the claim path resolves to an array containing a required role", () => {
    const claims = { resource_access: { paperclip: { roles: ["viewer", "human"] } } };
    expect(userHasRequiredRole(claims, requirement)).toBe(true);
  });

  it("rejects when the claim path resolves to an array with no required role", () => {
    const claims = { resource_access: { paperclip: { roles: ["viewer"] } } };
    expect(userHasRequiredRole(claims, requirement)).toBe(false);
  });

  it("allows when the claim path resolves to a single string matching a required role", () => {
    const claims = { resource_access: { paperclip: { roles: "operator" } } };
    expect(userHasRequiredRole(claims, requirement)).toBe(true);
  });

  it("rejects when the claim path resolves to a single string not matching any required role", () => {
    const claims = { resource_access: { paperclip: { roles: "guest" } } };
    expect(userHasRequiredRole(claims, requirement)).toBe(false);
  });

  it("rejects (fails closed) when the claim path points at a missing nested key", () => {
    const claims = { resource_access: { paperclip: {} } };
    expect(userHasRequiredRole(claims, requirement)).toBe(false);
  });

  it("rejects (fails closed) when an intermediate segment of the claim path is missing entirely", () => {
    const claims = { some_other_claim: true };
    expect(userHasRequiredRole(claims, requirement)).toBe(false);
  });

  it("rejects (fails closed) when the resolved value is neither an array nor a string", () => {
    const claims = { resource_access: { paperclip: { roles: 42 } } };
    expect(userHasRequiredRole(claims, requirement)).toBe(false);
  });

  it("rejects when roles is an empty array, even though every claim value trivially fails to match", () => {
    // Sanity check that an empty `roles` list can never be satisfied by
    // `.some()` -- this requirement should never be constructed this way in
    // practice (the schema requires roles.min(1)), but the enforcement path
    // itself must fail closed, not silently pass an unconfigured gate open.
    const emptyRequirement: SsoRoleRequirement = { claimPath: "roles", roles: [] };
    const claims = { roles: ["human"] };
    expect(userHasRequiredRole(claims, emptyRequirement)).toBe(false);
  });
});

describe("SSO email-domain restriction (TECH-4916)", () => {
  it("allows any email when no domains are configured (fail open on empty config)", () => {
    expect(isEmailDomainAllowed("someone@redesignhealth.com", [])).toBe(true);
    expect(isEmailDomainAllowed("someone@anything.example", [])).toBe(true);
    expect(isEmailDomainAllowed(null, [])).toBe(true);
    expect(isEmailDomainAllowed(undefined, [])).toBe(true);
  });

  it("accepts an email whose domain is in the allowed list", () => {
    expect(isEmailDomainAllowed("dan@redesignhealth.com", ["redesignhealth.com"])).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isEmailDomainAllowed("Dan@RedesignHealth.com", ["redesignhealth.com"])).toBe(true);
    expect(isEmailDomainAllowed("dan@redesignhealth.com", ["RedesignHealth.COM"])).toBe(true);
  });

  it("rejects an email whose domain is not in the allowed list (fail closed once configured)", () => {
    expect(isEmailDomainAllowed("attacker@evil.com", ["redesignhealth.com"])).toBe(false);
  });

  it("rejects a lookalike domain instead of substring-matching it", () => {
    expect(isEmailDomainAllowed("attacker@evilredesignhealth.com", ["redesignhealth.com"])).toBe(false);
    expect(isEmailDomainAllowed("attacker@redesignhealth.com.evil.com", ["redesignhealth.com"])).toBe(false);
    expect(isEmailDomainAllowed("attacker@notredesignhealth.com", ["redesignhealth.com"])).toBe(false);
  });

  it("rejects missing or malformed email addresses once a restriction is configured", () => {
    expect(isEmailDomainAllowed(null, ["redesignhealth.com"])).toBe(false);
    expect(isEmailDomainAllowed(undefined, ["redesignhealth.com"])).toBe(false);
    expect(isEmailDomainAllowed("not-an-email", ["redesignhealth.com"])).toBe(false);
    expect(isEmailDomainAllowed("trailing-at@", ["redesignhealth.com"])).toBe(false);
  });

  it("accepts a match against any entry in a multi-domain allowlist", () => {
    const allowed = ["redesignhealth.com", "partner-health.example"];
    expect(isEmailDomainAllowed("a@redesignhealth.com", allowed)).toBe(true);
    expect(isEmailDomainAllowed("b@partner-health.example", allowed)).toBe(true);
    expect(isEmailDomainAllowed("c@other.com", allowed)).toBe(false);
  });

  // Regression coverage for a second-`@` allowlist bypass: the previous
  // implementation used `email.lastIndexOf("@")`, so an IdP-supplied address
  // like "attacker@evil.com@allowed.com" resolved a domain of
  // "allowed.com" and sailed through the allowlist. Every case below fails
  // against that implementation (i.e. `lastIndexOf`-based parsing returns
  // `true` for the double-`@` cases, or otherwise disagrees) and passes only
  // once the address is required to be a well-formed single-`@` string.
  describe("rejects malformed addresses that could smuggle a second domain past the allowlist", () => {
    it("rejects a double-`@` address even though the trailing segment is an allowed domain", () => {
      expect(isEmailDomainAllowed("attacker@evil.com@redesignhealth.com", ["redesignhealth.com"])).toBe(false);
    });

    it("rejects an address with no `@` at all", () => {
      expect(isEmailDomainAllowed("attacker-evil.com", ["redesignhealth.com"])).toBe(false);
    });

    it("rejects an address with a trailing `@` and nothing after it", () => {
      expect(isEmailDomainAllowed("attacker@", ["redesignhealth.com"])).toBe(false);
    });

    it("trims leading/trailing whitespace before validating", () => {
      expect(isEmailDomainAllowed("  dan@redesignhealth.com  ", ["redesignhealth.com"])).toBe(true);
      // Whitespace padding must not change the `@`-count outcome either.
      expect(isEmailDomainAllowed("  attacker@evil.com@redesignhealth.com  ", ["redesignhealth.com"])).toBe(false);
    });

    it("still normalizes case on an otherwise well-formed address", () => {
      expect(isEmailDomainAllowed("Dan@RedesignHealth.COM", ["redesignhealth.com"])).toBe(true);
    });

    it("does not equate a Unicode/punycode lookalike domain with the allowed domain", () => {
      // Cyrillic "а" (U+0430) in place of the Latin "a" -- visually similar,
      // but a different code point, so exact-segment matching must reject it.
      expect(isEmailDomainAllowed("attacker@redesignheаlth.com", ["redesignhealth.com"])).toBe(false);
      // The punycode encoding of that same homoglyph domain is likewise a
      // distinct string from the plain-ASCII allowed domain.
      expect(isEmailDomainAllowed("attacker@xn--redesignhelth-vfb.com", ["redesignhealth.com"])).toBe(false);
    });
  });
});

describe("mapSsoProviderToOAuthConfig — generic oidc provider with domain restriction", () => {
  // The generic "oidc" provider type builds its config by hand (no named
  // helper like keycloak()/auth0()/okta() sets `getUserInfo` for us), so once
  // a domain restriction or required-role check needs to wrap `getUserInfo`,
  // there must still be a real upstream lookup underneath the wrapper -- not
  // `undefined`, which would make every login silently fail. Exercise the
  // combination the round-2 review flagged as having zero coverage: a generic
  // oidc provider + allowedEmailDomains.

  const genericOidcProvider: SsoProviderConfig = {
    providerId: "generic-corp-oidc",
    type: "oidc",
    clientId: "client-123",
    clientSecret: "secret-123",
    discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
  };

  function base64url(input: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(input)).toString("base64url");
  }

  function fakeIdToken(claims: Record<string, unknown>): string {
    return `${base64url({ alg: "none" })}.${base64url(claims)}.signature`;
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows a matching-domain login through a generic oidc provider", async () => {
    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    expect(config.getUserInfo).toBeDefined();

    const tokens = {
      idToken: fakeIdToken({
        sub: "user-1",
        email: "dan@redesignhealth.com",
        name: "Dan",
      }),
    };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    // The id-token claims satisfy the fallback lookup directly, so no
    // network call to the discovery/userinfo endpoints should be needed.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forces emailVerified to true on a domain-allowed login, even when the IdP's own claim is false/absent", async () => {
    // Enterprise IdPs (Okta's org-managed accounts in particular) routinely
    // omit or falsely-report email_verified for centrally-managed accounts --
    // there's no self-registration "verify your email" step. Better Auth's
    // account-linking trusts that claim, so passing it through unmodified
    // would make linking to an existing account fail for ordinary users on a
    // domain-restricted instance. The domain-allowlist check is the real
    // trust boundary once allowedEmailDomains is configured, so once it
    // passes, emailVerified should be forced true regardless of what the IdP
    // itself reported.
    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);

    const tokens = {
      idToken: fakeIdToken({
        sub: "user-4",
        email: "dan@redesignhealth.com",
        email_verified: false,
        name: "Dan",
      }),
    };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    expect(userInfo?.emailVerified).toBe(true);
  });

  it("rejects a non-matching-domain login through a generic oidc provider", async () => {
    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);

    const tokens = {
      idToken: fakeIdToken({
        sub: "user-2",
        email: "attacker@evil.com",
        name: "Attacker",
      }),
    };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
  });

  it("falls back to fetching the discovery document's userinfo endpoint when the id token lacks claims", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: "user-3", email: "dan@redesignhealth.com", name: "Dan" }),
      } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    expect(fetch).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://idp.example.com/userinfo",
      expect.objectContaining({ headers: { Authorization: "Bearer at-123" } }),
    );
  });

  it("rejects a discovery-sourced userinfo_endpoint that resolves to a link-local/metadata address, without ever fetching it", async () => {
    // A compromised or careless admin-configured discovery document could
    // point userinfo_endpoint at the cloud metadata service. The scheme
    // check alone would let this through if it used https, so use a
    // matching http discovery URL to exercise the private-address guard
    // specifically, not the scheme guard.
    const httpProvider: SsoProviderConfig = {
      ...genericOidcProvider,
      discoveryUrl: "http://idp.example.com/.well-known/openid-configuration",
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userinfo_endpoint: "http://169.254.169.254/latest/meta-data/userinfo" }),
    } as Response);

    const config = mapSsoProviderToOAuthConfig(httpProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
    // Only the discovery document fetch should have happened -- the
    // dangerous userinfo fetch must never be attempted.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "http://idp.example.com/.well-known/openid-configuration",
    );
  });

  it("rejects a discovery-sourced userinfo_endpoint that is cross-origin from the discovery document", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userinfo_endpoint: "https://attacker.example.net/userinfo" }),
    } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a discovery-sourced userinfo_endpoint on a different port of the same hostname", async () => {
    // Same hostname as the discovery document, but a nonstandard port --
    // exactly the shape a same-host internal/attacker-controlled service is
    // likely to take, since it's far easier to stand something up on a
    // different port of a shared host than to somehow control the same
    // host's default port too. `hostname` alone strips the port and would
    // wrongly treat this as same-origin; `host` must not.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userinfo_endpoint: "https://idp.example.com:2375/userinfo" }),
    } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
    // Only the discovery document fetch should have happened -- the
    // wrong-port userinfo endpoint must never be fetched.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a discovery-sourced userinfo_endpoint that redirects to a private address, without following the redirect", async () => {
    // The userinfo endpoint itself passes every static check (same-origin,
    // https, resolves to a public IP), but its live response is a redirect
    // to an internal/private address. The guard must not follow it -- the
    // live Bearer access token would otherwise go out on that second,
    // unvalidated request.
    //
    // `{ status: 302, type: "basic", ok: false }` is what Node's actual
    // global `fetch` (undici) returns for a `redirect: "manual"` request that
    // hits a redirect response -- verified directly against a real HTTP
    // server and against a real cross-origin redirect, both on the Node
    // version this repo's CI uses. Node's fetch does not implement the
    // browser-only "opaque redirect" response type at all (`res.type` is
    // never `"opaqueredirect"` here); that branch in the guard's `if
    // (res.type === "opaqueredirect" || ...)` check is inert in Node but kept
    // as defense in depth in case the runtime's fetch behavior ever changes.
    // The status-code branch is what actually fires, so this mock is already
    // realistic.
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        type: "basic",
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? "http://169.254.169.254/secret" : null) },
      } as unknown as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
    // Discovery fetch + the one userinfo fetch attempt -- never a third
    // request to the redirect target.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://idp.example.com/userinfo",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "http://169.254.169.254/secret",
      expect.anything(),
    );
  });

  it("rejects a discovery-sourced userinfo_endpoint response shaped as an opaque redirect (defense in depth)", async () => {
    // Node's fetch never actually produces this shape (see the comment on
    // the test above), but the guard checks `res.type === "opaqueredirect"`
    // explicitly, so exercise that branch directly in case a future runtime
    // upgrade or fetch polyfill starts producing it.
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        type: "opaqueredirect",
        headers: { get: () => null },
      } as unknown as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts a userinfo_endpoint with an explicit default https port against a default-port-less discovery URL", async () => {
    // Node's `URL` normalizes an explicit default port (443 for https, 80 for
    // http) away entirely -- `new URL("https://idp.example.com:443/x").host`
    // is "idp.example.com", identical to `new URL("https://idp.example.com/x").host`
    // -- so the same-origin `host` comparison in
    // `assertSafeDiscoveryUserInfoEndpoint` cannot be fooled by an explicit
    // `:443`. This was flagged as a possible false-rejection risk; it isn't
    // one, and this test pins that down.
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com:443/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: "user-default-port", email: "dan@redesignhealth.com", name: "Dan" }),
      } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-123" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    // The endpoint fetch itself is issued against the URL as parsed (`URL`
    // strips the redundant port before `.toString()` too), so no explicit
    // ":443" should reach the actual fetch call.
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://idp.example.com/userinfo",
      expect.anything(),
    );
  });

  it("accepts a same-origin https discovery-sourced userinfo_endpoint", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: "user-4", email: "dan@redesignhealth.com", name: "Dan" }),
      } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { accessToken: "at-456" };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves the id token from a snake_case tokens shape identically to camelCase", async () => {
    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);

    const tokens = {
      raw: {
        id_token: fakeIdToken({
          sub: "user-5",
          email: "dan@redesignhealth.com",
          name: "Dan",
        }),
      },
    };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves the access token from a snake_case tokens shape identically to camelCase when falling back to discovery", async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://idp.example.com/userinfo" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: "user-6", email: "dan@redesignhealth.com", name: "Dan" }),
      } as Response);

    const config = mapSsoProviderToOAuthConfig(genericOidcProvider, ["redesignhealth.com"]);
    const tokens = { raw: { access_token: "at-snake-123" } };

    const userInfo = await config.getUserInfo!(tokens as never);
    expect(userInfo).not.toBeNull();
    expect(userInfo?.email).toBe("dan@redesignhealth.com");
    expect(fetch).toHaveBeenCalledWith(
      "https://idp.example.com/userinfo",
      expect.objectContaining({ headers: { Authorization: "Bearer at-snake-123" } }),
    );
  });

  describe("private-network allowance (allowPrivateNetwork argument)", () => {
    // "internal-idp.example.net" isn't "idp.example.com", so the dns mock at
    // the top of this file resolves it to 169.254.169.254 (a private/
    // link-local address) -- standing in for a discovery-sourced
    // userinfo_endpoint that lives on the operator's own private network
    // (e.g. a self-hosted Keycloak on a LAN/Tailscale/VPN, as in the
    // docker-compose SSO dev fixture's `localhost:8080` issuer).
    const internalProvider: SsoProviderConfig = {
      ...genericOidcProvider,
      providerId: "internal-oidc",
      discoveryUrl: "https://internal-idp.example.net/.well-known/openid-configuration",
    };

    it("rejects a private-network userinfo_endpoint by default (strict/no argument)", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://internal-idp.example.net/userinfo" }),
      } as Response);

      const config = mapSsoProviderToOAuthConfig(internalProvider, ["redesignhealth.com"]);
      const userInfo = await config.getUserInfo!({ accessToken: "at-123" } as never);

      expect(userInfo).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects the same private-network userinfo_endpoint when the deployment is authenticated+public", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ userinfo_endpoint: "https://internal-idp.example.net/userinfo" }),
      } as Response);

      // This is the boolean `createBetterAuthInstance` actually derives via
      // `shouldAllowPrivateNetworkTargets` and passes as the third argument
      // to `mapSsoProviderToOAuthConfig` -- not a hand-picked `false`.
      const allowPrivateNetwork = shouldAllowPrivateNetworkTargets({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      });
      expect(allowPrivateNetwork).toBe(false);

      const config = mapSsoProviderToOAuthConfig(internalProvider, ["redesignhealth.com"], allowPrivateNetwork);
      const userInfo = await config.getUserInfo!({ accessToken: "at-123" } as never);

      expect(userInfo).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("allows a private-network userinfo_endpoint when the deployment is authenticated+private", async () => {
      // Round 5 of review flagged `authenticated + private` resolving to
      // "allow private network" as a suspected bug carried over from
      // tool-access.ts/tool-gateway.ts. It is not: per doc/DEPLOYMENT-MODES.md,
      // `authenticated + private` means reachability is scoped to the
      // operator's own network (Tailscale/VPN/LAN), exactly like
      // `local_trusted` -- there is nothing behind that private address the
      // operator doesn't already control. `authenticated + public` is the
      // only state this guard treats as untrusted. This test exercises the
      // actual relaxed path end to end (a previous round only ever tested the
      // default/strict two-argument call), so a regression that silently
      // re-tightens this case fails here.
      const allowPrivateNetwork = shouldAllowPrivateNetworkTargets({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      });
      expect(allowPrivateNetwork).toBe(true);

      (fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ userinfo_endpoint: "https://internal-idp.example.net/userinfo" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: "user-internal", email: "dan@redesignhealth.com", name: "Dan" }),
        } as Response);

      const config = mapSsoProviderToOAuthConfig(internalProvider, ["redesignhealth.com"], allowPrivateNetwork);
      const userInfo = await config.getUserInfo!({ accessToken: "at-123" } as never);

      expect(userInfo).not.toBeNull();
      expect(userInfo?.email).toBe("dan@redesignhealth.com");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        "https://internal-idp.example.net/userinfo",
        expect.objectContaining({ headers: { Authorization: "Bearer at-123" } }),
      );
    });

    it("allows a private-network userinfo_endpoint for local_trusted deployments too", async () => {
      const allowPrivateNetwork = shouldAllowPrivateNetworkTargets({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      });
      expect(allowPrivateNetwork).toBe(true);

      (fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ userinfo_endpoint: "https://internal-idp.example.net/userinfo" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sub: "user-internal-2", email: "dan@redesignhealth.com", name: "Dan" }),
        } as Response);

      const config = mapSsoProviderToOAuthConfig(internalProvider, ["redesignhealth.com"], allowPrivateNetwork);
      const userInfo = await config.getUserInfo!({ accessToken: "at-123" } as never);

      expect(userInfo).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
