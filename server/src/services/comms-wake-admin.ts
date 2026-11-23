/**
 * Operator tools for comms-board wake registrations of EXISTING agents (TECH-9914): enrol them and see their
 * status. New agents are registered by the setup hook of the `comms-wake` default-MCP entry (comms-wake-registration.ts, TECH-9912); enrolment of an existing agent writes that same
 * entry and runs the same hook, so there is one registration implementation, one retry path (the default-MCP sweep) and one
 * visible state (the entry in the agent's setup state).
 *
 * Every read and write is scoped by company. Secret values live only in the vault and in the one board call that sets them:
 * they are never logged, put in an activity record, a report or an error. Reports carry ids, states and reasons only.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { agents, commsWakeRegistrations, companies, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { FetchLike } from "./comms-board-provisioner-client.js";
import { COMMS_WAKE_ENTRY_KEY } from "./comms-wake-registration.js";
import { resolveCommsBoardBinding, runDefaultMcpSetupForAgent } from "./default-mcp-setup.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  readDefaultMcpState,
  type DefaultMcpEntryState,
  type DefaultMcpSetupReason,
} from "./default-mcp-spec.js";

export const COMMS_WAKE_BATCH_LIMIT = 25;
export const COMMS_WAKE_STATUS_LIMIT = 200;
/** A real enrolment run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_WAKE_ENROL_CONFIRMATION = "enrol-comms-wake-agents";

export interface CommsWakeAdminContext {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export class CommsWakeConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

// One enrolment per agent per process at a time. The setup claim and the idempotent board call keep overlapping runs across
// instances harmless.
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
      const outcome = await exclusive(row.id, () => enrolOne(db, options.companyId, row.id, ctx));
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

async function enrolOne(db: Db, companyId: string, agentId: string, ctx: CommsWakeAdminContext): Promise<CommsWakeEnrolOutcome> {
  const spec = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === COMMS_WAKE_ENTRY_KEY);
  if (!spec) throw new Error("comms-wake spec missing");
  const nowIso = new Date().toISOString();
  const agent = await loadAgentInCompany(db, companyId, agentId);
  const entries = readDefaultMcpState(agent.metadata)?.entries ?? {};
  const existing = entries[COMMS_WAKE_ENTRY_KEY];

  if (!existing) {
    const entry: DefaultMcpEntryState = {
      key: COMMS_WAKE_ENTRY_KEY,
      templateKey: spec.connectionName,
      dedicated: true,
      enabled: false,
      templateConnectionId: null,
      connectionId: null,
      ownerUserId: entries["comms-board"]?.ownerUserId ?? null,
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
    // Created only while absent, so a concurrent writer is never overwritten.
    await db
      .update(agents)
      .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath()}, ${JSON.stringify(entry)}::jsonb, true)` })
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), sql`${agents.metadata} #> ${entryPath()} is null`));
  } else if (existing.setup.state === "in_progress") {
    return { agentId, result: "pending", reason: "in_progress" };
  } else if (existing.setup.state !== "ready") {
    // An operator run retries now: a backoff, an earlier terminal error or an unsubscribe does not hold it back.
    await patchWakeSetup(
      db,
      companyId,
      agentId,
      { state: "pending", reason: null, attemptCount: 0, nextAttemptAt: null, updatedAt: nowIso },
      ["pending", "error", "not_required"],
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
