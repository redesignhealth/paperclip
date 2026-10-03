import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import {
  genericOAuth,
  keycloak,
  auth0,
  okta,
  microsoftEntraId,
} from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { SsoProviderConfig, SsoRoleRequirement } from "@paperclipai/shared";
import { shouldAllowPrivateNetworkTargets } from "@paperclipai/shared";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import {
  workspaceLoginHandoffPlugin,
  type WorkspaceHandoffExpectedIdentity,
} from "./workspace-login-handoff-plugin.js";
import {
  normalizeWorkspaceHandoffOrigin,
  resolveWorkspaceHandoffLocalCompanyId,
  resolveWorkspaceHandoffLocalKey,
  resolveWorkspaceHandoffLocalWorkspaceId,
} from "./workspace-login-handoff.js";
import { logger } from "../middleware/logger.js";
import { assertPublicRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldEnableAuthRateLimit(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}): boolean {
  const override = input.override?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  return input.deploymentMode === "authenticated";
}

export function buildBetterAuthRateLimitOptions(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}) {
  return {
    enabled: shouldEnableAuthRateLimit(input),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
  managedRuntimePublicUrl?: string | undefined;
  requestUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (
    input.deploymentMode === "authenticated" &&
    isHttpsUrl(publicUrl) &&
    isHttpsUrl(input.managedRuntimePublicUrl) &&
    isHttpLoopbackUrl(input.requestUrl)
  ) {
    return true;
  }
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function isHttpLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function requestUrlFromHeaders(headers: Headers): string | undefined {
  const host = headers.get("host")?.trim();
  if (!host) return undefined;

  const forwardedProtocol = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : (() => {
      try {
        return isLoopbackHostname(new URL(`http://${host}`).hostname) ? "http" : "https";
      } catch {
        return "https";
      }
    })();
  return `${protocol}://${host}`;
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveClaimAtPath(claims: Record<string, unknown>, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function userHasRequiredRole(
  claims: Record<string, unknown>,
  requirement: SsoRoleRequirement,
): boolean {
  const value = resolveClaimAtPath(claims, requirement.claimPath);
  if (Array.isArray(value)) {
    return requirement.roles.some((role: string) => value.includes(role));
  }
  if (typeof value === "string") {
    return requirement.roles.includes(value);
  }
  return false;
}

/**
 * Which configured SSO provider ids Better Auth should trust for
 * email-based account linking (its `accountLinking.trustedProviders`),
 * bypassing its own default requirement that the incoming login's
 * `userInfo.emailVerified` be `true` before it may link into an existing
 * account.
 *
 * This must NOT be every configured provider: Better Auth's link-account
 * decision is `(!isTrustedProvider && !userInfo.emailVerified) || ...` --
 * marking every provider "trusted" makes the real, per-login
 * `userInfo.emailVerified` value irrelevant for all of them, so an
 * attacker-controlled IdP (or a permissive generic OIDC provider an admin
 * adds later with no domain restriction) could assert an unverified email
 * matching an existing victim account and link straight into it.
 *
 * Only providers this codebase has *already* decided to unconditionally
 * trust for email verification belong here -- the exact same set the
 * `forceEmailVerified` override in `mapSsoProviderToOAuthConfig` applies to
 * (an enterprise IdP type with `trustEmailVerified: true` explicitly set).
 * For those, `userInfo.emailVerified` is already forced `true` before
 * Better Auth ever sees it, so listing them here changes nothing in
 * practice for the happy path -- it only keeps the *other* providers off
 * the bypass, which is the point: their real (possibly `false`)
 * `emailVerified` signal governs linking, exactly as it should.
 */
export function computeSsoAccountLinkingTrustedProviders(
  providers: SsoProviderConfig[],
): string[] {
  return providers
    .filter((provider) => provider.trustEmailVerified === true && provider.type !== "oidc")
    .map((provider) => provider.providerId);
}

export interface SsoAuthSettings {
  allowedEmailDomains: string[];
  disablePasswordAuth: boolean;
}

export const DEFAULT_SSO_AUTH_SETTINGS: SsoAuthSettings = {
  allowedEmailDomains: [],
  disablePasswordAuth: false,
};

// Exact-segment, case-insensitive match on the part of the email after the
// last "@". Empty/absent allowedDomains means "no restriction" (fail open) —
// but once a list is set, anything not matching is rejected (fail closed).
// Must never substring-match: "evilexample.com" must not pass a check for
// "example.com".
export function isEmailDomainAllowed(email: string | null | undefined, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  if (!email) return false;
  const trimmed = email.trim();
  // Reject anything that isn't a well-formed single-`@` address outright. An
  // IdP returning e.g. "attacker@evil.com@allowed.com" must not be able to
  // smuggle a second, allowed-looking domain past `lastIndexOf`-based
  // parsing -- count the `@`s first and bail unless there is exactly one.
  const atCount = trimmed.split("@").length - 1;
  if (atCount !== 1) return false;
  const at = trimmed.indexOf("@");
  if (at === -1 || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!domain) return false;
  return allowedDomains.some((allowed) => domain === allowed.trim().toLowerCase());
}

type OAuthGetUserInfo = NonNullable<GenericOAuthConfig["getUserInfo"]>;
type OAuthTokens = Parameters<OAuthGetUserInfo>[0];
type OAuthUserInfoResult = Awaited<ReturnType<OAuthGetUserInfo>>;

// better-auth's generic-oauth plugin only does discovery-based userinfo
// fetching internally when a provider config has no `getUserInfo` at all
// (see the plugin's callback route: `providerConfig.getUserInfo ? ... :
// await getUserInfo(...)`). None of the named provider helpers we use below
// (keycloak/auth0/okta) set `getUserInfo` — only microsoftEntraId does — and
// neither does the hand-built "oidc" config. Once we wrap a config to
// enforce domain/role restrictions we replace `getUserInfo` outright, which
// bypasses that internal fallback entirely: `upstreamGetUserInfo` would be
// undefined and every login would be silently rejected. Replicate the same
// discovery-based lookup here so a wrapped config behaves identically to an
// unwrapped one.
// A discovery-sourced userinfo_endpoint comes from the IdP's own
// `.well-known` document, which the admin who configured the provider does
// not directly control the contents of -- so a compromised or careless IdP
// config could point it at an internal service, loopback, or a cloud
// metadata endpoint (169.254.169.254) and this code would hand it a live
// access token. This is not a defense against arbitrary end-user input (the
// discovery URL itself is admin-configured), so the bar is "don't blindly
// trust a field pulled out of a fetched document," not exhaustive SSRF
// hardening: require the endpoint to stay on the same host the discovery
// document was fetched from (an IdP's userinfo endpoint lives alongside its
// discovery document), require https unless the discovery URL itself was
// http (e.g. local/dev setups), and reject any endpoint that resolves to a
// private/loopback/link-local address using the same DNS-resolving guard
// already used for remote MCP endpoints.
async function assertSafeDiscoverySourcedEndpoint(
  endpointUrl: string,
  discoveryUrl: string,
  providerId: string | undefined,
  allowPrivateNetwork: boolean,
  endpointLabel: string,
): Promise<URL | null> {
  let discovery: URL;
  let endpoint: URL;
  try {
    discovery = new URL(discoveryUrl);
    endpoint = new URL(endpointUrl);
  } catch {
    logger.warn({ providerId }, `SSO discovery ${endpointLabel} rejected: not a valid URL`);
    return null;
  }

  const isSecureEnough =
    endpoint.protocol === "https:" || (endpoint.protocol === "http:" && discovery.protocol === "http:");
  if (!isSecureEnough) {
    logger.warn({ providerId }, `SSO discovery ${endpointLabel} rejected: insecure scheme`);
    return null;
  }

  // Compare `host` (hostname + port), not just `hostname`. `hostname` strips
  // the port, so an endpoint on a different, attacker-controlled port of the
  // same hostname (e.g. an internal service listening on a nonstandard port)
  // would otherwise pass this check even though it is not actually the IdP's
  // origin.
  if (endpoint.host.toLowerCase() !== discovery.host.toLowerCase()) {
    logger.warn(
      { providerId },
      `SSO discovery ${endpointLabel} rejected: not same-origin as the discovery document`,
    );
    return null;
  }

  try {
    await assertPublicRemoteHttpEndpoint(endpoint, { allowPrivateNetwork }, (message) => new Error(message));
  } catch (err) {
    logger.warn(
      { providerId, err },
      `SSO discovery ${endpointLabel} rejected: resolves to a private/reserved network address`,
    );
    return null;
  }

  return endpoint;
}

// Asymmetric-only algorithm allowlist for verifying SSO-provider-issued JWTs
// (id_token/access_token role claims) against a discovery-sourced JWKS.
// Excluding symmetric (HS*) algorithms is deliberate defense-in-depth against
// algorithm-confusion attacks: a JWKS of verification keys should never
// contain a shared secret, but restricting the accepted algorithms here means
// a malformed or compromised JWKS entry cannot make a forged HS*-signed token
// verify against, say, an RSA public key's bytes treated as an HMAC secret.
const SSO_JWT_VERIFY_ALGORITHMS = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
];

interface SsoDiscoveryDocumentForJwtVerification {
  issuer?: string;
  jwks_uri?: string;
}

async function fetchSsoDiscoveryDocument(
  discoveryUrl: string,
  providerId: string | undefined,
): Promise<SsoDiscoveryDocumentForJwtVerification | null> {
  try {
    const res = await fetch(discoveryUrl);
    if (!res.ok) return null;
    return (await res.json()) as SsoDiscoveryDocumentForJwtVerification;
  } catch (err) {
    logger.warn({ providerId, err }, "SSO JWT verification skipped: discovery fetch failed");
    return null;
  }
}

/**
 * Cryptographically verifies an SSO-provider-issued JWT (an id_token or
 * access_token) against the IdP's own JWKS before any of its claims — in
 * particular the role claims `userHasRequiredRole` reads — can be trusted.
 *
 * Without this, a caller could hand this code ANY JSON payload wrapped in
 * JWT-shaped base64url segments (no valid signature required) and have its
 * claims accepted at face value for an authorization decision — decoding a
 * JWT's payload is not verification.
 *
 * `expectedAudience` is only enforced when provided. It is required for an
 * id_token (OIDC core mandates `aud` contain the client_id), but
 * deliberately NOT enforced for an access_token: access-token audiences are
 * implementation-defined per IdP (often a resource-server identifier, not
 * the OAuth client_id), so requiring a match here would reject valid,
 * differently-audienced access tokens from well-behaved IdPs. Signature,
 * issuer, and expiration are still enforced either way.
 */
async function verifyDiscoverySourcedSsoJwt(
  token: string,
  discoveryUrl: string,
  providerId: string | undefined,
  allowPrivateNetwork: boolean,
  expectedAudience: string | undefined,
): Promise<Record<string, unknown> | null> {
  const discovery = await fetchSsoDiscoveryDocument(discoveryUrl, providerId);
  if (!discovery?.issuer || !discovery.jwks_uri) {
    logger.warn(
      { providerId },
      "SSO JWT verification skipped: discovery document is missing issuer/jwks_uri",
    );
    return null;
  }

  const safeJwksUrl = await assertSafeDiscoverySourcedEndpoint(
    discovery.jwks_uri,
    discoveryUrl,
    providerId,
    allowPrivateNetwork,
    "jwks_uri",
  );
  if (!safeJwksUrl) return null;

  try {
    const jwks = createRemoteJWKSet(safeJwksUrl);
    const verifyOptions: JWTVerifyOptions = {
      issuer: discovery.issuer,
      algorithms: SSO_JWT_VERIFY_ALGORITHMS,
      ...(expectedAudience ? { audience: expectedAudience } : {}),
    };
    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    return payload;
  } catch (err) {
    logger.warn({ providerId, err }, "SSO JWT verification failed");
    return null;
  }
}

async function fetchUserInfoViaDiscovery(
  tokens: OAuthTokens,
  config: GenericOAuthConfig,
  allowPrivateNetwork: boolean,
): Promise<OAuthUserInfoResult> {
  const tokensRecord = tokens as Record<string, unknown>;
  const rawTokens = tokensRecord.raw as Record<string, unknown> | undefined;
  const idToken = (tokensRecord.idToken as string | undefined) ?? (rawTokens?.id_token as string | undefined);
  if (idToken) {
    const claims = decodeJwtPayload(idToken);
    if (claims && typeof claims.sub === "string" && typeof claims.email === "string") {
      return {
        // Better Auth's own account-key resolution reads `sub` for any
        // provider its generic-oauth plugin classifies as OIDC (any
        // provider whose discovery document advertises
        // `id_token_signing_alg_values_supported`, which real Okta/Auth0/
        // Keycloak discovery documents always do) and falls back to `id`
        // only for plain OAuth providers. Set both to the same value so
        // account-key resolution finds a subject either way -- omitting
        // `sub` here previously made every live Okta login fail with
        // Better Auth's OAUTH_ACCOUNT_SUBJECT_INVALID (surfaced to the
        // browser as the generic `unable_to_get_user_info`), undetected by
        // this suite's own tests because their mocked discovery documents
        // didn't include that field and so were classified non-OIDC.
        id: claims.sub,
        sub: claims.sub,
        email: claims.email,
        emailVerified: Boolean(claims.email_verified),
        name: typeof claims.name === "string" ? claims.name : undefined,
        image: typeof claims.picture === "string" ? claims.picture : undefined,
      } as OAuthUserInfoResult;
    }
  }

  let userInfoUrl = config.userInfoUrl;
  let userInfoUrlIsFromDiscovery = false;
  if (!userInfoUrl && config.discoveryUrl) {
    try {
      const res = await fetch(config.discoveryUrl);
      if (res.ok) {
        const discovery = (await res.json()) as { userinfo_endpoint?: string };
        userInfoUrl = discovery.userinfo_endpoint;
        userInfoUrlIsFromDiscovery = true;
      }
    } catch (err) {
      logger.warn(
        { providerId: config.providerId, err },
        "SSO discovery fetch failed while resolving userinfo endpoint",
      );
    }
  }

  const accessToken = (tokensRecord.accessToken as string | undefined) ?? (rawTokens?.access_token as string | undefined);
  if (!userInfoUrl || !accessToken) return null;

  if (userInfoUrlIsFromDiscovery) {
    const validated = await assertSafeDiscoverySourcedEndpoint(
      userInfoUrl,
      config.discoveryUrl!,
      config.providerId,
      allowPrivateNetwork,
      "userinfo_endpoint",
    );
    if (!validated) return null;
    userInfoUrl = validated.toString();
  }

  try {
    // `redirect: "manual"` so a userinfo endpoint that passed every check
    // above cannot 302 the live access token to an unvalidated (and
    // possibly private/internal) address one hop later. A redirect response
    // is treated the same as any other guard failure: log and return null,
    // never follow it.
    const res = await fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      logger.warn(
        { providerId: config.providerId },
        "SSO userinfo fetch rejected: endpoint returned a redirect",
      );
      return null;
    }
    if (!res.ok) return null;
    const profile = (await res.json()) as Record<string, unknown>;
    const id = (profile.sub ?? profile.id) as string | number | undefined;
    const email = profile.email as string | undefined;
    if (!id || !email) return null;
    return {
      // See the id_token branch above for why both `id` and `sub` are set.
      id: String(id),
      sub: String(id),
      email,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name as string | undefined,
      image: profile.picture as string | undefined,
    } as OAuthUserInfoResult;
  } catch (err) {
    logger.warn({ providerId: config.providerId, err }, "SSO userinfo fetch failed");
    return null;
  }
}

export function mapSsoProviderToOAuthConfig(
  provider: SsoProviderConfig,
  allowedEmailDomains: string[],
  // Defaults to the strict setting (matches assertPublicRemoteHttpEndpoint's
  // own default) so existing call sites/tests that don't pass this keep the
  // safer behavior rather than silently loosening it.
  allowPrivateNetwork = false,
): GenericOAuthConfig {
  const base = {
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    ...(provider.scopes ? { scopes: provider.scopes } : {}),
  };

  let baseConfig: GenericOAuthConfig;
  switch (provider.type) {
    case "keycloak":
      baseConfig = keycloak({ ...base, issuer: provider.issuer! });
      break;
    case "auth0":
      baseConfig = auth0({
        ...base,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        domain: provider.domain ?? new URL(provider.issuer!).hostname,
      });
      break;
    case "okta":
      baseConfig = okta({ ...base, issuer: provider.issuer! });
      break;
    case "microsoft_entra_id":
      baseConfig = microsoftEntraId({ ...base, tenantId: provider.tenantId! });
      break;
    case "oidc":
      baseConfig = {
        providerId: provider.providerId,
        discoveryUrl: provider.discoveryUrl!,
        ...base,
      };
      break;
  }

  const requirement = provider.requiredRoles;

  // Always wrap `getUserInfo`, even when neither `requiredRoles` nor a
  // domain allowlist is configured. This is what makes the discovery-sourced
  // SSRF guard (`assertSafeDiscoverySourcedEndpoint`, via
  // `fetchUserInfoViaDiscovery` below) apply unconditionally: without it, a
  // provider with no optional restrictions configured would fall through to
  // Better Auth's own built-in userinfo fallback, which fetches a
  // discovery-sourced `userinfo_endpoint` with no SSRF protection at all.
  const upstreamGetUserInfo: OAuthGetUserInfo =
    baseConfig.getUserInfo ?? ((tokens) => fetchUserInfoViaDiscovery(tokens, baseConfig, allowPrivateNetwork));

  baseConfig.getUserInfo = async (tokens) => {
    if (requirement) {
      const rawTokens = tokens.raw as Record<string, unknown> | undefined;
      const idToken = (tokens as Record<string, unknown>).idToken as string | undefined
        ?? rawTokens?.id_token as string | undefined;
      const accessToken = (tokens as Record<string, unknown>).accessToken as string | undefined
        ?? rawTokens?.access_token as string | undefined;

      let hasRole = false;

      // Cryptographically verify each token against the IdP's own JWKS
      // (signature, issuer, expiration -- audience too for the id_token,
      // where OIDC core mandates `aud` contain the client_id) before
      // trusting any claim read out of it. A merely *decoded* JWT is
      // attacker-forgeable: anyone can hand this code a JSON payload
      // wrapped in JWT-shaped base64url segments with an arbitrary "role"
      // claim and no valid signature at all.
      if (idToken && baseConfig.discoveryUrl) {
        const claims = await verifyDiscoverySourcedSsoJwt(
          idToken,
          baseConfig.discoveryUrl,
          provider.providerId,
          allowPrivateNetwork,
          provider.clientId,
        );
        if (claims && userHasRequiredRole(claims, requirement)) {
          hasRole = true;
        }
      }

      if (!hasRole && accessToken && baseConfig.discoveryUrl) {
        const claims = await verifyDiscoverySourcedSsoJwt(
          accessToken,
          baseConfig.discoveryUrl,
          provider.providerId,
          allowPrivateNetwork,
          undefined,
        );
        if (claims && userHasRequiredRole(claims, requirement)) {
          hasRole = true;
        }
      }

      if (idToken || accessToken) {
        if (!hasRole) {
          logger.warn(
            {
              providerId: provider.providerId,
              claimPath: requirement.claimPath,
              requiredRoles: requirement.roles,
            },
            "SSO login rejected: user does not have required role",
          );
          return null;
        }
      } else {
        logger.warn(
          { providerId: provider.providerId },
          "SSO role check skipped: no id_token or access_token in response — access denied",
        );
        return null;
      }
    }

    const userInfo = upstreamGetUserInfo ? await upstreamGetUserInfo(tokens) : null;
    if (!userInfo) return null;

    // Server-side email-domain restriction. This runs on the OAuth callback path
    // (not just the login-button UI) and before Better Auth's account-linking
    // logic ever sees the user, so a disallowed domain cannot reach — let alone
    // link to — an existing account.
    if (!isEmailDomainAllowed(userInfo.email, allowedEmailDomains)) {
      logger.warn(
        { providerId: provider.providerId },
        "SSO login rejected: email domain not allowed",
      );
      return null;
    }

    // Require a genuinely verified email by default.
    // Any override forcing `emailVerified: true` for an enterprise IdP must be
    // explicit and scoped to that specific, trusted provider configuration
    // (`trustEmailVerified: true` on an enterprise provider type, never generic oidc)
    // rather than a blanket rule for anything domain-allowlisted.
    const isEnterpriseIdP = provider.type !== "oidc";
    const forceEmailVerified = Boolean(provider.trustEmailVerified && isEnterpriseIdP);
    const emailVerified = forceEmailVerified ? true : Boolean(userInfo.emailVerified);

    return { ...userInfo, emailVerified };
  };

  return baseConfig;
}

/**
 * Identity a managed workspace instance compares an inbound handoff ticket
 * against. Every field comes from persisted configuration or injected runtime
 * identity — never from request headers — so a spoofed `X-Forwarded-Host` or
 * Tailscale identity header cannot retarget a ticket. Returns null when this
 * process was not started as a managed workspace, which leaves the exchange
 * endpoint unregistered.
 */
export function resolveWorkspaceHandoffIdentity(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceHandoffExpectedIdentity | null {
  const key = resolveWorkspaceHandoffLocalKey(env);
  if (!key) return null;
  const configuredOrigin =
    normalizeWorkspaceHandoffOrigin(env.PAPERCLIP_PUBLIC_URL)
    ?? (config.authBaseUrlMode === "explicit"
      ? normalizeWorkspaceHandoffOrigin(config.authPublicBaseUrl)
      : null);
  return {
    key,
    instanceId: resolvePaperclipInstanceId(),
    executionWorkspaceId: resolveWorkspaceHandoffLocalWorkspaceId(env),
    companyId: resolveWorkspaceHandoffLocalCompanyId(env),
    origin: configuredOrigin,
  };
}


export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  ssoSettings: SsoAuthSettings = DEFAULT_SSO_AUTH_SETTINGS,
): BetterAuthInstance {  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const managedRuntimePublicUrl = process.env.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL?.trim() || undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  // Shared `shouldAllowPrivateNetworkTargets` policy (packages/shared/src/
  // constants.ts) -- the same derivation `tool-access.ts` and
  // `tool-gateway.ts` use for remote HTTP endpoints they don't fully control
  // the destination of: private network targets are only blocked in
  // "authenticated" + "public" exposure deployments. The reasoning carries
  // over here even though the discovery URL itself is admin-configured
  // (unlike a tool connection, which any authenticated user of a public
  // multi-tenant instance might add) -- what's actually untrusted is the
  // userinfo_endpoint pulled out of the IdP's *response*, not the discovery
  // URL. In a local_trusted/private deployment that response can only point
  // back into the operator's own already-trusted network, so blocking it
  // buys nothing; in a public multi-tenant deployment it could point at
  // shared internal infra, which is exactly what this guard exists to stop.
  // (This is also why the docker-compose SSO dev fixture, which points a
  // real issuer at a private `localhost:8080` Keycloak, deliberately runs
  // as `authenticated`/`private` -- see docker/docker-compose.sso.yml.)
  const allowPrivateNetworkForSso = shouldAllowPrivateNetworkTargets({
    deploymentMode: config.deploymentMode,
    // config.ts always resolves this before Config is constructed, so this
    // is never actually undefined today -- defaulted to "private" (the
    // fail-safe direction, same as tool-access.ts/tool-gateway.ts) purely
    // so a future loosening of Config's type can't silently relax this
    // guard in the strictest deployment posture.
    deploymentExposure: config.deploymentExposure ?? "private",
  });
  const oauthConfigs = (config.ssoProviders ?? []).map((provider) =>
    mapSsoProviderToOAuthConfig(provider, ssoSettings.allowedEmailDomains, allowPrivateNetworkForSso),
  );
  const plugins = oauthConfigs.length > 0 ? [genericOAuth({ config: oauthConfigs })] : [];

  const authConfig: Record<string, unknown> = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      // Once turned off, existing accounts can no longer authenticate with a
      // password at all — this is the "criterion 2" switch, distinct from
      // authDisableSignUp (which only blocks *new* password sign-ups and still
      // lets existing password users log in).
      enabled: !ssoSettings.disablePasswordAuth,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    rateLimit: buildBetterAuthRateLimitOptions({
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
      override: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    }),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
    ...(() => {
      const handoffPlugin = resolveWorkspaceHandoffIdentity(config)
        ? workspaceLoginHandoffPlugin({
            db,
            resolveExpectedIdentity: () =>
              resolveWorkspaceHandoffIdentity(config) ?? {
                key: null,
                instanceId: null,
                executionWorkspaceId: null,
                companyId: null,
                origin: null,
              },
          })
        : null;
      const allPlugins = [
        ...(plugins.length > 0 ? plugins : []),
        ...(handoffPlugin ? [handoffPlugin] : []),
      ];
      return allPlugins.length > 0 ? { plugins: allPlugins } : {};
    })(),
    // Better Auth reads this at `options.account.accountLinking`, NOT at a
    // top-level `options.accountLinking` -- nesting it under `account` here
    // is load-bearing, not stylistic. A top-level key is silently ignored
    // (see `getTrustedProviders` / `link-account.mjs`'s
    // `c.context.options.account?.accountLinking`), which would make
    // `enabled`, `trustedProviders`, and `requireLocalEmailVerified` all
    // inert -- Better Auth would fall back to its own defaults for every one
    // of them without any indication anything was misconfigured.
    ...(oauthConfigs.length > 0
      ? {
          account: {
            accountLinking: {
              enabled: true,
              trustedProviders: computeSsoAccountLinkingTrustedProviders(config.ssoProviders),
            },
          },
        }
      : {}),
  };

  if (!baseUrl) {
    delete authConfig.baseURL;
  }

  const defaultAuth = betterAuth(authConfig as Parameters<typeof betterAuth>[0]);
  const supportsManagedLoopbackAuth = Boolean(
    !disableSecureCookies &&
    isHttpsUrl(publicUrl) &&
    isHttpsUrl(managedRuntimePublicUrl),
  );
  if (!supportsManagedLoopbackAuth) return defaultAuth;

  // Better Auth fixes both the Secure attribute and the __Secure- name prefix
  // when an instance is created. Keep the public instance unchanged and route
  // only managed HTTP-loopback requests through a cookie-compatible instance.
  const loopbackAuth = betterAuth({
    ...authConfig,
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: true }),
  } as Parameters<typeof betterAuth>[0]);
  const cookieSecurityInput = {
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
    managedRuntimePublicUrl,
  };

  return {
    handler: (request) => {
      const auth = shouldDisableSecureAuthCookies({
        ...cookieSecurityInput,
        requestUrl: request.url,
      }) ? loopbackAuth : defaultAuth;
      return auth.handler(request);
    },
    api: {
      getSession: (input) => {
        const auth = shouldDisableSecureAuthCookies({
          ...cookieSecurityInput,
          requestUrl: requestUrlFromHeaders(input.headers),
        }) ? loopbackAuth : defaultAuth;
        return auth.api.getSession(input);
      },
    },
  };
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export interface BetterAuthManager {
  handler: RequestHandler;
  resolveSession: (req: Request) => Promise<BetterAuthSessionResult | null>;
  resolveSessionFromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  rebuild: (ssoProviders: SsoProviderConfig[], ssoSettings?: SsoAuthSettings) => void;
}

