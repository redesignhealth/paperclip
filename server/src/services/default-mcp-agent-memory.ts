import { and, eq } from "drizzle-orm";
import { agents, companySecrets, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isUnreachableTailnetPort } from "./remote-http-fetch.js";
import { HERMES_ADAPTER_TYPE } from "./company-memory-constants.js";
import { composeAgentMemorySub, mintAgentMemoryCredential, resolveCommsBoardProvisionerConfig } from "./comms-board-provisioner-client.js";
import { agentService } from "./agents.js";
import { ownerEmailFor } from "./default-mcp-owner.js";
import type { DefaultMcpSetupHook } from "./default-mcp-setup.js";
import { secretService } from "./secrets.js";

/**
 * Per-agent memory default for new Hermes agents (TECH-8409).
 *
 * The memory service lives outside Paperclip. This hook only provisions generic config: it mints an
 * `agent-memory-<agentId>` token through the ownership registry (the same path the comms hook uses), stores it as a
 * company secret, and attaches the Hermes mem0 self-hosted settings to the agent's adapterConfig:
 *
 *   env.MEM0_API_KEY  secret reference to the stored token (never the value)
 *   env.MEM0_HOST     PAPERCLIP_AGENT_MEMORY_URL
 *   env.MEM0_PROXY    PAPERCLIP_AGENT_MEMORY_PROXY (optional)
 *   env.MEM0_USER_ID  the agent id
 *   memoryProvider    "mem0"
 *   runtimeMemory     false (no agent has both the in-process mem0 route and this one)
 *
 * Disabled unless `PAPERCLIP_AGENT_MEMORY_ENABLED=true` and a valid `PAPERCLIP_AGENT_MEMORY_URL` is set.
 *
 * Retry safety, in the same order as the comms hook: every check that can fail without cost runs BEFORE the mint; a
 * mint checkpoint without a stored secret means the outcome is unknown and is terminal (never re-minted); the token
 * is stored as a secret before anything else, and the adapterConfig stage is a local, idempotent transaction that is
 * retried without repeating any external call. Tokens are never logged or persisted outside the secret store.
 */

export const AGENT_MEMORY_ENTRY_KEY = "agent-memory";
export const AGENT_MEMORY_ENABLED_ENV = "PAPERCLIP_AGENT_MEMORY_ENABLED";
export const AGENT_MEMORY_URL_ENV = "PAPERCLIP_AGENT_MEMORY_URL";
export const AGENT_MEMORY_PROXY_ENV = "PAPERCLIP_AGENT_MEMORY_PROXY";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface AgentMemoryConfig {
  /** `MEM0_HOST`, without a trailing slash. */
  url: string;
  /** `MEM0_PROXY`, or null when no proxy is configured. */
  proxy: string | null;
}

export type AgentMemoryConfigResult =
  | { ok: true; config: AgentMemoryConfig }
  | { ok: false; reason: "provisioner_not_configured" | "provisioner_config_invalid" };

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Absolute https URL (any host, including a tailnet), or http for loopback only. No userinfo, query or fragment. */
function validMemoryUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return !isUnreachableTailnetPort(url);
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/** Proxy URL: http(s) or socks5 with a host and optional port. No credentials, path, query or fragment. */
function validProxyUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return false;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
  return url.pathname === "" || url.pathname === "/";
}

/**
 * Closed-enum outcome, decided before any call. Not enabled or no URL is "not configured" (a wait); a malformed URL or
 * proxy is "config invalid". Values are read from the given env and trimmed; nothing here is secret.
 */
export function resolveAgentMemoryConfig(env: NodeJS.ProcessEnv = process.env): AgentMemoryConfigResult {
  if (env[AGENT_MEMORY_ENABLED_ENV]?.trim().toLowerCase() !== "true") return { ok: false, reason: "provisioner_not_configured" };
  const url = env[AGENT_MEMORY_URL_ENV]?.trim();
  if (!url) return { ok: false, reason: "provisioner_not_configured" };
  if (!validMemoryUrl(url)) return { ok: false, reason: "provisioner_config_invalid" };
  const proxy = env[AGENT_MEMORY_PROXY_ENV]?.trim() || null;
  if (proxy && !validProxyUrl(proxy)) return { ok: false, reason: "provisioner_config_invalid" };
  return { ok: true, config: { url: url.replace(/\/+$/, ""), proxy: proxy ? proxy.replace(/\/+$/, "") : null } };
}

/** Whether a NEW agent of this adapter type gets the memory entry at creation (enabled and valid config, Hermes local). */
export function agentMemoryEligibleForNewAgent(adapterType: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return adapterType === HERMES_ADAPTER_TYPE && resolveAgentMemoryConfig(env).ok;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The local, idempotent stage: read the agent's adapterConfig, merge the memory settings into `env` (every other key
 * is kept), set `memoryProvider` and `runtimeMemory: false`, and write it back through the agent lifecycle module's
 * configuration update (the only owner of adapterConfig writes). That update normalizes the env, records a config
 * revision and syncs the agent's secret bindings, which the `MEM0_API_KEY` reference needs to resolve at run time.
 * Replaying it writes the same values. Returns false when the agent is not a Hermes local agent (nothing is written).
 */
