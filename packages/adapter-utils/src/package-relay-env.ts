/**
 * Package-registry relay environment for sandboxed builder agents (TECH-9786).
 *
 * The pod cannot reach the private package registry or private GitHub repositories and holds no credential. The Paperclip
 * server relays read-only package requests (`/api/package-relay/gitea/...`) and git fetches (`/api/package-relay/github/...`)
 * with its own tokens. This builds the installer settings
 * that point uv at the in-pod bridge gateway (uv only; pip is deliberately not configured). The only credential in them is the run-scoped bridge token the pod
 * already holds. It applies only to agents that opt in with `PAPERCLIP_PACKAGE_RELAY` listing `gitea` and/or `github` in their adapter env.
 */
import type { SandboxCallbackBridgeRoutePolicy } from "./sandbox-callback-bridge.js";

export const PACKAGE_RELAY_OPT_IN_ENV_KEY = "PAPERCLIP_PACKAGE_RELAY";
export const PACKAGE_RELAY_GITEA_INDEX_PATH = "/api/package-relay/gitea/simple/";
export const PACKAGE_RELAY_GITHUB_PATH = "/api/package-relay/github/";
/** The server's list of GitHub repositories the git relay serves (`owner/name,owner/name`). */
export const PACKAGE_RELAY_GITHUB_REPOS_ENV = "PAPERCLIP_PACKAGE_RELAY_GITHUB_REPOS";
const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Bridge route policy for the relay routes: their own lane, and an in-pod response deadline a margin above the server
 * relay's 60 s upstream deadline (server/src/routes/package-relay.ts). Without a policy the routes would share the
 * single sequential lane and its short timeout. The duplex (HTTP/2) transport ignores policies.
 */
export const PACKAGE_RELAY_ROUTE_POLICIES: readonly SandboxCallbackBridgeRoutePolicy[] = [
  {
    path: /^\/api\/package-relay\/gitea\/(?:simple\/[a-z0-9]+(?:-[a-z0-9]+)*\/|files\/[A-Za-z0-9._%+!-]+\/[A-Za-z0-9._%+!-]+\/[A-Za-z0-9._%+!-]+)$/,
    deadlineMs: 65_000,
    maxConcurrent: 4,
  },
  {
    // Git smart-HTTP relay (fetch only): the ref advertisement and the upload-pack request.
    path: /^\/api\/package-relay\/github\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/(?:info\/refs|git-upload-pack)$/,
    deadlineMs: 65_000,
    maxConcurrent: 2,
  },
];

function optInValue(envConfig: Record<string, unknown> | null | undefined): string {
  const raw = envConfig?.[PACKAGE_RELAY_OPT_IN_ENV_KEY];
  const value = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
  return typeof value === "string" ? value : "";
}

export function packageRelayOptedIn(envConfig: Record<string, unknown> | null | undefined, relay: string): boolean {
  return optInValue(envConfig).split(",").some((entry) => entry.trim().toLowerCase() === relay);
}

/** True when the agent opted in to any package relay. */
export function packageRelayAnyOptedIn(envConfig: Record<string, unknown> | null | undefined): boolean {
  return packageRelayOptedIn(envConfig, "gitea") || packageRelayOptedIn(envConfig, "github");
}

/**
 * Env to add to a sandbox run, or an empty object when the agent did not opt in or there is no bridge.
 * `githubRepos` is the server's configured repository list (`PACKAGE_RELAY_GITHUB_REPOS_ENV`).
 */
export function buildPackageRelayEnv(
  envConfig: Record<string, unknown> | null | undefined,
  bridgeEnv: Record<string, string> | null | undefined,
  githubRepos: string | undefined = undefined,
): Record<string, string> {
  const gitea = packageRelayOptedIn(envConfig, "gitea");
  const github = packageRelayOptedIn(envConfig, "github");
  if (!gitea && !github) return {};
  const apiUrl = bridgeEnv?.PAPERCLIP_API_URL;
  const token = bridgeEnv?.PAPERCLIP_API_KEY;
  if (!apiUrl || !token) return {};
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    return {};
  }
  if (base.username || base.password || !/^[A-Za-z0-9_-]+$/.test(token)) return {};
  const out: Record<string, string> = {};
  if (gitea) {
    const index = `${base.protocol}//paperclip:${token}@${base.host}${PACKAGE_RELAY_GITEA_INDEX_PATH}`;
    // uv only. uv looks a package up in the first index that has it, and the relay serves only the private package
    // names, so a same-named package on the public index can never win. pip merges all indexes and takes the highest
    // version, so it is deliberately not configured.
    out.UV_EXTRA_INDEX_URL = index;
  }
  if (github) {
    // One git `insteadOf` rule per configured repository, through git's env config, so no file is written and no other
    // GitHub URL is rewritten. The bridge token is in the key name (git config key), which the log redaction masks by
    // name. The value is a plain GitHub URL.
    const repos = (githubRepos ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (repos.length > 0 && repos.every((r) => GITHUB_REPO_RE.test(r) && !r.endsWith(".git"))) {
      repos.forEach((repo, index) => {
        out[`GIT_CONFIG_KEY_${index}`] = `url.${base.protocol}//paperclip:${token}@${base.host}${PACKAGE_RELAY_GITHUB_PATH}${repo}.insteadOf`;
        out[`GIT_CONFIG_VALUE_${index}`] = `https://github.com/${repo}`;
      });
      out.GIT_CONFIG_COUNT = String(repos.length);
    }
  }
  return out;
}
