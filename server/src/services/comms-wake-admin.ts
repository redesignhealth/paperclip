/**
 * Operator tools for comms-board wake registrations of EXISTING agents (TECH-9914): enrol, unsubscribe, rotate the signing
 * secret, see status, and clean up when an agent (or company) is deleted. New agents are registered by the setup hook of the
 * `comms-wake` default-MCP entry (comms-wake-registration.ts, TECH-9912); enrolment of an existing agent writes that same
 * entry and runs the same hook, so there is one registration implementation, one retry path (the default-MCP sweep) and one
 * visible state (the entry in the agent's setup state).
 *
 * Every read and write is scoped by company. Secret values live only in the vault and in the one board call that sets them:
 * they are never logged, put in an activity record, a report or an error. Reports carry ids, states and reasons only.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { agents, commsWakeRegistrations, companies, companySecrets, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  removeCommsBoardWakeTarget,
  resolveCommsBoardProvisionerConfig,
  setCommsBoardWakeTarget,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import { COMMS_WAKE_AUTOMATIC_EXCLUDED_ADAPTER_TYPES, COMMS_WAKE_ENTRY_KEY, COMMS_WAKE_SYSTEM_LABEL, buildCommsWakeUrl, generateCommsWakeSecret } from "./comms-wake-registration.js";
import { resolveCommsBoardBinding, runDefaultMcpSetupForAgent } from "./default-mcp-setup.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  readDefaultMcpState,
  type DefaultMcpEntryState,
  type DefaultMcpSetupReason,
} from "./default-mcp-spec.js";
import { readDefaultMcpTemplateScope, type DefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { secretService } from "./secrets.js";
import { tailnetAwareFetch } from "./remote-http-fetch.js";

export const COMMS_WAKE_BATCH_LIMIT = 25;
export const COMMS_WAKE_STATUS_LIMIT = 200;
/** A real enrolment run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_WAKE_ENROL_CONFIRMATION = "enrol-comms-wake-agents";

const SIGNING_SECRET_KEY_PREFIX = "comms_wake.signing_secret.";
const ROTATE_CONFIG_PATH = "comms_wake.rotation";

export interface CommsWakeAdminContext {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export class CommsWakeConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

// One mutating operation per agent per process at a time. The vault compare-and-set and the idempotent board call keep
// overlapping operations across instances harmless for enrolment; rotation and unsubscribe are operator-driven and rare.
const busyAgents = new Set<string>();
async function exclusive<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  if (busyAgents.has(agentId)) throw conflict("Another comms wake operation is already running for this agent");
  busyAgents.add(agentId);
  try {
    return await work();
  } finally {
    busyAgents.delete(agentId);
  }
}

const errorClass = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

function entryPath(...rest: string[]) {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", COMMS_WAKE_ENTRY_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

/** Path-scoped write of `setup.*` of the agent's comms-wake entry, only while its state is one of `fromStates`. */
async function patchWakeSetup(
  db: Db,
  companyId: string,
  agentId: string,
  patch: Record<string, unknown>,
  fromStates: readonly string[],
): Promise<boolean> {
  let expr = sql`${agents.metadata}`;
  for (const [field, value] of Object.entries(patch)) {
    expr = sql`jsonb_set(${expr}, ${entryPath("setup", field)}, ${JSON.stringify(value)}::jsonb, true)`;
  }
  const rows = await db
    .update(agents)
    .set({ metadata: expr })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.companyId, companyId),
        sql`${agents.metadata} #>> ${entryPath("setup", "state")} in (${sql.join(fromStates.map((state) => sql`${state}`), sql`, `)})`,
      ),
    )
    .returning({ id: agents.id });
  return rows.length === 1;
}

