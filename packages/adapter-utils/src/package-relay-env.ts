/**
 * Package-registry relay environment for sandboxed builder agents (TECH-9786).
 *
 * The pod cannot reach the private package registry and holds no registry credential. The Paperclip server relays
 * read-only package requests (`/api/package-relay/gitea/...`) with its own token. This builds the installer settings
 * that point uv and pip at the in-pod bridge gateway. The only credential in them is the run-scoped bridge token the pod
 * already holds. It applies only to agents that opt in with `PAPERCLIP_PACKAGE_RELAY=gitea` in their adapter env.
 */

export const PACKAGE_RELAY_OPT_IN_ENV_KEY = "PAPERCLIP_PACKAGE_RELAY";
export const PACKAGE_RELAY_GITEA_INDEX_PATH = "/api/package-relay/gitea/simple/";

function optInValue(envConfig: Record<string, unknown> | null | undefined): string {
  const raw = envConfig?.[PACKAGE_RELAY_OPT_IN_ENV_KEY];
  const value = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
  return typeof value === "string" ? value : "";
}

export function packageRelayOptedIn(envConfig: Record<string, unknown> | null | undefined, relay: string): boolean {
  return optInValue(envConfig).split(",").some((entry) => entry.trim().toLowerCase() === relay);
}

/** Env to add to a sandbox run, or an empty object when the agent did not opt in or there is no bridge. */
export function buildPackageRelayEnv(
  envConfig: Record<string, unknown> | null | undefined,
  bridgeEnv: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!packageRelayOptedIn(envConfig, "gitea")) return {};
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
  const index = `${base.protocol}//paperclip:${token}@${base.host}${PACKAGE_RELAY_GITEA_INDEX_PATH}`;
  // The relay index goes first: uv looks a package up in the first index that has it, and the relay serves only the
  // private package names, so everything else still comes from the default index.
  return { UV_EXTRA_INDEX_URL: index, PIP_EXTRA_INDEX_URL: index };
}
