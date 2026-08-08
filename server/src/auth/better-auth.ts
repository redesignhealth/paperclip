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
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

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

function mapSsoProviderToOAuthConfig(
  provider: SsoProviderConfig,
  allowedEmailDomains: string[],
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

  const upstreamGetUserInfo = baseConfig.getUserInfo;

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

  const oauthConfigs = config.ssoProviders.map((provider) =>
    mapSsoProviderToOAuthConfig(provider, ssoSettings.allowedEmailDomains),
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