async function loadAgentInCompany(db: Db, companyId: string, agentId: string) {
  const [row] = await db
    .select({ id: agents.id, companyId: agents.companyId, name: agents.name, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  if (!row) throw notFound("Agent not found in this company");
  return row;
}

const registrationOf = (db: Db, companyId: string, agentId: string) =>
  db
    .select()
    .from(commsWakeRegistrations)
    .where(and(eq(commsWakeRegistrations.companyId, companyId), eq(commsWakeRegistrations.agentId, agentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type CommsWakeStatus = "registered" | "pending" | "not_enrolled" | "not_eligible";

export interface CommsWakeAgentStatus {
  agentId: string;
  name: string;
  status: CommsWakeStatus;
  /** Why an agent is pending, not enrolled or not eligible. Absent for a registered agent and for one that can be enrolled now. */
  reason?: string;
  boardAgentId?: string;
}

export interface CommsWakeStatusReport {
  companyId: string;
  /** The org setting that registers new agents. Enrolling an existing agent requires it to be on. */
  settingEnabled: boolean;
  scanned: number;
  counts: Record<CommsWakeStatus, number>;
  agents: CommsWakeAgentStatus[];
  /** Pass as `afterId` to resume; null once a page returns fewer rows than `limit`. */
  nextCursor: string | null;
}

function standingOf(
  row: { status: string; metadata: unknown },
  registration: { boardAgentId: string } | undefined,
): Pick<CommsWakeAgentStatus, "status" | "reason" | "boardAgentId"> {
  if (row.status === "terminated") return { status: "not_eligible", reason: "terminated" };
  if (row.status === "pending_approval") return { status: "not_eligible", reason: "awaiting_approval" };
  const entries = readDefaultMcpState(row.metadata)?.entries ?? {};
  const wake = entries[COMMS_WAKE_ENTRY_KEY];
  if (registration && (!wake || wake.setup.state === "ready")) return { status: "registered", boardAgentId: registration.boardAgentId };
  if (wake && (wake.setup.state === "pending" || wake.setup.state === "in_progress" || wake.setup.state === "error")) {
    // A stored registration with an unfinished entry means the board has not been told yet (or not successfully).
    return { status: "pending", reason: wake.setup.reason ?? wake.setup.state, ...(registration ? { boardAgentId: registration.boardAgentId } : {}) };
  }
  const board = entries["comms-board"];
  if (!board || board.setup.state !== "ready") return { status: "not_enrolled", reason: "board_not_ready" };
  return { status: "not_enrolled" };
}

export async function listCommsWakeStatus(
  db: Db,
  options: { companyId: string; limit?: number; afterId?: string },
): Promise<CommsWakeStatusReport> {
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_WAKE_STATUS_LIMIT, COMMS_WAKE_STATUS_LIMIT));
  const [company] = await db
    .select({ enabled: companies.commsBoardWakeEnabled })
    .from(companies)
    .where(eq(companies.id, options.companyId))
    .limit(1);
  if (!company) throw notFound("Company not found");
  const rows = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
    .orderBy(asc(agents.id))
    .limit(limit);
  const registrations = rows.length
    ? await db
        .select({ agentId: commsWakeRegistrations.agentId, boardAgentId: commsWakeRegistrations.boardAgentId })
        .from(commsWakeRegistrations)
        .where(and(eq(commsWakeRegistrations.companyId, options.companyId), inArray(commsWakeRegistrations.agentId, rows.map((row) => row.id))))
    : [];
  const byAgent = new Map(registrations.map((registration) => [registration.agentId, registration]));
  const counts: Record<CommsWakeStatus, number> = { registered: 0, pending: 0, not_enrolled: 0, not_eligible: 0 };
  const out = rows.map((row): CommsWakeAgentStatus => {
    const standing = standingOf(row, byAgent.get(row.id));
    counts[standing.status] += 1;
    return { agentId: row.id, name: row.name, ...standing };
  });
  return {
    companyId: options.companyId,
    settingEnabled: company.enabled === true,
    scanned: rows.length,
    counts,
    agents: out,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

// ---------------------------------------------------------------------------
// Enrol
// ---------------------------------------------------------------------------

export type CommsWakeEnrolResult =
  | "would_enrol"
  | "enrolled"
  | "already_registered"
  /** The run reached the hook but the registration is not finished (the reason says why); the default-MCP sweep retries it. */
  | "pending"
  | "skipped_terminated"
  | "skipped_pending_approval"
  | "skipped_company_archived"
  | "skipped_setting_off"
  | "skipped_board_not_ready"
  | "error";

const ENROL_RESULTS: readonly CommsWakeEnrolResult[] = [
  "would_enrol", "enrolled", "already_registered", "pending", "skipped_terminated", "skipped_pending_approval",
  "skipped_company_archived", "skipped_setting_off", "skipped_board_not_ready", "error",
];

export interface CommsWakeEnrolOutcome {
  agentId: string;
  result: CommsWakeEnrolResult;
  reason?: string;
}

export interface CommsWakeEnrolReport {
  dryRun: boolean;
  scanned: number;
  outcomes: CommsWakeEnrolOutcome[];
  counts: Record<CommsWakeEnrolResult, number>;
  nextCursor: string | null;
}

export interface CommsWakeEnrolOptions {
  companyId: string;
  /** One agent. Omit to take a batch of the company's agents. */
  agentId?: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: reports what would happen and changes nothing. */
  dryRun?: boolean;
  /** Required (exactly `COMMS_WAKE_ENROL_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
}

/**
 * Enrols existing agents, for the company's agents (a batch) or one agent. Per agent, a real run
 *  1. skips the agent unless it is live, its org has the setting on and its own board identity is ready;
 *  2. reports `already_registered` when the registration is stored and the entry finished: nothing is touched;
 *  3. otherwise writes (or resets) the agent's `comms-wake` entry to pending and runs the comms-wake setup hook for that
 *     entry alone: it stores the vault secret and the registration, then tells the board.
 * A run that cannot finish leaves the entry pending with the hook's reason, so the default-MCP sweep completes it later and
 * running the command again is always safe.
 */
export async function enrolCommsWakeAgents(
  db: Db,
  options: CommsWakeEnrolOptions,
  ctx: CommsWakeAdminContext = {},
): Promise<CommsWakeEnrolReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_WAKE_ENROL_CONFIRMATION) throw new CommsWakeConfirmationError();
  const limit = Math.max(1, Math.min(options.limit ?? COMMS_WAKE_BATCH_LIMIT, COMMS_WAKE_BATCH_LIMIT));

  const [company] = await db
    .select({ enabled: companies.commsBoardWakeEnabled, status: companies.status })
    .from(companies)
    .where(eq(companies.id, options.companyId))
    .limit(1);
  if (!company) throw notFound("Company not found");

  const rows = await db
    .select({ id: agents.id, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, options.companyId),
        options.agentId ? eq(agents.id, options.agentId) : undefined,
        !options.agentId && options.afterId ? gt(agents.id, options.afterId) : undefined,
      ),
    )
    .orderBy(asc(agents.id))
    .limit(limit);
  if (options.agentId && rows.length === 0) throw notFound("Agent not found in this company");

  const registrations = rows.length
    ? await db
        .select({ agentId: commsWakeRegistrations.agentId })
        .from(commsWakeRegistrations)
        .where(and(eq(commsWakeRegistrations.companyId, options.companyId), inArray(commsWakeRegistrations.agentId, rows.map((row) => row.id))))
    : [];
  const registered = new Set(registrations.map((registration) => registration.agentId));

  const outcomes: CommsWakeEnrolOutcome[] = [];
  for (const row of rows) {
    const push = (result: CommsWakeEnrolResult, reason?: string) => outcomes.push({ agentId: row.id, result, ...(reason ? { reason } : {}) });
    try {
      if (row.status === "terminated") { push("skipped_terminated"); continue; }
      if (row.status === "pending_approval") { push("skipped_pending_approval"); continue; }
      if (company.status === "archived") { push("skipped_company_archived"); continue; }
      if (company.enabled !== true) { push("skipped_setting_off"); continue; }
      const wake = readDefaultMcpState(row.metadata)?.entries[COMMS_WAKE_ENTRY_KEY];
      if (registered.has(row.id) && (!wake || wake.setup.state === "ready")) { push("already_registered"); continue; }
      const board = await resolveCommsBoardBinding(db, options.companyId, row.id);
      if (!board?.boardAgentId) { push("skipped_board_not_ready"); continue; }
      if (dryRun) { push("would_enrol"); continue; }
      const outcome = await exclusive(row.id, () => enrolOne(db, options.companyId, row.id, registered.has(row.id), ctx));
      push(outcome.result, outcome.reason);
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: errorClass(err) }, "comms wake enrolment item failed");
      push("error", err instanceof Error && "status" in err && (err as { status?: number }).status === 409 ? "operation_in_progress" : "enrol_failed");
    }
  }

  const counts = Object.fromEntries(ENROL_RESULTS.map((result) => [result, 0])) as Record<CommsWakeEnrolResult, number>;
  for (const outcome of outcomes) counts[outcome.result] += 1;
  return {
    dryRun,
    scanned: rows.length,
    outcomes,
    counts,
    nextCursor: !options.agentId && rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

/**
 * Writes the agent's `comms-wake` entry as `pending`, only while the entry is absent (a concurrent writer is never
 * overwritten, and a deliberately unsubscribed `not_required` entry is never touched). The setup hook does the rest.
 */
async function insertPendingCommsWakeEntry(db: Db, companyId: string, agentId: string, ownerUserId: string | null, nowIso: string): Promise<void> {
  const spec = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === COMMS_WAKE_ENTRY_KEY);
  if (!spec) throw new Error("comms-wake spec missing");
  const entry: DefaultMcpEntryState = {
    key: COMMS_WAKE_ENTRY_KEY,
    templateKey: spec.connectionName,
    dedicated: true,
    enabled: false,
    templateConnectionId: null,
    connectionId: null,
    ownerUserId,
    setup: {
      state: "pending",
      reason: null,
      attemptCount: 0,
      nextAttemptAt: null,
      leaseUntil: null,
      claimId: null,
      registerAttemptedAt: null,
      mintAttemptedAt: null,
      updatedAt: nowIso,
    },
    binding: null,
  };
  await db
    .update(agents)
    .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath()}, ${JSON.stringify(entry)}::jsonb, true)` })
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), sql`${agents.metadata} #> ${entryPath()} is null`));
}

