/**
 * Operator-triggered assignment of the ACTING board user as the frozen owner of comms-board entries that are stuck at
 * `pending` / `owner_required`.
 *
 * An entry's `ownerUserId` is frozen from the server-side actor when the agent is created. An agent created by another
 * agent, a built-in or a plugin has none, so comms-board setup waits at `owner_required` and retries forever. This
 * route lets a human who is allowed to manage connections take responsibility for named agents.
 *
 * Safety properties:
 *  - the owner is ALWAYS the authenticated caller, never a request value, and must be an ACTIVE member of the company
 *    with a verified email (instance admin is not a bypass); otherwise nothing changes (`owner_ineligible`);
 *  - the agent ids are listed explicitly (1-25), never "every agent in the company";
 *  - an agent is only written when its comms-board entry is still `pending`, still `owner_required` and still has no
 *    owner, enforced in the UPDATE's own WHERE so a concurrent change loses cleanly;
 *  - only `ownerUserId` and the retry schedule (`nextAttemptAt`, `attemptCount`) are written. The existing setup sweep
 *    (every 60s) then performs the registration with the same checks as for any new agent. Nothing is minted, registered
 *    or installed here.
 *
 * The report carries counts and agent ids only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState } from "./default-mcp-spec.js";

export const COMMS_OWNER_ASSIGNMENT_ENTRY_KEY = "comms-board";
export const COMMS_OWNER_ASSIGNMENT_MAX_AGENTS = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_OWNER_ASSIGNMENT_CONFIRMATION = "assign-comms-board-owner";

export type CommsOwnerAssignmentResult =
  | "would_assign"
  | "assigned"
  | "already_has_owner"
  | "skipped_not_owner_required"
  | "skipped_no_entry"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "agent_not_in_company"
  | "owner_ineligible"
  | "assign_error";

const RESULTS: readonly CommsOwnerAssignmentResult[] = [
  "would_assign", "assigned", "already_has_owner", "skipped_not_owner_required", "skipped_no_entry", "skipped_terminated",
  "skipped_company_archived", "agent_not_in_company", "owner_ineligible", "assign_error",
];

export interface CommsOwnerAssignmentOutcome {
  agentId: string;
  result: CommsOwnerAssignmentResult;
}

export interface CommsOwnerAssignmentReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsOwnerAssignmentOutcome[];
  counts: Record<CommsOwnerAssignmentResult, number>;
}

export class CommsOwnerAssignmentConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsOwnerAssignmentInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface CommsOwnerAssignmentOptions {
  companyId: string;
  /** The authenticated board user. Never taken from a request body. */
  ownerUserId: string | null;
  agentIds: string[];
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_OWNER_ASSIGNMENT_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyCounts(): CommsOwnerAssignmentReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsOwnerAssignmentReport["counts"];
}

function entryPath(...rest: string[]) {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_OWNER_ASSIGNMENT_ENTRY_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** The caller must be an active member of THIS company with a verified, non-empty email. */
async function ownerEligible(db: Pick<Db, "select">, companyId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
        eq(authUsers.emailVerified, true),
      ),
    )
    .limit(1);
  return Boolean(row?.email?.trim());
}

export async function assignCommsBoardOwner(db: Db, options: CommsOwnerAssignmentOptions): Promise<CommsOwnerAssignmentReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_OWNER_ASSIGNMENT_CONFIRMATION) throw new CommsOwnerAssignmentConfirmationError();
  const ids = [...new Set(options.agentIds.map((id) => id.toLowerCase()))];
  if (ids.length < 1 || ids.length > COMMS_OWNER_ASSIGNMENT_MAX_AGENTS || !ids.every((id) => UUID.test(id))) {
    throw new CommsOwnerAssignmentInvalidInputError(`agentIds must list between 1 and ${COMMS_OWNER_ASSIGNMENT_MAX_AGENTS} agent UUIDs`);
  }
  const now = options.now?.() ?? new Date();

  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), inArray(agents.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const eligible = await ownerEligible(db, options.companyId, options.ownerUserId);

  const outcomes: CommsOwnerAssignmentOutcome[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    // An id from another company is indistinguishable from an unknown one.
    if (!row) { outcomes.push({ agentId: id, result: "agent_not_in_company" }); continue; }
    if (!eligible) { outcomes.push({ agentId: id, result: "owner_ineligible" }); continue; }
    if (row.status === "terminated") { outcomes.push({ agentId: id, result: "skipped_terminated" }); continue; }
    if (row.companyStatus === "archived") { outcomes.push({ agentId: id, result: "skipped_company_archived" }); continue; }
    const entry = readDefaultMcpState(row.metadata)?.entries[COMMS_OWNER_ASSIGNMENT_ENTRY_KEY];
    if (!entry) { outcomes.push({ agentId: id, result: "skipped_no_entry" }); continue; }
    if (entry.ownerUserId) { outcomes.push({ agentId: id, result: "already_has_owner" }); continue; }
    if (entry.setup.state !== "pending" || entry.setup.reason !== "owner_required") {
      outcomes.push({ agentId: id, result: "skipped_not_owner_required" });
      continue;
    }
    if (dryRun) { outcomes.push({ agentId: id, result: "would_assign" }); continue; }
    try {
      outcomes.push({ agentId: id, result: await assignOne(db, row, options.ownerUserId!, now) });
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token or body.
      logger.warn({ agentId: id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms owner assignment item failed");
      outcomes.push({ agentId: id, result: "assign_error" });
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, scanned: rows.length, outcomes, counts };
}

async function assignOne(
  db: Db,
  row: { id: string; companyId: string },
  ownerUserId: string,
  now: Date,
): Promise<CommsOwnerAssignmentResult> {
  const nowIso = now.toISOString();
  const setupPath = entryPath("setup");
  const patch = { nextAttemptAt: nowIso, attemptCount: 0, updatedAt: nowIso };
  const updated = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath("ownerUserId")}, to_jsonb(${ownerUserId}::text), true), ${setupPath}, (${agents.metadata} #> ${setupPath}) || ${JSON.stringify(patch)}::jsonb, false)`,
    })
    .where(
      and(
        eq(agents.id, row.id),
        eq(agents.companyId, row.companyId),
        // The WHERE restates every precondition, so a concurrent setup run or assignment makes this a no-op.
        sql`${agents.metadata} #>> ${entryPath("setup", "state")} = 'pending'`,
        sql`${agents.metadata} #>> ${entryPath("setup", "reason")} = 'owner_required'`,
        sql`coalesce(jsonb_typeof(${agents.metadata} #> ${entryPath("ownerUserId")}), 'null') = 'null'`,
      ),
    )
    .returning({ id: agents.id });
  if (updated.length !== 1) return "skipped_not_owner_required";
  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "comms-owner-assignment",
    action: "agent.default_mcp.comms_owner_assigned",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only (a user id is not a credential).
    details: { key: COMMS_OWNER_ASSIGNMENT_ENTRY_KEY, ownerUserId },
  });
  return "assigned";
}