export function createBetterAuthManager(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  initialSsoSettings: SsoAuthSettings = DEFAULT_SSO_AUTH_SETTINGS,
): BetterAuthManager {
  let currentAuth = createBetterAuthInstance(db, config, trustedOrigins, initialSsoSettings);
  let currentHandler = toNodeHandler(currentAuth);

  const manager: BetterAuthManager = {
    handler: (req, res, next) => {
      void Promise.resolve(currentHandler(req, res)).catch(next);
    },
    resolveSession: (req) => resolveBetterAuthSession(currentAuth, req),
    resolveSessionFromHeaders: (headers) =>
      resolveBetterAuthSessionFromHeaders(currentAuth, headers),
    rebuild: (ssoProviders, ssoSettings = DEFAULT_SSO_AUTH_SETTINGS) => {
      const updatedConfig = { ...config, ssoProviders };
      currentAuth = createBetterAuthInstance(db, updatedConfig, trustedOrigins, ssoSettings);
      currentHandler = toNodeHandler(currentAuth);
      logger.info(
        {
          providers: ssoProviders.map((p) => p.providerId),
          allowedEmailDomains: ssoSettings.allowedEmailDomains,
          disablePasswordAuth: ssoSettings.disablePasswordAuth,
        },
        "Better Auth instance rebuilt with updated SSO providers",
      );
    },
  };

  return manager;
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
