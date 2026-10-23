/**
 * Operator-triggered sync of EXISTING comms-board agents' `is_shared` onto their company's visibility.
 *
 * Registration reads the company's `visibility` once and sends `is_shared` (`shared` => true; private or unclassified
 * => false). The board freezes that value at first registration, so classifying a company later (see
 * `company-visibility-backfill.ts`) does not change agents that already registered. `comms_set_agent_shared` is the
 * board's one supported correction. This job applies it per agent, using the same admin credential and MCP handshake as
 * registration, and records the value it wrote in `binding.commsSharedSynced` so a re-run makes no call for an agent that
 * is already current. Registration does not record the marker, so an agent's first sync makes one call that matches what
 * registration already told the board (a no-op there) and records it.
 *
 * Per eligible agent (not terminated, company not archived, comms-board entry ready, dedicated, bound, with a board agent
 * id, wiring intact): target = `company.visibility === "shared"`. A real run makes ONE `comms_set_agent_shared` call (no
 * retry; setting a boolean is idempotent so re-running is the retry) and only then records the marker, guarded on the entry
 * still being ready and bound to the same managed secret. A NULL visibility targets private and is flagged in the outcome.
 *
 * The report carries counts and agent ids only. No token, secret id, URL or board id is returned or logged.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { resolveCommsBoardProvisionerConfig, setCommsBoardAgentShared, type FetchLike } from "./comms-board-provisioner-client.js";
import { commsWiringIntact, isCompanyVisibilityShared } from "./default-mcp-setup.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState, type DefaultMcpEntryState } from "./default-mcp-spec.js";

export const COMMS_SHARED_SYNC_ENTRY_KEY = "comms-board";
export const COMMS_SHARED_SYNC_BATCH_LIMIT = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_SHARED_SYNC_CONFIRMATION = "sync-comms-board-shared";

export type CommsSharedSyncResult =
  | "would_sync"
  | "synced"
  | "already_current"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "skipped_no_entry"
  | "skipped_not_ready"
  | "skipped_not_dedicated"
  | "skipped_wiring_invalid"
  | "provisioner_not_configured"
  | "provisioner_config_invalid"
  | "set_shared_unknown_agent"
  | "set_shared_rejected"
  | "set_shared_failed"
  | "marker_write_failed"
  | "sync_error";

const RESULTS: readonly CommsSharedSyncResult[] = [
  "would_sync", "synced", "already_current", "skipped_terminated", "skipped_company_archived", "skipped_no_entry",
  "skipped_not_ready", "skipped_not_dedicated", "skipped_wiring_invalid", "provisioner_not_configured",
  "provisioner_config_invalid", "set_shared_unknown_agent", "set_shared_rejected", "set_shared_failed",
  "marker_write_failed", "sync_error",
];

export interface CommsSharedSyncOutcome {
  agentId: string;
  companyId: string;
  result: CommsSharedSyncResult;
  /** The value this agent is (or, on a dry run, would be) set to. Present for would_sync/synced/already_current. */
  target?: boolean;
  /** True when the company's visibility is NULL, so the target is private by the unclassified rule. */
  visibilityUnset?: true;
}

export interface CommsSharedSyncReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsSharedSyncOutcome[];
  counts: Record<CommsSharedSyncResult, number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class CommsSharedSyncConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsSharedSyncInProgressError extends Error {
  constructor() {
    super("A shared sync run is already in progress for this company");
  }
}

export interface CommsSharedSyncOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_SHARED_SYNC_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

function emptyCounts(): CommsSharedSyncReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsSharedSyncReport["counts"];
}

// One real run per company per process at a time; the idempotent board call and the guarded marker write keep
// overlapping runs across instances harmless.
const runningCompanies = new Set<string>();

