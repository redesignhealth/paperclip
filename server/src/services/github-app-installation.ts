import { logger } from "../middleware/logger.js";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";

/**
 * GitHub App installation credentials for managed git/gh operations (TECH-9803).
 * Tokens are minted per credential request, scoped to an explicit repository list, held only
 * in a short-lived in-memory cache, and never logged, persisted, or placed in run identity.
 */

/** The only permissions this path ever requests. */
export const GITHUB_APP_TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

/** Read-only clone/fetch access, for the git relay (TECH-9792). Never carries write scope. */
export const GITHUB_APP_READ_PERMISSIONS = { contents: "read" } as const;

const EXPIRY_SKEW_MS = 5 * 60_000;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type GitHubAppConfig = { appId: string; installationId: string; privateKey: string };

export type GitHubAppResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Reads server env; tolerates literal `\n` sequences in a single-line PEM. */
export function readGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.PAPERCLIP_GITHUB_APP_ID?.trim();
  const installationId = env.PAPERCLIP_GITHUB_APP_INSTALLATION_ID?.trim();
  const rawKey = env.PAPERCLIP_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !installationId || !rawKey) return null;
  if (!/^[1-9][0-9]*$/.test(installationId) || !/^[1-9][0-9]*$/.test(appId)) return null;
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return { appId, installationId, privateKey };
}

/**
 * Normalize an `owner/name` repository list. Fails closed (null) on an empty or missing list,
 * any non-string/blank/malformed entry, or two owners sharing a repo name (the token request
 * only carries bare names, so that scope could not be expressed exactly).
 */
export function normalizeAppRepositories(repositories: unknown): { fullNames: string[]; names: string[] } | null {
  if (!Array.isArray(repositories) || repositories.length === 0) return null;
  const fullNames = new Set<string>();
  for (const entry of repositories) {
    if (typeof entry !== "string") return null;
    const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(entry.trim());
    if (!match || match[2] === "." || match[2] === "..") return null;
    fullNames.add(`${match[1]}/${match[2]}`.toLowerCase());
  }
  const sorted = [...fullNames].sort();
  const names = sorted.map((fullName) => fullName.split("/")[1]!);
  if (new Set(names).size !== names.length) return null;
  return { fullNames: sorted, names };
}

type CachedToken = { token: string; expiresAtMs: number };
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();
let cachedSlug: { appId: string; slug: string } | null = null;

export function resetGitHubAppCachesForTest() {
  tokenCache.clear();
  inflight.clear();
  cachedSlug = null;
}

class AppTokenError extends Error {
  constructor(readonly category: string) { super(category); }
}

/** Mint (or reuse) an installation token for exactly these repositories. */
export async function mintGitHubAppInstallationToken(input: {
  repositories: unknown;
  /** Defaults to GITHUB_APP_TOKEN_PERMISSIONS. */
  permissions?: Record<string, "read" | "write">;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<GitHubAppResult<{ token: string; identity: { userId: string; login: string } }>> {
  const config = readGitHubAppConfig(input.env);
  if (!config) return { ok: false, error: "The GitHub App installation is not configured on this server" };
  const scope = normalizeAppRepositories(input.repositories);
  if (!scope) {
    logger.warn({ reason: "invalid_repositories" }, "GitHub App token refused");
    return { ok: false, error: "The GitHub App grant has no valid repository list; refusing to mint an unscoped token" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const permissions = input.permissions ?? GITHUB_APP_TOKEN_PERMISSIONS;
  const permissionKey = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("+");
  const key = `${config.appId}:${config.installationId}:${scope.fullNames.join(",")}:${permissionKey}`;
  try {
    const signJwt = () => {
      try { return githubAppJwt(config.appId, config.privateKey, new Date(now())); }
      catch { throw new AppTokenError("invalid_private_key"); }
    };
    const identityFor = () => ({ userId: config.appId, login: `${cachedSlug!.slug}[bot]` });
    const fresh = (entry: CachedToken | undefined) => entry && entry.expiresAtMs - EXPIRY_SKEW_MS > now() ? entry : null;
    for (const [cacheKey, entry] of tokenCache) if (entry.expiresAtMs <= now()) tokenCache.delete(cacheKey);
    const hit = fresh(tokenCache.get(key));
    if (hit && cachedSlug?.appId === config.appId) return { ok: true, value: { token: hit.token, identity: identityFor() } };
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        if (!cachedSlug || cachedSlug.appId !== config.appId) {
          const app = await githubBotRequest<{ slug?: unknown }>(fetchImpl, signJwt(), "/app");
          if (typeof app.slug !== "string" || !/^[A-Za-z0-9-]+$/.test(app.slug)) throw new AppTokenError("invalid_app_slug");
          cachedSlug = { appId: config.appId, slug: app.slug };
        }
        const minted = await githubBotRequest<{ token?: unknown; expires_at?: unknown; repositories?: unknown }>(
          fetchImpl, signJwt(), `/app/installations/${config.installationId}/access_tokens`,
          { method: "POST", body: { repositories: scope.names, permissions } },
        );
        const expiresAtMs = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
        if (typeof minted.token !== "string" || !minted.token || !Number.isFinite(expiresAtMs)) throw new AppTokenError("invalid_token_response");
        // Bare names resolve against the installation owner. Verify GitHub scoped the token to
        // exactly the owner/name set this grant names; otherwise discard it.
        const granted = Array.isArray(minted.repositories)
          ? minted.repositories.map((repo) => (repo && typeof (repo as { full_name?: unknown }).full_name === "string"
              ? (repo as { full_name: string }).full_name.toLowerCase() : "")).sort()
          : null;
        if (!granted || granted.length !== scope.fullNames.length || granted.some((name, i) => name !== scope.fullNames[i])) {
          throw new AppTokenError("scope_mismatch");
        }
        return { token: minted.token, expiresAtMs };
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const entry = await pending;
    tokenCache.set(key, entry);
    return { ok: true, value: { token: entry.token, identity: identityFor() } };
  } catch (error) {
    // Log a coarse category only: provider bodies and key-parse errors can carry secrets.
    // githubBotRequest wraps every rejection as a 422 whose fixed message names GitHub's status.
    const status = error instanceof Error ? /^GitHub rejected this operation \(HTTP (\d{3})\)/.exec(error.message)?.[1] : undefined;
    const reason = error instanceof AppTokenError ? error.category
      : status ? `github_http_${status}` : "request_failed";
    logger.warn({ reason }, "GitHub App token unavailable");
    return { ok: false, error: "GitHub App installation credentials are temporarily unavailable" };
  }
}
