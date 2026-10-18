/**
 * Operator-triggered reissue of the comms-board IDENTITY of agents whose setup stopped at `error` / `board_conflict`.
 *
 * Setup registers an agent on the board under `paperclip-agent-<agentId>` and never upserts: when that sub (or the
 * display name, or the sub's base identity) is already taken, the board answers `already_registered`,
 * `display_name_collision` or `identity_fork_detected` and setup stops in the terminal `board_conflict` error. The board
 * and the ownership registry never reuse a registered sub, and the existing registration may belong to something that is
 * still in use, so the fix is to register the agent under a NEW identity and leave the old one alone.
 *
 * A real run bumps the server-owned `identityGeneration` on the comms-board entry (the next registration then uses
 * `paperclip-agent-<agentId>-r<N>` and a display name carrying the same suffix, see `composeCommsBoardIdentity`), clears
 * the failed claim and registration checkpoints, and schedules the entry as `pending` so the existing setup sweep
 * (every 60s) performs the registration with the same checks as for any new agent. Nothing is registered, minted,
 * installed or deleted here.
 *
 * Safety properties:
 *  - the agent ids are listed explicitly (1-25), never "every agent in the company";
 *  - only an entry that is still `error` with reason `board_conflict` is touched. Ready and pending entries, and every
 *    other error reason, are skipped;
 *  - an entry that already holds a board agent id or a managed secret is NEVER reset (`skipped_has_credential`): a
 *    partial registration must not be orphaned;
 *  - the frozen `ownerUserId`, the connection and every other entry on the agent are left as they are;
 *  - each write restates every precondition in its own WHERE, so a concurrent setup run or reissue loses cleanly.
 *
 * The report carries counts, agent ids and the new generation only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { COMMS_BOARD_MAX_IDENTITY_GENERATION } from "./comms-board-provisioner-client.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState } from "./default-mcp-spec.js";

export const COMMS_IDENTITY_REISSUE_ENTRY_KEY = "comms-board";
export const COMMS_IDENTITY_REISSUE_MAX_AGENTS = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_IDENTITY_REISSUE_CONFIRMATION = "reissue-comms-board-identity";

export type CommsIdentityReissueResult =
  | "would_reissue"
  | "reissued"
  | "skipped_not_board_conflict"
  | "skipped_has_credential"
  | "skipped_generation_limit"
  | "skipped_no_entry"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "agent_not_in_company"
  | "reissue_error";

const RESULTS: readonly CommsIdentityReissueResult[] = [
  "would_reissue", "reissued", "skipped_not_board_conflict", "skipped_has_credential", "skipped_generation_limit",
  "skipped_no_entry", "skipped_terminated", "skipped_company_archived", "agent_not_in_company", "reissue_error",
];

export interface CommsIdentityReissueOutcome {
  agentId: string;
  result: CommsIdentityReissueResult;
  /** The generation the entry now has (reissued) or would get (would_reissue). Absent for skips. */
  generation?: number;
}

export interface CommsIdentityReissueReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsIdentityReissueOutcome[];
  counts: Record<CommsIdentityReissueResult, number>;
}

export class CommsIdentityReissueConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsIdentityReissueInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class CommsIdentityReissueInProgressError extends Error {
  constructor() {
    super("An identity reissue run is already in progress for this company");
  }
}

export interface CommsIdentityReissueOptions {
  companyId: string;
  agentIds: string[];
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_IDENTITY_REISSUE_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyCounts(): CommsIdentityReissueReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsIdentityReissueReport["counts"];
}

