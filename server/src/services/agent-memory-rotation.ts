import { and, asc, eq, gt, sql } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  resolveCommsBoardProvisionerConfig,
  rotateAgentMemoryCredential,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import {
  AGENT_MEMORY_ENTRY_KEY,
  normalizeIso,
  resolveAgentMemoryConfig,
} from "./default-mcp-agent-memory.js";
import { DEFAULT_MCP_METADATA_KEY, isDefaultMcpSpecEnabled, readDefaultMcpState } from "./default-mcp-spec.js";
import { secretService } from "./secrets.js";

/**
 * Rotation of per-agent memory credentials before they expire (TECH-8409).
 *
 * Memory tokens live 90 days, and the registry never revokes (the old token stays valid until its own expiry), so a
 * rotation is safe to repeat. A pass is cheap and bounded: it finds ready `agent-memory` entries whose recorded
 * `binding.tokenExpiresAt` falls inside the rotation window and, per agent:
 *
 *  1. checks the stored secret is still active (an intentionally revoked secret is never revived);
 *  2. calls the registry rotate for `agent-memory-<agentId>` once (no retry);
 *  3. writes the new token as a NEW VERSION of the agent's secret, guarded by the version read in step 1 (the
 *     agent's env references it with `version: "latest"`, so nothing else changes);
 *  4. only then records the new expiry, guarded on the old one, and clears any failure marker.
 *
 * If 3 or 4 fails after a token was issued, a visible `binding.rotation` failure marker (ids and codes only) is
 * recorded, the old token keeps working, and the next pass rotates again. A concurrent rotation on another instance
 * loses at step 3 (version guard) or step 4 (expiry guard), which is harmless. Nothing here logs, returns or persists
 * a token or secret value. The registry credential comes from the boot-captured snapshot.
 */

export const AGENT_MEMORY_ROTATION_WINDOW_DAYS = 14;
export const AGENT_MEMORY_ROTATION_BATCH_LIMIT = 25;

export type AgentMemoryRotationResult =
  | "rotated"
  | "skipped_not_ready"
  | "skipped_no_expiry"
  | "skipped_secret_unavailable"
  | "rotate_unknown_sub"
  | "rotate_deactivated"
  | "rotate_rejected"
  | "rotate_failed"
  | "secret_write_failed"
  | "marker_write_failed"
  | "rotation_error";

export interface AgentMemoryRotationOutcome {
  agentId: string;
  companyId: string;
  result: AgentMemoryRotationResult;
}