export const COMMS_WAKE_BACKFILL_BATCH = 10;

/**
 * Automatic back-fill of EXISTING agents, called by the default-MCP sweep tick before the agent sweep. Per tick it takes at
 * most `COMMS_WAKE_BACKFILL_BATCH` agents that are live, in a non-archived company whose setting is on and in the rollout scope,
 * and not of an adapter type excluded from automatic subscription (`process`), that have a ready `comms-board` entry and NO `comms-wake` entry, and writes the same pending entry the operator enrol writes.
 * The ordinary sweep then claims and runs the comms-wake hook, so the claim, the backoff while the board is down and the
 * visible state are all the existing ones. Selecting only agents with no entry makes it idempotent and starvation-free (an
 * agent leaves the candidate set once it has an entry), and keeps a deliberately unsubscribed agent (`not_required`) excluded.
 * Returns the number of entries written.
 */
export async function backfillCommsWakeEntries(
  db: Db,
  ctx: { now?: () => Date; templateScope?: DefaultMcpTemplateScope; limit?: number } = {},
): Promise<number> {
  const scope = ctx.templateScope ?? readDefaultMcpTemplateScope();
  if (scope.mode === "none") return 0;
  if (scope.mode === "allowlist" && scope.companyIds.length === 0) return 0;
  const scopeSql =
    scope.mode === "allowlist"
      ? sql`and a.company_id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  const entryAt = (...rest: string[]) => sql`a.metadata #> ARRAY[${sql.join([DEFAULT_MCP_METADATA_KEY, "entries", ...rest].map((part) => sql`${part}::text`), sql`, `)}]`;
  const result: unknown = await db.execute(sql`
    select a.id as id, a.company_id as company_id, ${entryAt("comms-board", "ownerUserId")} #>> '{}' as owner_user_id
    from agents a
    join companies c on c.id = a.company_id
    where a.status not in ('pending_approval', 'terminated')
      and c.status <> 'archived'
      and c.comms_board_wake_enabled = true
      and a.adapter_type not in (${sql.join(COMMS_WAKE_AUTOMATIC_EXCLUDED_ADAPTER_TYPES.map((type) => sql`${type}`), sql`, `)})
      ${scopeSql}
      and ${entryAt("comms-board", "setup", "state")} #>> '{}' = 'ready'
      and ${entryAt(COMMS_WAKE_ENTRY_KEY)} is null
    order by a.id
    limit ${Math.max(1, ctx.limit ?? COMMS_WAKE_BACKFILL_BATCH)}
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string; company_id: string; owner_user_id: string | null }>;
  const nowIso = (ctx.now?.() ?? new Date()).toISOString();
  let written = 0;
  for (const row of rows) {
    try {
      await insertPendingCommsWakeEntry(db, row.company_id, row.id, row.owner_user_id ?? null, nowIso);
      written += 1;
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: errorClass(err) }, "comms wake back-fill item failed");
    }
  }
  return written;
}

async function enrolOne(db: Db, companyId: string, agentId: string, hasRegistration: boolean, ctx: CommsWakeAdminContext): Promise<CommsWakeEnrolOutcome> {
  const spec = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === COMMS_WAKE_ENTRY_KEY);
  if (!spec) throw new Error("comms-wake spec missing");
  const nowIso = new Date().toISOString();
  const agent = await loadAgentInCompany(db, companyId, agentId);
  const entries = readDefaultMcpState(agent.metadata)?.entries ?? {};
  const existing = entries[COMMS_WAKE_ENTRY_KEY];

  if (!existing) {
    await insertPendingCommsWakeEntry(db, companyId, agentId, entries["comms-board"]?.ownerUserId ?? null, nowIso);
  } else if (existing.setup.state === "in_progress") {
    return { agentId, result: "pending", reason: "in_progress" };
  } else if (existing.setup.state !== "ready" || !hasRegistration) {
    // An operator run retries now: a backoff or an earlier terminal error does not hold it back. A `ready` entry whose
    // registration is gone is run again too (the sweep never claims a ready entry), so it is rebuilt, not reported done.
    await patchWakeSetup(
      db,
      companyId,
      agentId,
      { state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, updatedAt: nowIso },
      ["pending", "error", "not_required", "ready"],
    );
  }

  await runDefaultMcpSetupForAgent(
    { db, spec: [spec], ...(ctx.env ? { env: ctx.env } : {}), ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) },
    { companyId, agentId },
  );

  const after = readDefaultMcpState((await loadAgentInCompany(db, companyId, agentId)).metadata)?.entries[COMMS_WAKE_ENTRY_KEY];
  if (after?.setup.state === "ready") return { agentId, result: "enrolled" };
  const reason: DefaultMcpSetupReason | string | null = after?.setup.reason ?? null;
  return { agentId, result: after?.setup.state === "error" ? "error" : "pending", reason: reason ?? "not_run" };
}

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

export type CommsWakeUnsubscribeResult =
  | "unsubscribed"
  /** There was no registration; anything left behind (a signing secret, an unfinished entry) was still cleaned up. */
  | "not_registered"
  /** The board refused or could not be reached: NOTHING was changed, the registration stays and the call can be repeated. */
  | "board_remove_failed"
  | "board_not_configured";

export interface CommsWakeUnsubscribeReport {
  agentId: string;
  result: CommsWakeUnsubscribeResult;
  board: "removed" | "absent" | "not_called" | "failed";
  boardReason?: string;
  registration: "removed" | "none" | "kept";
  secret: "removed" | "none" | "failed";
}

/**
 * Removes one agent's wake subscription, in this order: the board address first (a failure stops here and changes nothing, so
 * nothing is orphaned and the call can simply be repeated), then the registration row, then the signing secret. The agent's
 * `comms-wake` entry is set to `not_required` so the default-MCP sweep never registers it again; enrolling it later resets it.
 */
export async function unsubscribeCommsWakeAgent(
  db: Db,
  input: { companyId: string; agentId: string; actorUserId?: string | null },
  ctx: CommsWakeAdminContext = {},
): Promise<CommsWakeUnsubscribeReport> {
  const { companyId, agentId } = input;
  await loadAgentInCompany(db, companyId, agentId);
  return exclusive(agentId, async () => {
    const registration = await registrationOf(db, companyId, agentId);
    const report: CommsWakeUnsubscribeReport = { agentId, result: "not_registered", board: "not_called", registration: "none", secret: "none" };

    if (registration) {
      const provisioner = resolveCommsBoardProvisionerConfig(ctx.env ?? process.env);
      if (!provisioner.ok) return { ...report, result: "board_not_configured", registration: "kept" };
      const outcome = await removeCommsBoardWakeTarget(provisioner.config, { boardAgentId: registration.boardAgentId }, ctx.fetchImpl ?? tailnetAwareFetch);
      if (!outcome.ok) return { ...report, result: "board_remove_failed", board: "failed", boardReason: outcome.reason, registration: "kept" };
      report.board = outcome.removed === false ? "absent" : "removed";
      await db.delete(commsWakeRegistrations).where(and(eq(commsWakeRegistrations.id, registration.id), eq(commsWakeRegistrations.companyId, companyId)));
      report.registration = "removed";
      report.result = "unsubscribed";
    }

    // The registration's secret, or one left behind by a registration that crashed before it was recorded. Only this
    // agent's own managed key is ever matched.
    const secretIds = new Set<string>(registration ? [registration.signingSecretId] : []);
    const [orphan] = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, `${SIGNING_SECRET_KEY_PREFIX}${agentId}`)))
      .limit(1);
    if (orphan) secretIds.add(orphan.id);
    for (const secretId of secretIds) {
      try {
        await secretService(db).remove(secretId);
        report.secret = report.secret === "failed" ? "failed" : "removed";
      } catch (err) {
        logger.warn({ agentId, errorClass: errorClass(err) }, "comms wake signing secret could not be removed");
        report.secret = "failed";
      }
    }

    await patchWakeSetup(db, companyId, agentId, { state: "not_required", reason: "operator_excluded", nextAttemptAt: null, leaseUntil: null, claimId: null, updatedAt: new Date().toISOString() }, ["pending", "in_progress", "error", "ready"]);
    await logActivity(db, {
      companyId,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId ?? "comms-wake-admin",
      action: "agent.comms_wake.unsubscribed",
      entityType: "agent",
      entityId: agentId,
      details: { result: report.result, board: report.board, registration: report.registration, secret: report.secret },
    });
    return report;
  });
}

// ---------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------

export type CommsWakeRotateResult =
  | "rotated"
  | "not_registered"
  | "board_not_ready"
  | "board_not_configured"
  | "public_base_url_unavailable"
  | "secret_unavailable"
  /** The board refused or could not be reached: the vault was not touched, so the old secret is still the one in force. */
  | "board_failed"
  /** The vault write failed after the board had the new secret: the board was put back on the old one. */
  | "vault_failed";

export interface CommsWakeRotateReport {
  agentId: string;
  result: CommsWakeRotateResult;
  /** What the board holds afterwards. `unknown`: it could not be confirmed (run the rotation again, which converges). */
  board: "new_secret" | "old_secret" | "unknown" | "not_called";
  boardReason?: string;
  /** Vault version of the signing secret after the call. */
  secretVersion?: number;
}

/**
 * One operation that changes the signing secret on both sides so they never disagree. The board is told first; only after it
 * accepted the new value is a new vault version written (the wake route verifies against the latest version). If the board
 * call fails the vault is untouched. If the board's answer is unknown, or the vault write fails after the board accepted, the
 * old secret is sent back, and the report says what the board is believed to hold.
 */
export async function rotateCommsWakeSecret(
  db: Db,
  input: { companyId: string; agentId: string; actorUserId?: string | null },
  ctx: CommsWakeAdminContext = {},
): Promise<CommsWakeRotateReport> {
  const { companyId, agentId } = input;
  await loadAgentInCompany(db, companyId, agentId);
  return exclusive(agentId, async () => {
    const report = (result: CommsWakeRotateResult, extra: Partial<CommsWakeRotateReport> = {}): CommsWakeRotateReport => ({
      agentId,
      result,
      board: "not_called",
      ...extra,
    });
    const registration = await registrationOf(db, companyId, agentId);
    if (!registration) return report("not_registered");
    const board = await resolveCommsBoardBinding(db, companyId, agentId);
    if (!board?.boardAgentId) return report("board_not_ready");
    const wakeUrl = buildCommsWakeUrl(agentId);
    if (!wakeUrl) return report("public_base_url_unavailable");
    const provisioner = resolveCommsBoardProvisionerConfig(ctx.env ?? process.env);
    if (!provisioner.ok) return report("board_not_configured");
    const fetchImpl = ctx.fetchImpl ?? tailnetAwareFetch;

    const secrets = secretService(db);
    const [secretRow] = await db
      .select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion })
      .from(companySecrets)
      .where(and(eq(companySecrets.id, registration.signingSecretId), eq(companySecrets.companyId, companyId)))
      .limit(1);
    if (!secretRow) return report("secret_unavailable");
    let oldValue: string;
    try {
      oldValue = await secrets.resolveSecretValue(companyId, secretRow.id, "latest", {
        accessContext: { consumerType: "system", consumerId: agentId, configPath: ROTATE_CONFIG_PATH, actorType: "system", actorId: null },
      });
    } catch (err) {
      logger.warn({ agentId, errorClass: errorClass(err) }, "comms wake signing secret could not be read for rotation");
      return report("secret_unavailable");
    }

    const newValue = generateCommsWakeSecret();
    const target = (secret: string) => ({ boardAgentId: board.boardAgentId!, url: wakeUrl, secret, system: COMMS_WAKE_SYSTEM_LABEL });
    const restoreOld = async () => (await setCommsBoardWakeTarget(provisioner.config, target(oldValue), fetchImpl)).ok;

    const sent = await setCommsBoardWakeTarget(provisioner.config, target(newValue), fetchImpl);
    if (!sent.ok) {
      // A refusal means the board kept the old target. A failure may have been applied without us seeing the answer.
      if (sent.reason !== "failed") return report("board_failed", { board: "old_secret", boardReason: sent.reason, secretVersion: secretRow.latestVersion });
      const restored = await restoreOld();
      return report("board_failed", { board: restored ? "old_secret" : "unknown", boardReason: sent.reason, secretVersion: secretRow.latestVersion });
    }

    let secretVersion: number;
    try {
      const rotated = await secrets.rotate(secretRow.id, { value: newValue, expectedLatestVersion: secretRow.latestVersion }, { userId: input.actorUserId ?? null });
      secretVersion = rotated.latestVersion;
    } catch (err) {
      logger.warn({ agentId, errorClass: errorClass(err) }, "comms wake signing secret rotation failed after the board accepted it");
      const restored = await restoreOld();
      return report("vault_failed", { board: restored ? "old_secret" : "unknown", secretVersion: secretRow.latestVersion });
    }

    await db
      .update(commsWakeRegistrations)
      .set({ boardAgentId: board.boardAgentId, updatedAt: new Date() })
      .where(and(eq(commsWakeRegistrations.id, registration.id), eq(commsWakeRegistrations.companyId, companyId)));
    await logActivity(db, {
      companyId,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId ?? "comms-wake-admin",
      action: "agent.comms_wake.secret_rotated",
      entityType: "agent",
      entityId: agentId,
      details: { secretVersion },
    });
    return report("rotated", { board: "new_secret", secretVersion });
  });
}

// ---------------------------------------------------------------------------
// Deletion cleanup
// ---------------------------------------------------------------------------

export interface CommsWakeCleanupTarget {
  companyId: string;
  agentId: string;
  boardAgentId: string;
  signingSecretId: string;
}

/** Read BEFORE the agent (or company) is deleted: the registration row cascades away with it and is the only record of these ids. */
export async function readCommsWakeCleanupTargets(
  db: Db,
  where: { agentId: string } | { companyId: string },
): Promise<CommsWakeCleanupTarget[]> {
  return db
    .select({
      companyId: commsWakeRegistrations.companyId,
      agentId: commsWakeRegistrations.agentId,
      boardAgentId: commsWakeRegistrations.boardAgentId,
      signingSecretId: commsWakeRegistrations.signingSecretId,
    })
    .from(commsWakeRegistrations)
    .where("agentId" in where ? eq(commsWakeRegistrations.agentId, where.agentId) : eq(commsWakeRegistrations.companyId, where.companyId));
}

/**
 * After the agent is deleted: take its address off the board, then remove its vault secret (company deletion removes the
 * secrets itself, so it passes `removeSecret: false`). Neither step can block or undo the deletion. A board call that fails
 * is NOT silent: it is logged with the board agent id and (while the company exists) written to the activity log as
 * `agent.comms_wake.board_cleanup_failed`, so an operator can remove the address with `comms_admin_wake_target_remove`. Until
 * then the address only points at a Paperclip agent that no longer exists, so a delivery to it is refused by the wake route.
 */
export async function cleanupCommsWakeAfterDeletion(
  db: Db,
  targets: CommsWakeCleanupTarget[],
  options: { removeSecret: boolean; recordActivity: boolean },
  ctx: CommsWakeAdminContext = {},
): Promise<void> {
  if (targets.length === 0) return;
  const provisioner = resolveCommsBoardProvisionerConfig(ctx.env ?? process.env);
  for (const target of targets) {
    let boardReason: string | null = null;
    if (!provisioner.ok) boardReason = provisioner.reason;
    else {
      try {
        const outcome = await removeCommsBoardWakeTarget(provisioner.config, { boardAgentId: target.boardAgentId }, ctx.fetchImpl ?? tailnetAwareFetch);
        if (!outcome.ok) boardReason = outcome.reason;
      } catch (err) {
        boardReason = errorClass(err);
      }
    }
    if (boardReason) {
      logger.warn({ agentId: target.agentId, companyId: target.companyId, boardAgentId: target.boardAgentId, reason: boardReason }, "comms wake address was not removed from the board");
      if (options.recordActivity) {
        await logActivity(db, {
          companyId: target.companyId,
          actorType: "system",
          actorId: "comms-wake-admin",
          action: "agent.comms_wake.board_cleanup_failed",
          entityType: "agent",
          entityId: target.agentId,
          details: { boardAgentId: target.boardAgentId, reason: boardReason },
        }).catch(() => undefined);
      }
    }
    if (options.removeSecret) {
      try {
        await secretService(db).remove(target.signingSecretId);
      } catch (err) {
        logger.warn({ agentId: target.agentId, errorClass: errorClass(err) }, "comms wake signing secret was not removed after agent deletion");
      }
    }
  }
}
