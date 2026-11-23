/**
 * Ashby API relay environment for sandboxed agents (TECH-9966).
 *
 * A sandbox pod cannot reach api.ashbyhq.com directly under default-deny egress policies and holds no real Ashby credential.
 * The Paperclip server relays allowed Ashby operations with host-held credentials.
 * This helper builds the pod environment for opted-in agents so that standard Ashby SDKs
 * and tools talk to the local bridge without any real Ashby API key in the pod.
 */

export const ASHBY_RELAY_OPT_IN_ENV_KEY = "PAPERCLIP_ASHBY_RELAY";
export const ASHBY_RELAY_PATH = "/api/ashby-relay";

function parseOptIn(value: unknown): string[] {
  const raw = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
  return typeof raw === "string" ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

export function ashbyRelayOptedIn(envConfig: Record<string, unknown> | null | undefined): boolean {
  const optIns = parseOptIn(envConfig?.[ASHBY_RELAY_OPT_IN_ENV_KEY]);
  return optIns.includes("on") || optIns.includes("true") || optIns.includes("enabled");
}

/**
 * Builds the pod environment for an opted-in agent.
 * Maps ASHBY_API_BASE to the local bridge relay path, and sets ASHBY_API_KEY to the run-bound bridge token
 * so standard Ashby SDKs/scripts in the pod authenticate with the local bridge using Basic auth (apiKey:).
 * No Ashby credential ever touches the pod.
 */
export function buildAshbyRelayEnv(
  envConfig: Record<string, unknown> | null | undefined,
  bridgeEnv: { PAPERCLIP_API_URL?: string; PAPERCLIP_API_KEY?: string } | null | undefined,
): Record<string, string> {
  if (!ashbyRelayOptedIn(envConfig)) return {};
  const apiUrl = bridgeEnv?.PAPERCLIP_API_URL?.trim().replace(/\/+$/, "");
  const token = bridgeEnv?.PAPERCLIP_API_KEY?.trim();
  if (!apiUrl || !token) return {};

  return {
    ASHBY_API_BASE: `${apiUrl}${ASHBY_RELAY_PATH}`,
    ASHBY_API_KEY: token,
  };
}
