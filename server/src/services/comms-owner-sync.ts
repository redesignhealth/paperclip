/**
 * Operator-triggered sync of EXISTING comms-board agents' frozen `ownerUserId` onto the ownership registry's owner.
 *
 * An entry's `ownerUserId` is frozen from the server-side actor when the agent is created. After a human-approved
 * reassignment (agent-comms-approvals `/ownership/reassign`, TECH-7389) the registry and the board's agents row name
 * the new owner and the credential is unchanged, but Paperclip's frozen copy still names the old one. That copy is
 * read when an agent hires another agent (the child inherits it while that user is an active member), when setup is
 * re-run, and when a credential is rotated. This job makes Paperclip follow the registry.
 *
 * The registry is the authority and is the only source of the new owner: nothing in the request names a user, so an
 * operator cannot use this route to choose an owner. Per eligible agent (ready, dedicated comms-board entry with a bound
 * managed secret and a base sub), a run:
 *  1. reads the registry owner of the base sub (`GET /ownership/{sub}`, needs `ownership:read`); an inactive or unknown
 *     sub, a rejected token or a failed read changes nothing;
 *  2. does nothing when the stored owner already has that email (case-insensitive);
 *  3. resolves the registry email to exactly ONE user of this company with a verified email and an ACTIVE membership
 *     (none or several change nothing: the new owner must already be onboarded here);
 *  4. on a real run, writes `ownerUserId` ONLY while the entry is still ready, still bound to the same managed secret
 *     and still holds the owner that was read, so a concurrent reissue, rebinding or sync loses cleanly.
 * A census (the default) makes the same reads and writes nothing. Only the stored owner id changes; the secret,
 * connection, scopes and expiry are untouched.
 *
 * The report carries counts, agent ids and registry subs only. No email, token, secret id, URL or body is returned,
 * logged or written to the activity log.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  readCommsBoardOwnership,
  resolveCommsBoardProvisionerConfig,
  type CommsBoardProvisionerConfig,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState, type DefaultMcpEntryState } from "./default-mcp-spec.js";

export const COMMS_OWNER_SYNC_ENTRY_KEY = "comms-board";
export const COMMS_OWNER_SYNC_BATCH_LIMIT = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_OWNER_SYNC_CONFIRMATION = "sync-comms-board-owner";

export type CommsOwnerSyncResult =
  | "would_sync"
  | "synced"
  | "already_current"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "skipped_no_entry"
  | "skipped_not_ready"
  | "skipped_not_dedicated"
  | "provisioner_not_configured"
  | "provisioner_config_invalid"
  | "registry_sub_unknown"
  | "registry_sub_inactive"
  | "registry_rejected"
  | "registry_failed"
  | "registry_owner_not_member"
  | "registry_owner_ambiguous"
  | "lost_race"
  | "sync_error";

const RESULTS: readonly CommsOwnerSyncResult[] = [
  "would_sync", "synced", "already_current", "skipped_terminated", "skipped_company_archived", "skipped_no_entry",
  "skipped_not_ready", "skipped_not_dedicated", "provisioner_not_configured", "provisioner_config_invalid",
  "registry_sub_unknown", "registry_sub_inactive", "registry_rejected", "registry_failed", "registry_owner_not_member",
  "registry_owner_ambiguous", "lost_race", "sync_error",
];

export interface CommsOwnerSyncOutcome {
  agentId: string;
  companyId: string;
  result: CommsOwnerSyncResult;
  /** The registry sub that was read (not a secret). Absent when the entry was never eligible. */
  registrySub?: string;
}

export interface CommsOwnerSyncReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsOwnerSyncOutcome[];
  counts: Record<CommsOwnerSyncResult, number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class CommsOwnerSyncConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsOwnerSyncInProgressError extends Error {
  constructor() {
    super("An owner sync run is already in progress for this company");
  }
}

export interface CommsOwnerSyncOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_OWNER_SYNC_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

function emptyCounts(): CommsOwnerSyncReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsOwnerSyncReport["counts"];
}

// One real run per company per process at a time; the guarded compare-and-set keeps overlapping runs across
// instances harmless.
const runningCompanies = new Set<string>();