export async function applyAgentMemoryAdapterConfig(
  db: Db,
  input: { companyId: string; agentId: string; secretId: string; config: AgentMemoryConfig },
): Promise<boolean> {
  const svc = agentService(db);
  const row = await svc.getById(input.agentId);
  if (!row || row.companyId !== input.companyId || row.adapterType !== HERMES_ADAPTER_TYPE) return false;
  const current = asRecord(row.adapterConfig);
  const env: Record<string, unknown> = {
    ...asRecord(current.env),
    MEM0_API_KEY: { type: "secret_ref", secretId: input.secretId, version: "latest" },
    MEM0_HOST: { type: "plain", value: input.config.url },
    MEM0_USER_ID: { type: "plain", value: input.agentId },
  };
  if (input.config.proxy) env.MEM0_PROXY = { type: "plain", value: input.config.proxy };
  else delete env.MEM0_PROXY;
  const updated = await svc.update(
    input.agentId,
    { adapterConfig: { ...current, env, memoryProvider: "mem0", runtimeMemory: false } },
    { recordRevision: { source: "default_mcp_agent_memory" } },
  );
  return updated !== null;
}

export const agentMemoryHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  let binding = current.binding;

  if (!binding?.secretId && current.setup.mintAttemptedAt) {
    // A checkpoint without its result means a previous attempt's mint outcome is unknown. Terminal, never re-minted.
    return { kind: "error", reason: "mint_unknown" };
  }

  // Everything that can be missing is checked BEFORE any external call, so waiting never leaves an orphan.
  const resolvedMemory = resolveAgentMemoryConfig(input.env);
  if (!resolvedMemory.ok) return { kind: "waiting", reason: resolvedMemory.reason };
  const memoryConfig = resolvedMemory.config;

  const [agentRow] = await db
    .select({ adapterType: agents.adapterType })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  if (!agentRow || agentRow.adapterType !== HERMES_ADAPTER_TYPE) return { kind: "error", reason: "adapter_unsupported" };

  if (!binding?.secretId) {
    const ownerEmail = current.ownerUserId ? await ownerEmailFor(db, companyId, current.ownerUserId) : null;
    if (!ownerEmail) return { kind: "waiting", reason: "owner_required" };
    const provisioner = resolveCommsBoardProvisionerConfig(input.env);
    if (!provisioner.ok) return { kind: "waiting", reason: provisioner.reason };

    await input.checkpoint({ mintAttemptedAt: new Date().toISOString() });
    const minted = await mintAgentMemoryCredential(provisioner.config, { agentId, ownerEmail }, input.fetchImpl);
    if (!minted.ok) return { kind: "error", reason: minted.reason };

    let secretId: string;
    try {
      // A crash or restarted setup can leave this agent's own secret behind. `getByKey` hides soft-deleted rows, so look
      // at every row for the key: an active one is rotated to the token just minted; one that is not active was revoked
      // on purpose and is never revived.
      const secretKey = `agent_memory.${agentId}`;
      const rows = await db
        .select({ id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt, latestVersion: companySecrets.latestVersion })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)));
      if (rows.length > 1) return { kind: "error", reason: "secret_unavailable" };
      const existing = rows[0];
      if (existing) {
        if (existing.status !== "active" || existing.deletedAt) return { kind: "error", reason: "secret_unavailable" };
        await secretService(db).rotate(
          existing.id,
          { value: minted.boardToken, expectedLatestVersion: existing.latestVersion },
          { userId: current.ownerUserId },
        );
        secretId = existing.id;
      } else {
        const secret = await secretService(db).create(
          companyId,
          {
            name: `Agent memory token (agent ${agentId})`,
            key: secretKey,
            provider: "local_encrypted",
            value: minted.boardToken,
            description: `Managed memory service token for agent ${agentId}. Provisioned at agent creation.`,
          },
          { userId: current.ownerUserId },
        );
        secretId = secret.id;
      }
    } catch (err) {
      // The token cannot be fetched again. Only the error class is logged: never a message, key or value.
      logger.warn(
        { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "agent memory token storage failed",
      );
      return { kind: "error", reason: "secret_store_failed" };
    }
    binding = {
      boardAgentId: null,
      baseSub: composeAgentMemorySub(agentId) ?? `agent-memory-${agentId.toLowerCase()}`,
      agentKey: null,
      boardSub: null,
      secretId,
      secretVersion: "latest",
      connectionId: null,
      grantId: null,
      tokenExpiresAt: minted.tokenExpiresAt,
    };
    await input.checkpoint({ binding });
  }

  // A deleted or disabled secret is an intentionally revoked credential: never re-minted or recreated.
  const [secretRow] = await db
    .select({ status: companySecrets.status, deletedAt: companySecrets.deletedAt })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, binding.secretId!)))
    .limit(1);
  if (!secretRow || secretRow.status !== "active" || secretRow.deletedAt) return { kind: "error", reason: "secret_unavailable" };

  // Token stored: the rest is one local, idempotent, retryable transaction (no external call). Checkpoint errors are
  // raised above, outside this block, so a lost claim is never swallowed here.
  try {
    const applied = await applyAgentMemoryAdapterConfig(db, { companyId, agentId, secretId: binding.secretId!, config: memoryConfig });
    return applied ? { kind: "ready" } : { kind: "error", reason: "adapter_unsupported" };
  } catch (err) {
    logger.warn(
      { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "agent memory adapter config stage failed",
    );
    return { kind: "retry", reason: "binding_failed" };
  }
};
