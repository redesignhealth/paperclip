/**
 * Operator-triggered rotation of EXISTING per-agent comms-board credentials onto the current scope set.
 *
 * Agents created before `comms:proposals:write` joined `COMMS_BOARD_TOKEN_SCOPES` hold a token minted with fewer
 * scopes, and minting is skipped once a binding exists. The scopes of an opaque token cannot be read back, so the
 * binding records `commsScopeVersion` (the `COMMS_BOARD_TOKEN_SCOPES_VERSION` it was minted or rotated with). A
 * binding with no marker or an older one needs rescoping.
 *
 * Per eligible agent (ready, dedicated comms-board entry with a bound connection + managed secret), a real run:
 *  1. checks the local wiring is intact (never rotates into a broken connection);
 *  2. calls the ownership API rotate for the agent's base sub with exactly the current scopes (one call, no retry);
 *  3. writes the new token as a NEW VERSION of the agent's existing managed secret (the connection references it
 *     with `version: "latest"`, so nothing else changes);
 *  4. verifies the connection wiring and that `latest` is the new token;
 *  5. only then records the new marker (and the new expiry) and clears any failure marker.
 * If 3-5 fail after a token was minted, a visible `binding.rescope` failure marker is recorded (the old token keeps
 * working, the marker version is NOT advanced) so a re-run rotates again. Re-running changes nothing for agents
 * already at the current version. The old token stays valid until its own expiry (registry behaviour).
 *
 * The report carries counts and agent ids only. No token, secret value, secret id, vault key, bearer or URL is ever
 * returned, logged or written to the activity log. No environment is read here: the ownership credential comes from
 * the boot-captured snapshot through `resolveCommsBoardProvisionerConfig`.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  COMMS_BOARD_TOKEN_SCOPES_VERSION,
  resolveCommsBoardProvisionerConfig,
  rotateCommsBoardCredential,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import { commsWiringIntact } from "./default-mcp-setup.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState, type DefaultMcpEntryState } from "./default-mcp-spec.js";
import { secretService } from "./secrets.js";

export const COMMS_RESCOPE_ENTRY_KEY = "comms-board";
export const COMMS_RESCOPE_BATCH_LIMIT = 25;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_RESCOPE_CONFIRMATION = "rotate-comms-board-credentials";

export type CommsRescopeResult =
  | "would_rescope"
  | "rescoped"
  | "already_current"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "skipped_no_entry"
  | "skipped_not_ready"
  | "skipped_not_dedicated"
  | "skipped_wiring_invalid"
  | "provisioner_not_configured"
  | "provisioner_config_invalid"
  | "rotate_unknown_sub"
  | "rotate_deactivated"
  | "rotate_rejected"
  | "rotate_failed"
  | "secret_write_failed"
  | "verify_failed"
  | "marker_write_failed"
  | "rescope_error";

export interface CommsRescopeOutcome {
  agentId: string;
  companyId: string;
  result: CommsRescopeResult;
}

export interface CommsRescopeReport {
  dryRun: boolean;
  /** The scope-set version a rescoped agent ends at. */
  targetScopeVersion: number;
  scanned: number;
  outcomes: CommsRescopeOutcome[];
  counts: Record<CommsRescopeResult, number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class CommsRescopeConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsRescopeInProgressError extends Error {
  constructor() {
    super("A rescope run is already in progress for this company");
  }
}

export interface CommsRescopeOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_RESCOPE_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const RESULTS: readonly CommsRescopeResult[] = [
  "would_rescope", "rescoped", "already_current", "skipped_terminated", "skipped_company_archived", "skipped_no_entry",
  "skipped_not_ready", "skipped_not_dedicated", "skipped_wiring_invalid", "provisioner_not_configured",
  "provisioner_config_invalid", "rotate_unknown_sub", "rotate_deactivated", "rotate_rejected", "rotate_failed",
  "secret_write_failed", "verify_failed", "marker_write_failed", "rescope_error",
];

function emptyCounts(): CommsRescopeReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as CommsRescopeReport["counts"];
}

// One real run per company per process at a time; across instances the single-call rotate and the guarded marker
// write keep overlapping runs harmless (the worst case is one extra rotation).
const runningCompanies = new Set<string>();

function bindingPath(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_RESCOPE_ENTRY_KEY, "binding", ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** Guard shared by every write: the entry is still ready and still bound to the same managed secret. */
function stillBound(agentId: string, secretId: string): SQL {
  return and(
    eq(agents.id, agentId),
    sql`${agents.metadata} #>> ${bindingPath("secretId")} = ${secretId}`,
    sql`${agents.metadata} #>> ${sql`ARRAY['defaultMcp','entries','comms-board','setup','state']::text[]`} = 'ready'`,
  )!;
}

function needsRescope(entry: DefaultMcpEntryState): boolean {
  const version = entry.binding?.commsScopeVersion;
  return typeof version !== "number" || version < COMMS_BOARD_TOKEN_SCOPES_VERSION;
}

type Eligibility = { eligible: true; entry: DefaultMcpEntryState } | { eligible: false; result: CommsRescopeResult };

function classify(metadata: unknown): Eligibility {
  const entry = readDefaultMcpState(metadata)?.entries[COMMS_RESCOPE_ENTRY_KEY];
  if (!entry) return { eligible: false, result: "skipped_no_entry" };
  if (entry.setup.state !== "ready") return { eligible: false, result: "skipped_not_ready" };
  if (!entry.dedicated) return { eligible: false, result: "skipped_not_dedicated" };
  const binding = entry.binding;
  if (!binding?.secretId || !binding.connectionId || !binding.grantId || !entry.connectionId) {
    return { eligible: false, result: "skipped_not_ready" };
  }
  if (!needsRescope(entry)) return { eligible: false, result: "already_current" };
  return { eligible: true, entry };
}

export async function rescopeCommsCredentials(db: Db, options: CommsRescopeOptions): Promise<CommsRescopeReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_RESCOPE_CONFIRMATION) throw new CommsRescopeConfirmationError();
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new CommsRescopeInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    return await scan(db, options, dryRun);
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

