import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";

/**
 * GitHub App installation credentials for managed git/gh operations (TECH-9803).
 * Tokens are minted per credential request, scoped to an explicit repository list, held only
 * in a short-lived in-memory cache, and never logged, persisted, or placed in run identity.
 */

/** The only permissions this path ever requests. */
export const GITHUB_APP_TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

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
 * Normalize a repository list to bare repo names. Fails closed (null) on an empty or missing
 * list or any non-string/blank/malformed entry: an unscoped token is never minted.
 */
export function normalizeAppRepositories(repositories: unknown): string[] | null {
  if (!Array.isArray(repositories) || repositories.length === 0) return null;
  const names = new Set<string>();
  for (const entry of repositories) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    const parts = trimmed.split("/");
    const name = parts.length === 2 && parts[0] ? parts[1]! : parts.length === 1 ? parts[0]! : "";
    if (!name || !REPO_NAME_PATTERN.test(name) || name === "." || name === "..") return null;
    names.add(name);
  }
  return [...names].sort();
}

type CachedToken = { token: string; expiresAtMs: number };
const tokenCache = new Map<string, CachedToken>();
let cachedSlug: { appId: string; slug: string } | null = null;

export function resetGitHubAppCachesForTest() {
  tokenCache.clear();
  cachedSlug = null;
}

/** Mint (or reuse) an installation token for exactly these repositories. */
export async function mintGitHubAppInstallationToken(input: {
  repositories: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<GitHubAppResult<{ token: string; identity: { userId: string; login: string } }>> {
  const config = readGitHubAppConfig(input.env);
  if (!config) return { ok: false, error: "The GitHub App installation is not configured on this server" };
  const repositories = normalizeAppRepositories(input.repositories);
  if (!repositories) {
    return { ok: false, error: "The GitHub App grant has no valid repository list; refusing to mint an unscoped token" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  try {
    const appJwt = githubAppJwt(config.appId, config.privateKey, new Date(now()));
    if (!cachedSlug || cachedSlug.appId !== config.appId) {
      const app = await githubBotRequest<{ slug?: unknown }>(fetchImpl, appJwt, "/app");
      if (typeof app.slug !== "string" || !/^[A-Za-z0-9-]+$/.test(app.slug)) throw new Error("invalid app slug");
      cachedSlug = { appId: config.appId, slug: app.slug };
    }
    const identity = { userId: config.appId, login: `${cachedSlug.slug}[bot]` };
    const key = `${config.appId}:${config.installationId}:${repositories.join(",")}`;
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAtMs - EXPIRY_SKEW_MS > now()) return { ok: true, value: { token: hit.token, identity } };
    const minted = await githubBotRequest<{ token?: unknown; expires_at?: unknown }>(
      fetchImpl, appJwt, `/app/installations/${config.installationId}/access_tokens`,
      { method: "POST", body: { repositories, permissions: GITHUB_APP_TOKEN_PERMISSIONS } },
    );
    const expiresAtMs = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
    if (typeof minted.token !== "string" || !minted.token || !Number.isFinite(expiresAtMs)) throw new Error("invalid token response");
    tokenCache.set(key, { token: minted.token, expiresAtMs });
    return { ok: true, value: { token: minted.token, identity } };
  } catch {
    // Deliberately drop the error: it may originate from key parsing or provider responses.
    return { ok: false, error: "GitHub App installation credentials are temporarily unavailable" };
  }
}
