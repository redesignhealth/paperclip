/**
 * Adds MISSING managed default-MCP entries to agents that already hold a `defaultMcp` state.
 *
 * Legacy enrollment (`default-mcp-legacy-enrollment.ts`) only touches agents with NO `defaultMcp` state; an agent
 * that already has one is skipped. Agents that got a state holding only the `arcana-brain` entry (from the Arcana
 * backfill) therefore never receive a `comms-board` entry: no board identity, no credential, nothing for the sweep to
 * complete. This job closes that gap, operator-triggered and company-scoped.
 *
 * Which entries: every spec entry with a `setupHook` (a managed, per-agent credential) except `arcana-brain`, which has
 * its own backfill and is never added, cleared or rewritten here. Ordinary (non-hook) entries are never added: carrying
 * a legacy install forward is meaningless for an agent that is already snapshot-managed, and adding one could widen access.
 *
 * Per agent it reuses the legacy-enrollment helpers (`resolveLegacyResponsibleUser`, `assessLegacyOrdinaryAccess`
 * conflicts) and builds each entry with `snapshotDefaultMcpForNewAgent` (the same initial pending snapshot form), writes
 * ONLY the missing entry keys by path under a row lock (existing entries are never rewritten), then schedules the same
 * setup run the legacy enrollment schedules, restricted to the entries that were just added. A missing responsible owner
 * is `owner_required` in both a dry and a real run. Idempotent: an agent that has every entry is `nothing_missing`.
 *
 * The report carries counts, agent ids and entry keys only. Gated like the rest of the spec: the framework flag and the
 * frozen company rollout scope.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import type { FetchLike } from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
  type DefaultMcpEntryState,
} from "./default-mcp-spec.js";
import { scheduleDefaultMcpSetup, snapshotDefaultMcpForNewAgent } from "./default-mcp-setup.js";
import { assessLegacyOrdinaryAccess, resolveLegacyResponsibleUser } from "./default-mcp-legacy-enrollment.js";

export const MISSING_ENTRY_BATCH_LIMIT = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const MISSING_ENTRY_CONFIRMATION = "add-missing-default-mcp-entries";
/** Entries owned by another job; never added, cleared or rewritten here. */
const EXCLUDED_ENTRY_KEYS: ReadonlySet<string> = new Set(["arcana-brain"]);

/** The spec entries this job may add: managed (hook) entries minus those owned by another job. */
export function missingEntryEligibleSpec(): readonly DefaultMcpEntrySpec[] {
  return DEFAULT_MCP_SPEC.filter((entry) => entry.setupHook && !EXCLUDED_ENTRY_KEYS.has(entry.key));
}

export type MissingEntrySkipReason =
  | "company_archived"
  | "company_out_of_scope"
  | "agent_terminated"
  | "corrupted_existing_state"
  | "no_default_mcp_state"
  | "nothing_missing"
  | "owner_required"
  | "legacy_access_conflict"
  | "lost_race";

export type MissingEntryOutcome =
  | { agentId: string; companyId: string; result: "would_add"; keys: string[] }
  | { agentId: string; companyId: string; result: "added"; keys: string[] }
  | { agentId: string; companyId: string; result: "failed"; reason: "enrollment_error" }
  | { agentId: string; companyId: string; result: "skipped"; reason: MissingEntrySkipReason };