function entryPath(...rest: string[]) {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_IDENTITY_REISSUE_ENTRY_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

// One real run per company per process at a time; across instances the guarded UPDATE keeps overlapping runs harmless.
const runningCompanies = new Set<string>();

function currentGeneration(entry: { identityGeneration?: number | null }): number {
  return typeof entry.identityGeneration === "number" && Number.isInteger(entry.identityGeneration) && entry.identityGeneration > 0
    ? entry.identityGeneration
    : 0;
}

export async function reissueCommsBoardIdentity(db: Db, options: CommsIdentityReissueOptions): Promise<CommsIdentityReissueReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_IDENTITY_REISSUE_CONFIRMATION) throw new CommsIdentityReissueConfirmationError();
  const ids = [...new Set(options.agentIds.map((id) => id.toLowerCase()))];
  if (ids.length < 1 || ids.length > COMMS_IDENTITY_REISSUE_MAX_AGENTS || !ids.every((id) => UUID.test(id))) {
    throw new CommsIdentityReissueInvalidInputError(`agentIds must list between 1 and ${COMMS_IDENTITY_REISSUE_MAX_AGENTS} agent UUIDs`);
  }
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new CommsIdentityReissueInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    return await run(db, options, ids, dryRun);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function run(db: Db, options: CommsIdentityReissueOptions, ids: string[], dryRun: boolean): Promise<CommsIdentityReissueReport> {
  const now = options.now?.() ?? new Date();
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), inArray(agents.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const outcomes: CommsIdentityReissueOutcome[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    // An id from another company is indistinguishable from an unknown one.
    if (!row) { outcomes.push({ agentId: id, result: "agent_not_in_company" }); continue; }
    if (row.status === "terminated") { outcomes.push({ agentId: id, result: "skipped_terminated" }); continue; }
    if (row.companyStatus === "archived") { outcomes.push({ agentId: id, result: "skipped_company_archived" }); continue; }
    const entry = readDefaultMcpState(row.metadata)?.entries[COMMS_IDENTITY_REISSUE_ENTRY_KEY];
    if (!entry) { outcomes.push({ agentId: id, result: "skipped_no_entry" }); continue; }
    if (entry.setup.state !== "error" || entry.setup.reason !== "board_conflict") {
      outcomes.push({ agentId: id, result: "skipped_not_board_conflict" });
      continue;
    }
    // A board agent id or a managed secret means a registration or mint already happened for this entry.
    if (entry.binding?.boardAgentId || entry.binding?.secretId) {
      outcomes.push({ agentId: id, result: "skipped_has_credential" });
      continue;
    }
    const next = currentGeneration(entry) + 1;
    if (next > COMMS_BOARD_MAX_IDENTITY_GENERATION) { outcomes.push({ agentId: id, result: "skipped_generation_limit" }); continue; }
    if (dryRun) { outcomes.push({ agentId: id, result: "would_reissue", generation: next }); continue; }
    try {
      outcomes.push({ agentId: id, ...(await reissueOne(db, row, currentGeneration(entry), next, now)) });
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token or body.
      logger.warn({ agentId: id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms identity reissue item failed");
      outcomes.push({ agentId: id, result: "reissue_error" });
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, scanned: rows.length, outcomes, counts };
}

async function reissueOne(
  db: Db,
  row: { id: string; companyId: string },
  fromGeneration: number,
  nextGeneration: number,
  now: Date,
): Promise<{ result: CommsIdentityReissueResult; generation?: number }> {
  const nowIso = now.toISOString();
  const setupPath = entryPath("setup");
  // A fresh pending snapshot: no failed reason, no claim, no checkpoints from the failed registration, retry now.
  const setupPatch = {
    state: "pending",
    reason: null,
    attemptCount: 0,
    nextAttemptAt: nowIso,
    leaseUntil: null,
    claimId: null,
    registerAttemptedAt: null,
    mintAttemptedAt: null,
    updatedAt: nowIso,
  };
  const updated = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("identityGeneration")}, to_jsonb(${nextGeneration}::int), true), ${setupPath}, (${agents.metadata} #> ${setupPath}) || ${JSON.stringify(setupPatch)}::jsonb, false), ${entryPath("binding")}, 'null'::jsonb, true)`,
    })
    .where(
      and(
        eq(agents.id, row.id),
        eq(agents.companyId, row.companyId),
        // The WHERE restates every precondition, so a concurrent setup run or reissue makes this a no-op.
        sql`${agents.metadata} #>> ${entryPath("setup", "state")} = 'error'`,
        sql`${agents.metadata} #>> ${entryPath("setup", "reason")} = 'board_conflict'`,
        sql`coalesce((${agents.metadata} #>> ${entryPath("identityGeneration")})::int, 0) = ${fromGeneration}`,
        sql`coalesce(${agents.metadata} #>> ${entryPath("binding", "boardAgentId")}, '') = ''`,
        sql`coalesce(${agents.metadata} #>> ${entryPath("binding", "secretId")}, '') = ''`,
      ),
    )
    .returning({ id: agents.id });
  if (updated.length !== 1) return { result: "skipped_not_board_conflict" };
  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "comms-identity-reissue",
    action: "agent.default_mcp.comms_identity_reissued",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only.
    details: { key: COMMS_IDENTITY_REISSUE_ENTRY_KEY, fromGeneration, toGeneration: nextGeneration },
  });
  return { result: "reissued", generation: nextGeneration };
}