function bindingPath(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_SHARED_SYNC_ENTRY_KEY, "binding", ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** Guard for the marker write: the entry is still ready and still bound to the same managed secret. */
function stillBound(agentId: string, secretId: string): SQL {
  return and(
    eq(agents.id, agentId),
    sql`${agents.metadata} #>> ${bindingPath("secretId")} = ${secretId}`,
    sql`${agents.metadata} #>> ${sql`ARRAY['defaultMcp','entries','comms-board','setup','state']::text[]`} = 'ready'`,
  )!;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Eligibility = { eligible: true; entry: DefaultMcpEntryState } | { eligible: false; result: CommsSharedSyncResult };

function classify(metadata: unknown): Eligibility {
  const entry = readDefaultMcpState(metadata)?.entries[COMMS_SHARED_SYNC_ENTRY_KEY];
  if (!entry) return { eligible: false, result: "skipped_no_entry" };
  if (entry.setup.state !== "ready") return { eligible: false, result: "skipped_not_ready" };
  if (!entry.dedicated) return { eligible: false, result: "skipped_not_dedicated" };
  const binding = entry.binding;
  if (!binding?.secretId || !binding.connectionId || !binding.grantId || !entry.connectionId) {
    return { eligible: false, result: "skipped_not_ready" };
  }
  if (!binding.boardAgentId || !UUID.test(binding.boardAgentId)) return { eligible: false, result: "skipped_not_ready" };
  return { eligible: true, entry };
}

export async function syncCommsShared(db: Db, options: CommsSharedSyncOptions): Promise<CommsSharedSyncReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_SHARED_SYNC_CONFIRMATION) throw new CommsSharedSyncConfirmationError();
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new CommsSharedSyncInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    return await scan(db, options, dryRun);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function scan(db: Db, options: CommsSharedSyncOptions, dryRun: boolean): Promise<CommsSharedSyncReport> {
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_SHARED_SYNC_BATCH_LIMIT, COMMS_SHARED_SYNC_BATCH_LIMIT));
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      metadata: agents.metadata,
      status: agents.status,
      companyStatus: companies.status,
      visibility: companies.visibility,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  // Fail closed before any per-agent board call: no config, no HTTP call (the resolver reads the frozen boot snapshot).
  const resolved = resolveCommsBoardProvisionerConfig(options.env);
  const outcomes: CommsSharedSyncOutcome[] = [];
  const push = (row: { id: string; companyId: string }, result: CommsSharedSyncResult, extra: Partial<CommsSharedSyncOutcome> = {}) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result, ...extra });

  for (const row of rows) {
    if (row.status === "terminated") { push(row, "skipped_terminated"); continue; }
    if (row.companyStatus === "archived") { push(row, "skipped_company_archived"); continue; }
    const eligibility = classify(row.metadata);
    if (!eligibility.eligible) { push(row, eligibility.result); continue; }
    const entry = eligibility.entry;
    const target = isCompanyVisibilityShared((row.visibility ?? null) as "private" | "shared" | null);
    const extra: Partial<CommsSharedSyncOutcome> = { target, ...(row.visibility == null ? { visibilityUnset: true as const } : {}) };
    if (entry.binding?.commsSharedSynced === target) { push(row, "already_current", extra); continue; }
    if (dryRun) { push(row, "would_sync", extra); continue; }
    if (!resolved.ok) { push(row, resolved.reason); continue; }
    try {
      const result = await syncOne(db, row, entry, target, resolved.config, options);
      push(row, result, result === "synced" ? extra : {});
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token or body.
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms shared sync item failed");
      push(row, "sync_error");
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, scanned: rows.length, outcomes, counts, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

async function syncOne(
  db: Db,
  row: { id: string; companyId: string },
  entry: DefaultMcpEntryState,
  target: boolean,
  config: Parameters<typeof setCommsBoardAgentShared>[0],
  options: CommsSharedSyncOptions,
): Promise<CommsSharedSyncResult> {
  const binding = entry.binding!;
  // Never touch the board for a connection whose local wiring would not resolve afterwards.
  if (!(await commsWiringIntact(db, row.companyId, row.id, entry))) return "skipped_wiring_invalid";

  const outcome = await setCommsBoardAgentShared(config, { boardAgentId: binding.boardAgentId!, isShared: target }, options.fetchImpl);
  if (!outcome.ok) {
    return outcome.reason === "unknown_agent" ? "set_shared_unknown_agent" : outcome.reason === "rejected" ? "set_shared_rejected" : "set_shared_failed";
  }

  const updated = await db
    .update(agents)
    .set({ metadata: sql`jsonb_set(${agents.metadata}, ${bindingPath("commsSharedSynced")}, ${JSON.stringify(target)}::jsonb, true)` })
    .where(stillBound(row.id, binding.secretId!))
    .returning({ id: agents.id });
  // The board value is already correct; only the marker is missing, so the next run repeats the (idempotent) call.
  if (updated.length !== 1) return "marker_write_failed";

  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "comms-shared-sync",
    action: "agent.default_mcp.comms_shared_synced",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only.
    details: { key: COMMS_SHARED_SYNC_ENTRY_KEY, isShared: target, connectionId: entry.connectionId },
  });
  return "synced";
}