export interface AgentMemoryRotationReport {
  blocked: "feature_flag_off" | "memory_not_configured" | "provisioner_not_configured" | null;
  scanned: number;
  outcomes: AgentMemoryRotationOutcome[];
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export interface AgentMemoryRotationOptions {
  /** Restrict to one company. Default: every company. */
  companyId?: string;
  limit?: number;
  afterId?: string;
  windowDays?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const entryPath = (...rest: string[]) =>
  sql`ARRAY[${sql.join([DEFAULT_MCP_METADATA_KEY, "entries", AGENT_MEMORY_ENTRY_KEY, ...rest].map((part) => sql`${part}::text`), sql`, `)}]`;

export async function rotateAgentMemoryCredentials(db: Db, options: AgentMemoryRotationOptions = {}): Promise<AgentMemoryRotationReport> {
  const env = options.env ?? process.env;
  const empty = (blocked: AgentMemoryRotationReport["blocked"]): AgentMemoryRotationReport => ({ blocked, scanned: 0, outcomes: [], nextCursor: null });
  if (!isDefaultMcpSpecEnabled(env)) return empty("feature_flag_off");
  if (!resolveAgentMemoryConfig(env).ok) return empty("memory_not_configured");
  const provisioner = resolveCommsBoardProvisionerConfig(env);
  if (!provisioner.ok) return empty("provisioner_not_configured");

  const now = options.now?.() ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? AGENT_MEMORY_ROTATION_BATCH_LIMIT, AGENT_MEMORY_ROTATION_BATCH_LIMIT));
  const cutoff = new Date(now.getTime() + (options.windowDays ?? AGENT_MEMORY_ROTATION_WINDOW_DAYS) * 86_400_000).toISOString();
  // Server-written canonical ISO strings compare correctly as text (see `normalizeIso`).
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(
      and(
        options.companyId ? eq(agents.companyId, options.companyId) : undefined,
        options.afterId ? gt(agents.id, options.afterId) : undefined,
        sql`${agents.status} <> 'terminated'`,
        sql`${companies.status} <> 'archived'`,
        sql`${agents.metadata} #>> ${entryPath("setup", "state")} = 'ready'`,
        sql`coalesce(${agents.metadata} #>> ${entryPath("binding", "tokenExpiresAt")}, '') <> ''`,
        sql`(${agents.metadata} #>> ${entryPath("binding", "tokenExpiresAt")}) COLLATE "C" <= ${cutoff}::text COLLATE "C"`,
      ),
    )
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: AgentMemoryRotationOutcome[] = [];
  for (const row of rows) {
    let result: AgentMemoryRotationResult;
    try {
      result = await rotateOne(db, row, provisioner.config, options.fetchImpl, now);
    } catch (err) {
      // Only the error class is logged: never a message, token or secret value.
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "agent memory rotation failed");
      result = "rotation_error";
    }
    outcomes.push({ agentId: row.id, companyId: row.companyId, result });
    if (result === "rotated") {
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "agent-memory-rotation",
        action: "agent.agent_memory.rotated",
        entityType: "agent",
        entityId: row.id,
        // Non-secret facts only.
        details: { key: AGENT_MEMORY_ENTRY_KEY },
      });
    }
  }
  return { blocked: null, scanned: rows.length, outcomes, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

async function rotateOne(
  db: Db,
  row: { id: string; companyId: string; metadata: unknown },
  provisioner: Extract<ReturnType<typeof resolveCommsBoardProvisionerConfig>, { ok: true }>["config"],
  fetchImpl: FetchLike | undefined,
  now: Date,
): Promise<AgentMemoryRotationResult> {
  const entry = readDefaultMcpState(row.metadata)?.entries[AGENT_MEMORY_ENTRY_KEY];
  if (!entry || entry.setup.state !== "ready" || !entry.binding?.secretId) return "skipped_not_ready";
  const oldExpiry = entry.binding.tokenExpiresAt;
  if (!oldExpiry) return "skipped_no_expiry";

  const secrets = secretService(db);
  const secret = await secrets.getById(entry.binding.secretId);
  if (!secret || secret.companyId !== row.companyId || secret.status !== "active" || secret.deletedAt) return "skipped_secret_unavailable";

  const rotated = await rotateAgentMemoryCredential(provisioner, { agentId: row.id }, fetchImpl);
  if (!rotated.ok) {
    return rotated.reason === "rotate_unknown_sub" || rotated.reason === "rotate_deactivated" || rotated.reason === "rotate_rejected"
      ? rotated.reason
      : "rotate_failed";
  }
  const newExpiry = normalizeIso(rotated.tokenExpiresAt);

  try {
    await secrets.rotate(
      secret.id,
      { value: rotated.boardToken, expectedLatestVersion: secret.latestVersion },
      { userId: entry.ownerUserId },
    );
  } catch (err) {
    logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "agent memory token storage failed");
    await markFailure(db, row.id, oldExpiry, "secret_write_failed", now);
    return "secret_write_failed";
  }

  // Guarded on the old expiry, so a rotation another instance already recorded is never overwritten.
  const rows = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("binding", "tokenExpiresAt")}, to_jsonb(${newExpiry}::text), true), ${entryPath("binding", "rotation")}, 'null'::jsonb, true)`,
    })
    .where(and(eq(agents.id, row.id), sql`${agents.metadata} #>> ${entryPath("binding", "tokenExpiresAt")} = ${oldExpiry}`))
    .returning({ id: agents.id });
  if (rows.length !== 1) return "marker_write_failed";
  return "rotated";
}

/** A visible, secret-free failure marker (codes and a timestamp only). The old token keeps working; the next pass retries. */
async function markFailure(db: Db, agentId: string, expectedExpiry: string, reason: string, now: Date) {
  const marker = JSON.stringify({ state: "failed", reason, tokenMinted: true, at: now.toISOString() });
  await db
    .update(agents)
    .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath("binding", "rotation")}, ${marker}::jsonb, true)` })
    .where(and(eq(agents.id, agentId), sql`${agents.metadata} #>> ${entryPath("binding", "tokenExpiresAt")} = ${expectedExpiry}`))
    .catch(() => undefined);
}

/** One bounded pass for the 60-second setup sweep. Errors never escape: the sweep must not die. */
export async function sweepAgentMemoryRotation(
  db: Db,
  ctx: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<number> {
  const report = await rotateAgentMemoryCredentials(db, { env: ctx.env, fetchImpl: ctx.fetchImpl, now: ctx.now });
  return report.outcomes.filter((outcome) => outcome.result === "rotated").length;
}