async function scan(db: Db, options: CommsRescopeOptions, dryRun: boolean): Promise<CommsRescopeReport> {
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_RESCOPE_BATCH_LIMIT, COMMS_RESCOPE_BATCH_LIMIT));
  const rows = await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, status: agents.status, companyStatus: companies.status })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);

  // Fail closed before any per-agent work: no config, no HTTP call (the resolver reads the frozen boot snapshot).
  const resolved = resolveCommsBoardProvisionerConfig(options.env);
  const outcomes: CommsRescopeOutcome[] = [];
  const push = (row: { id: string; companyId: string }, result: CommsRescopeResult) =>
    outcomes.push({ agentId: row.id, companyId: row.companyId, result });

  for (const row of rows) {
    if (row.status === "terminated") { push(row, "skipped_terminated"); continue; }
    if (row.companyStatus === "archived") { push(row, "skipped_company_archived"); continue; }
    const eligibility = classify(row.metadata);
    if (!eligibility.eligible) { push(row, eligibility.result); continue; }
    if (dryRun) { push(row, "would_rescope"); continue; }
    if (!resolved.ok) { push(row, resolved.reason); continue; }
    try {
      push(row, await rescopeOne(db, row, eligibility.entry, resolved.config, options));
    } catch (err) {
      // Only the error class is logged: never a message, URL, header, token or body.
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms credential rescope item failed");
      push(row, "rescope_error");
    }
  }

  const counts = emptyCounts();
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return {
    dryRun,
    targetScopeVersion: COMMS_BOARD_TOKEN_SCOPES_VERSION,
    scanned: rows.length,
    outcomes,
    counts,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

async function markFailed(db: Db, agentId: string, secretId: string, reason: CommsRescopeResult, tokenMinted: boolean, at: Date): Promise<void> {
  const marker = { state: "failed", reason, tokenMinted, at: at.toISOString() };
  try {
    await db
      .update(agents)
      .set({ metadata: sql`jsonb_set(${agents.metadata}, ${bindingPath("rescope")}, ${JSON.stringify(marker)}::jsonb, true)` })
      .where(stillBound(agentId, secretId));
  } catch (err) {
    logger.warn({ agentId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "comms credential rescope failure marker not written");
  }
}

async function rescopeOne(
  db: Db,
  row: { id: string; companyId: string },
  entry: DefaultMcpEntryState,
  config: Parameters<typeof rotateCommsBoardCredential>[0],
  options: CommsRescopeOptions,
): Promise<CommsRescopeResult> {
  const binding = entry.binding!;
  const secretId = binding.secretId!;
  const now = () => options.now?.() ?? new Date();

  // Never rotate into a connection that would not resolve the token afterwards.
  if (!(await commsWiringIntact(db, row.companyId, row.id, entry))) return "skipped_wiring_invalid";

  const rotated = await rotateCommsBoardCredential(config, { baseSub: binding.baseSub }, options.fetchImpl);
  if (!rotated.ok) {
    // Nothing was stored, so there is nothing to mark: the state is unchanged and the operator re-runs.
    return rotated.reason === "invalid_subject" ? "rotate_failed" : rotated.reason;
  }

  // From here a new token exists that only this scope holds. The old secret version is untouched until the write lands.
  const secrets = secretService(db);
  try {
    await secrets.rotate(secretId, { value: rotated.boardToken }, { userId: entry.ownerUserId });
  } catch {
    await markFailed(db, row.id, secretId, "secret_write_failed", true, now());
    return "secret_write_failed";
  }

  let verified = false;
  try {
    const [fresh] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, row.id)).limit(1);
    const freshEntry = readDefaultMcpState(fresh?.metadata)?.entries[COMMS_RESCOPE_ENTRY_KEY];
    verified =
      Boolean(freshEntry) &&
      (await commsWiringIntact(db, row.companyId, row.id, freshEntry!)) &&
      (await secrets.resolveSecretValue(row.companyId, secretId, "latest")) === rotated.boardToken;
  } catch {
    verified = false;
  }
  if (!verified) {
    await markFailed(db, row.id, secretId, "verify_failed", true, now());
    return "verify_failed";
  }

  const updated = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${bindingPath("commsScopeVersion")}, ${String(COMMS_BOARD_TOKEN_SCOPES_VERSION)}::jsonb, true), ${bindingPath("tokenExpiresAt")}, ${JSON.stringify(rotated.tokenExpiresAt)}::jsonb, true) #- ${bindingPath("rescope")}`,
    })
    .where(stillBound(row.id, secretId))
    .returning({ id: agents.id });
  if (updated.length !== 1) return "marker_write_failed";

  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "comms-credential-rescope",
    action: "agent.default_mcp.comms_credential_rescoped",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only.
    details: { key: COMMS_RESCOPE_ENTRY_KEY, fromScopeVersion: binding.commsScopeVersion ?? null, toScopeVersion: COMMS_BOARD_TOKEN_SCOPES_VERSION, connectionId: entry.connectionId },
  });
  return "rescoped";
}
