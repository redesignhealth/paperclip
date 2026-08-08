import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
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
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
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

function userHasRequiredRole(
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
async function assertSafeDiscoveryUserInfoEndpoint(
  userInfoUrl: string,
  discoveryUrl: string,
  providerId: string | undefined,
  allowPrivateNetwork: boolean,
): Promise<URL | null> {
  let discovery: URL;
  let userInfo: URL;
  try {
    discovery = new URL(discoveryUrl);
    userInfo = new URL(userInfoUrl);
  } catch {
    logger.warn({ providerId }, "SSO discovery userinfo_endpoint rejected: not a valid URL");
    return null;
  }

  const isSecureEnough =
    userInfo.protocol === "https:" || (userInfo.protocol === "http:" && discovery.protocol === "http:");
  if (!isSecureEnough) {
    logger.warn({ providerId }, "SSO discovery userinfo_endpoint rejected: insecure scheme");
    return null;
  }

  // Compare `host` (hostname + port), not just `hostname`. `hostname` strips
  // the port, so an endpoint on a different, attacker-controlled port of the
  // same hostname (e.g. an internal service listening on a nonstandard port)
  // would otherwise pass this check even though it is not actually the IdP's
  // origin.
  if (userInfo.host.toLowerCase() !== discovery.host.toLowerCase()) {
    logger.warn(
      { providerId },
      "SSO discovery userinfo_endpoint rejected: not same-origin as the discovery document",
    );
    return null;
  }

  try {
    await assertPublicRemoteHttpEndpoint(userInfo, { allowPrivateNetwork }, (message) => new Error(message));
  } catch (err) {
    logger.warn(
      { providerId, err },
      "SSO discovery userinfo_endpoint rejected: resolves to a private/reserved network address",
    );
    return null;
  }

  return userInfo;
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
        id: claims.sub,
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
    const validated = await assertSafeDiscoveryUserInfoEndpoint(
      userInfoUrl,
      config.discoveryUrl!,
      config.providerId,
      allowPrivateNetwork,
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
      id: String(id),
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
  const needsWrapping = Boolean(requirement) || allowedEmailDomains.length > 0;
  if (!needsWrapping) {
    return baseConfig;
  }

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

      if (idToken) {
        const claims = decodeJwtPayload(idToken);
        if (claims && userHasRequiredRole(claims, requirement)) {
          hasRole = true;
        }
      }

      if (!hasRole && accessToken) {
        const claims = decodeJwtPayload(accessToken);
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

    return userInfo;
  };

  return baseConfig;
}

export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  ssoSettings: SsoAuthSettings = DEFAULT_SSO_AUTH_SETTINGS,
): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
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
  const oauthConfigs = config.ssoProviders.map((provider) =>
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
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(oauthConfigs.length > 0
      ? {
          accountLinking: {
            enabled: true,
            trustedProviders: config.ssoProviders.map((p) => p.providerId),
          },
        }
      : {}),
  };

  if (!baseUrl) {
    delete authConfig.baseURL;
  }

  return betterAuth(authConfig as Parameters<typeof betterAuth>[0]);
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