function entryPath(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_OWNER_SYNC_ENTRY_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

type Eligibility =
  | { eligible: true; entry: DefaultMcpEntryState; baseSub: string; secretId: string }
  | { eligible: false; result: CommsOwnerSyncResult };

function classify(metadata: unknown): Eligibility {
  const entry = readDefaultMcpState(metadata)?.entries[COMMS_OWNER_SYNC_ENTRY_KEY];
  if (!entry) return { eligible: false, result: "skipped_no_entry" };
  if (entry.setup.state !== "ready") return { eligible: false, result: "skipped_not_ready" };
  if (!entry.dedicated) return { eligible: false, result: "skipped_not_dedicated" };
  const binding = entry.binding;
  if (!binding?.secretId || !binding.baseSub) return { eligible: false, result: "skipped_not_ready" };
  return { eligible: true, entry, baseSub: binding.baseSub, secretId: binding.secretId };
}

const normalizeEmail = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();

export async function syncCommsOwner(db: Db, options: CommsOwnerSyncOptions): Promise<CommsOwnerSyncReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_OWNER_SYNC_CONFIRMATION) throw new CommsOwnerSyncConfirmationError();
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new CommsOwnerSyncInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    return await scan(db, options, dryRun);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function scan(db: Db, options: CommsOwnerSyncOptions, dryRun: boolean): Promise<CommsOwnerSyncReport> {
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_OWNER_SYNC_BATCH_LIMIT, COMMS_OWNER_SYNC_BATCH_LIMIT));
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  // Fail closed before any registry call: no config, no HTTP call (the resolver reads the frozen boot snapshot).
  const resolved = resolveCommsBoardProvisionerConfig(options.env);
  const outcomes: CommsOwnerSyncOutcome[] = [];
  const push = (row: { id: string; companyId: string }, result: CommsOwnerSyncResult, registrySub?: string) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result, ...(registrySub ? { registrySub } : {}) });

  for (const row of rows) {
    if (row.status === "terminated") { push(row, "skipped_terminated"); continue; }
    if (row.companyStatus === "archived") { push(row, "skipped_company_archived"); continue; }
    const eligibility = classify(row.metadata);
    if (!eligibility.eligible) { push(row, eligibility.result); continue; }
    if (!resolved.ok) { push(row, resolved.reason, eligibility.baseSub); continue; }
    try {
      const result = await syncOne(db, row, eligibility, resolved.config, dryRun, options);
      push(row, result, eligibility.baseSub);
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token, email or body.
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms owner sync item failed");
      push(row, "sync_error", eligibility.baseSub);
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return { dryRun, scanned: rows.length, outcomes, counts, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

/** The user(s) of THIS company with this email (case-insensitive), a verified email and an active membership. */
async function memberUsersByEmail(db: Db, companyId: string, emailNorm: string): Promise<string[]> {
  const found = await db
    .select({ userId: authUsers.id })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(authUsers.emailVerified, true),
        sql`lower(trim(${authUsers.email})) = ${emailNorm}`,
      ),
    );
  return [...new Set(found.map((row) => row.userId))];
}

async function syncOne(
  db: Db,
  row: { id: string; companyId: string },
  eligibility: Extract<Eligibility, { eligible: true }>,
  config: CommsBoardProvisionerConfig,
  dryRun: boolean,
  options: CommsOwnerSyncOptions,
): Promise<CommsOwnerSyncResult> {
  const registry = await readCommsBoardOwnership(config, { baseSub: eligibility.baseSub }, options.fetchImpl);
  if (!registry.ok) {
    if (registry.reason === "invalid_subject") return "registry_failed";
    return registry.reason;
  }
  if (!registry.active) return "registry_sub_inactive";

  const registryEmail = normalizeEmail(registry.ownerEmail);
  const currentOwnerId = eligibility.entry.ownerUserId ?? null;
  if (currentOwnerId) {
    const [current] = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, currentOwnerId)).limit(1);
    if (normalizeEmail(current?.email) === registryEmail) return "already_current";
  }

  const candidates = await memberUsersByEmail(db, row.companyId, registryEmail);
  if (candidates.length === 0) return "registry_owner_not_member";
  if (candidates.length > 1) return "registry_owner_ambiguous";
  const newOwnerId = candidates[0]!;
  if (newOwnerId === currentOwnerId) return "already_current";
  if (dryRun) return "would_sync";

  const updated = await db
    .update(agents)
    .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath("ownerUserId")}, to_jsonb(${newOwnerId}::text), true)` })
    .where(
      and(
        eq(agents.id, row.id),
        eq(agents.companyId, row.companyId),
        // The WHERE restates every precondition, so a concurrent reissue, rebinding or sync makes this a no-op.
        sql`${agents.metadata} #>> ${entryPath("setup", "state")} = 'ready'`,
        sql`${agents.metadata} #>> ${entryPath("binding", "secretId")} = ${eligibility.secretId}`,
        sql`coalesce(${agents.metadata} #>> ${entryPath("ownerUserId")}, '') = ${currentOwnerId ?? ""}`,
      ),
    )
    .returning({ id: agents.id });
  if (updated.length !== 1) return "lost_race";

  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "comms-owner-sync",
    action: "agent.default_mcp.comms_owner_synced",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only (a user id is not a credential). `fromUserId` allows a reverse correction.
    details: { key: COMMS_OWNER_SYNC_ENTRY_KEY, fromUserId: currentOwnerId, toUserId: newOwnerId },
  });
  return "synced";
}