export interface MissingEntryReport {
  dryRun: boolean;
  /** Set when the framework flag is off: nothing is scanned. */
  blocked: "feature_flag_off" | "enrollment_in_progress" | null;
  scanned: number;
  outcomes: MissingEntryOutcome[];
  counts: Record<MissingEntryOutcome["result"], number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class MissingEntryConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export interface MissingEntryOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `MISSING_ENTRY_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const emptyCounts = (): MissingEntryReport["counts"] => ({ would_add: 0, added: 0, failed: 0, skipped: 0 });

const runningCompanies = new Set<string>();

function entryPath(key: string) {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", key];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** "absent / corrupted / present", the same split legacy enrollment uses (it is not exported there). */
function classifyMetadata(metadata: unknown): "absent" | "corrupted" | "present" {
  if (metadata !== null && metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) return "corrupted";
  if (!metadata || typeof metadata !== "object") return "absent";
  const raw = (metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY];
  if (raw === undefined || raw === null) return "absent";
  return readDefaultMcpState(metadata) !== null ? "present" : "corrupted";
}

/** The spec entries this agent lacks. Judged on the raw key so even a malformed existing entry is never replaced. */
function missingSpecFor(metadata: unknown): DefaultMcpEntrySpec[] {
  const raw = (metadata as { [DEFAULT_MCP_METADATA_KEY]?: { entries?: Record<string, unknown> } }).defaultMcp?.entries ?? {};
  return missingEntryEligibleSpec().filter((entry) => !(entry.key in raw));
}

export async function addMissingDefaultMcpEntries(db: Db, options: MissingEntryOptions): Promise<MissingEntryReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== MISSING_ENTRY_CONFIRMATION) throw new MissingEntryConfirmationError();
  const env = options.env ?? process.env;
  const empty = (blocked: MissingEntryReport["blocked"]): MissingEntryReport => ({
    dryRun,
    blocked,
    scanned: 0,
    outcomes: [],
    counts: emptyCounts(),
    nextCursor: null,
  });
  if (!isDefaultMcpSpecEnabled(env)) return empty("feature_flag_off");
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) return empty("enrollment_in_progress");
    runningCompanies.add(options.companyId);
  }
  try {
    return await scan(db, options, dryRun, env);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function scan(db: Db, options: MissingEntryOptions, dryRun: boolean, env: NodeJS.ProcessEnv): Promise<MissingEntryReport> {
  const limit = Math.max(1, Math.min(options.limit ?? MISSING_ENTRY_BATCH_LIMIT, MISSING_ENTRY_BATCH_LIMIT));
  const scope = readDefaultMcpTemplateScope();
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: MissingEntryOutcome[] = [];
  const skip = (row: { id: string; companyId: string }, reason: MissingEntrySkipReason) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason });

  for (const row of rows) {
    if (row.status === "terminated") { skip(row, "agent_terminated"); continue; }
    if (row.companyStatus === "archived") { skip(row, "company_archived"); continue; }
    if (!isCompanyInDefaultMcpTemplateScope(scope, row.companyId)) { skip(row, "company_out_of_scope"); continue; }
    const classification = classifyMetadata(row.metadata);
    if (classification === "corrupted") { skip(row, "corrupted_existing_state"); continue; }
    if (classification === "absent") { skip(row, "no_default_mcp_state"); continue; } // legacy enrollment's job
    const missing = missingSpecFor(row.metadata);
    if (missing.length === 0) { skip(row, "nothing_missing"); continue; }
    try {
      // Resolved before the dry-run short-circuit so a census and a real run agree.
      const owner = await resolveLegacyResponsibleUser(db, row.companyId, row.id);
      if (!owner) { skip(row, "owner_required"); continue; }
      if ((await assessLegacyOrdinaryAccess(db, row.companyId, row.id)).conflict) { skip(row, "legacy_access_conflict"); continue; }
      const keys = missing.map((entry) => entry.key);
      if (dryRun) {
        outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_add", keys });
        continue;
      }
      const written = await addEntries(db, row, missing, owner.userId, options.now?.() ?? new Date());
      if (written === "lost_race") { skip(row, "lost_race"); continue; }
      if (written === "terminated") { skip(row, "agent_terminated"); continue; }
      // After the write commits; setup makes the external calls and the durable sweep is the backstop. Restricted to
      // the entries just added, so no other entry (notably arcana-brain) is touched by this run.
      scheduleDefaultMcpSetup(db, { companyId: row.companyId, agentId: row.id }, { env, spec: written, fetchImpl: options.fetchImpl, now: options.now });
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "default-mcp-missing-entry-enrollment",
        action: "agent.default_mcp.missing_entries_added",
        entityType: "agent",
        entityId: row.id,
        // Non-secret facts only.
        details: { keys: written.map((entry) => entry.key), ownerUserId: owner.userId },
      });
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "added", keys });
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "missing default MCP entry enrollment failed");
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "failed", reason: "enrollment_error" });
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, blocked: null, scanned: rows.length, outcomes, counts, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

/**
 * Builds the entries with the SAME snapshot builder the new-agent and legacy paths use, but with the metadata write
 * swapped for a no-op (the builder otherwise replaces the whole `defaultMcp` key), then writes only the missing keys.
 */
async function addEntries(
  db: Db,
  row: { id: string; companyId: string },
  missing: DefaultMcpEntrySpec[],
  ownerUserId: string,
  now: Date,
): Promise<DefaultMcpEntrySpec[] | "lost_race" | "terminated"> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: agents.metadata, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId)))
      .limit(1)
      .for("update");
    if (!locked || classifyMetadata(locked.metadata) !== "present") return "lost_race" as const;
    if (locked.status === "terminated") return "terminated" as const;
    // Re-judged under the lock: only keys still absent are written.
    const stillMissing = missing.filter((entry) => missingSpecFor(locked.metadata).some((m) => m.key === entry.key));
    if (stillMissing.length === 0) return "lost_race" as const;
    const noWrite = { set: () => ({ where: async () => [] }) };
    const probe = {
      select: tx.select.bind(tx),
      insert: tx.insert.bind(tx),
      execute: tx.execute.bind(tx),
      update: () => noWrite,
    } as unknown as Parameters<typeof snapshotDefaultMcpForNewAgent>[0];
    const built = await snapshotDefaultMcpForNewAgent(probe, {
      companyId: row.companyId,
      agentId: row.id,
      ownerUserId,
      status: locked.status,
      spec: stillMissing,
      now,
    });
    for (const entry of stillMissing) {
      const state: DefaultMcpEntryState = built.entries[entry.key]!;
      await tx
        .update(agents)
        .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath(entry.key)}, ${JSON.stringify(state)}::jsonb, true)` })
        .where(eq(agents.id, row.id));
    }
    return stillMissing;
  });
}
