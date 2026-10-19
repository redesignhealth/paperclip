/**
 * Registers each agent's Arcana brain in the ACA brain directory (TECH-7693, ACA TECH-7692).
 *
 * ACA keeps one insert-only row per comms board sub: `PUT {ownership}/brain-bindings/{boardSub}` with the principal, runtime,
 * company, brain id, agent id and identity generation. Paperclip is the only writer. ACA re-derives every id from the same
 * recipe and rejects anything else, so this is facts, not authority. Auto-approval and read access stay separate policy.
 *
 * An agent is bound once BOTH its comms-board entry and its arcana-brain entry are ready. The two entries run
 * independently and either can finish first, so nothing is pushed from the hooks: the setup sweep calls
 * `sweepBrainBindings` every tick, and the operator route (`backfillBrainBindings`) is the same per-agent step with
 * paging and a dry run. Both are idempotent (ACA answers 200 for an identical replay).
 *
 * Only a sub Paperclip minted is ever sent: the comms entry's recorded `boardSub` must equal the recipe sub for its identity
 * generation, with no legacy agent key. A transient failure (ACA down, 401, 5xx, timeout) writes nothing and is retried by
 * the next sweep. A settled answer (bound, 409 conflict, 403/422 rejected) is recorded on the arcana entry as
 * `binding.brainBinding` for that board sub, so a conflict is surfaced once instead of retried forever. A reissued board
 * identity has a new sub, which makes the old marker not match and the agent is evaluated again.
 *
 * Reports carry counts and agent ids only. No token, URL, secret id or response body is returned or logged.
 */
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  ARCANA_IDENTITY_RECIPE_VERSION,
  composeArcanaBrainIdentity,
  type FetchLike,
} from "./arcana-provisioner-client.js";
import { composeCommsBoardIdentity } from "./comms-board-provisioner-client.js";
import { DEFAULT_MCP_METADATA_KEY, readDefaultMcpState, type DefaultMcpEntryState } from "./default-mcp-spec.js";
import { readArcanaProvisionerSnapshot } from "../secrets/arcana-provisioner-credentials.js";
import { readCommsBoardProvisionerSnapshot } from "../secrets/comms-board-provisioner-credentials.js";

export const BRAIN_BINDING_ARCANA_ENTRY_KEY = "arcana-brain";
export const BRAIN_BINDING_COMMS_ENTRY_KEY = "comms-board";
export const BRAIN_BINDING_BATCH_LIMIT = 25;
export const BRAIN_BINDING_REQUEST_TIMEOUT_MS = 10_000;
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const BRAIN_BINDING_CONFIRMATION = "bind-arcana-brains";

export type BrainBindingResult =
  | "would_bind"
  | "bound"
  | "already_current"
  | "conflict"
  | "rejected"
  | "identity_mismatch"
  | "skipped_terminated"
  | "skipped_company_archived"
  | "skipped_no_arcana_entry"
  | "skipped_arcana_not_ready"
  | "skipped_no_comms_entry"
  | "skipped_comms_not_ready"
  | "skipped_sub_not_minted"
  | "binding_not_configured"
  | "binding_config_invalid"
  | "bind_failed"
  | "marker_write_failed"
  | "bind_error";

const RESULTS: readonly BrainBindingResult[] = [
  "would_bind", "bound", "already_current", "conflict", "rejected", "identity_mismatch", "skipped_terminated",
  "skipped_company_archived", "skipped_no_arcana_entry", "skipped_arcana_not_ready", "skipped_no_comms_entry",
  "skipped_comms_not_ready", "skipped_sub_not_minted", "binding_not_configured", "binding_config_invalid", "bind_failed",
  "marker_write_failed", "bind_error",
];

export interface BrainBindingOutcome {
  agentId: string;
  companyId: string;
  result: BrainBindingResult;
  generation?: number;
}

export interface BrainBindingReport {
  dryRun: boolean;
  scanned: number;
  outcomes: BrainBindingOutcome[];
  counts: Record<BrainBindingResult, number>;
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

export class BrainBindingConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class BrainBindingInProgressError extends Error {
  constructor() {
    super("A brain binding run is already in progress for this company");
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function validEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

export interface BrainBindingConfig {
  /** ACA ownership API base (the comms-board ownership URL, already ending at the registry mount). */
  registryUrl: string;
  bindingToken: string;
}

export type BrainBindingConfigResult =
  | { ok: true; config: BrainBindingConfig }
  | { ok: false; reason: "binding_not_configured" | "binding_config_invalid" };

/** Reads the FROZEN boot snapshots. An injected env is converted purely (tests). */
export function resolveBrainBindingConfig(env?: NodeJS.ProcessEnv): BrainBindingConfigResult {
  let registryUrl: string | null;
  let bindingToken: string | null;
  if (env === undefined || env === process.env) {
    registryUrl = readCommsBoardProvisionerSnapshot().ownershipApiUrl;
    bindingToken = readArcanaProvisionerSnapshot().bindingToken;
  } else {
    const trimmed = (key: string) => (typeof env[key] === "string" && env[key]!.trim() ? env[key]!.trim() : null);
    registryUrl = trimmed("PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL");
    bindingToken = trimmed("PAPERCLIP_ARCANA_BINDING_TOKEN");
  }
  if (!registryUrl || !bindingToken) return { ok: false, reason: "binding_not_configured" };
  if (!validEndpoint(registryUrl)) return { ok: false, reason: "binding_config_invalid" };
  return { ok: true, config: { registryUrl: registryUrl.replace(/\/+$/, ""), bindingToken } };
}

export type BrainBindingPutOutcome =
  | { ok: true; created: boolean }
  | { ok: false; settled: "conflict" | "rejected" }
  | { ok: false; settled: null };

export interface BrainBindingRequest {
  boardSub: string;
  principal: string;
  runtime: string;
  company: string;
  brainId: string;
  agentId: string;
  generation: number;
}

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {}
}

/** One `PUT /brain-bindings/{sub}`. Response bodies are never read or logged. */
export async function putBrainBinding(
  config: BrainBindingConfig,
  request: BrainBindingRequest,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = BRAIN_BINDING_REQUEST_TIMEOUT_MS,
): Promise<BrainBindingPutOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.registryUrl}/brain-bindings/${encodeURIComponent(request.boardSub)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${config.bindingToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        principal: request.principal,
        runtime: request.runtime,
        company: request.company,
        brain_id: request.brainId,
        agent_id: request.agentId,
        identity_generation: request.generation,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, settled: null };
  }
  await discard(response);
  if (response.status === 201) return { ok: true, created: true };
  if (response.status === 200) return { ok: true, created: false };
  // 409: a different or deactivated binding already holds this sub or brain. 403/422: ACA refused this sub or tuple.
  if (response.status === 409) return { ok: false, settled: "conflict" };
  if (response.status === 403 || response.status === 422) return { ok: false, settled: "rejected" };
  // 401 (token), 404, 429, 5xx, anything else: transient or configuration, never recorded as settled.
  return { ok: false, settled: null };
}

type Eligibility =
  | { eligible: true; arcana: DefaultMcpEntryState; request: BrainBindingRequest; marker: NonNullable<DefaultMcpEntryState["binding"]>["brainBinding"] }
  | { eligible: false; result: BrainBindingResult };

function classify(row: { id: string; companyId: string; metadata: unknown }): Eligibility {
  const entries = readDefaultMcpState(row.metadata)?.entries ?? {};
  const arcana = entries[BRAIN_BINDING_ARCANA_ENTRY_KEY];
  const comms = entries[BRAIN_BINDING_COMMS_ENTRY_KEY];
  if (!arcana) return { eligible: false, result: "skipped_no_arcana_entry" };
  if (arcana.setup.state !== "ready" || !arcana.binding?.secretId) return { eligible: false, result: "skipped_arcana_not_ready" };
  if (!comms) return { eligible: false, result: "skipped_no_comms_entry" };
  if (comms.setup.state !== "ready" || !comms.binding) return { eligible: false, result: "skipped_comms_not_ready" };

  // Only a sub Paperclip minted: the recorded board sub is exactly the recipe sub for its generation, with no legacy key.
  const generation = comms.identityGeneration ?? 0;
  const minted = composeCommsBoardIdentity(row.id, generation);
  if (!minted || comms.binding.agentKey || comms.binding.boardSub !== minted.boardSub) {
    return { eligible: false, result: "skipped_sub_not_minted" };
  }

  // The recipe is the check on writes: stored ids, when present, must equal it.
  const identity = composeArcanaBrainIdentity(row.companyId, row.id);
  if (!identity) return { eligible: false, result: "identity_mismatch" };
  const b = arcana.binding;
  if (
    (b.arcanaBrainId != null && b.arcanaBrainId !== identity.brainId) ||
    (b.arcanaRuntimeId != null && b.arcanaRuntimeId !== identity.runtimeId) ||
    b.baseSub !== identity.agentPrincipalId
  ) {
    return { eligible: false, result: "identity_mismatch" };
  }
  return {
    eligible: true,
    arcana,
    marker: b.brainBinding,
    request: {
      boardSub: minted.boardSub,
      principal: identity.agentPrincipalId,
      runtime: identity.runtimeId,
      company: identity.companyId,
      brainId: identity.brainId,
      agentId: row.id.toLowerCase(),
      generation,
    },
  };
}

function arcanaBindingPath(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", BRAIN_BINDING_ARCANA_ENTRY_KEY, "binding", ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

export interface BindOneOptions {
  dryRun: boolean;
  /** Re-attempt an agent whose last settled answer was conflict/rejected (after the cause was fixed). */
  retrySettled?: boolean;
  config: BrainBindingConfigResult;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/** The single per-agent step shared by the sweep and the operator route. */
export async function bindOneAgent(
  db: Db,
  row: { id: string; companyId: string; metadata: unknown; status: string; companyStatus: string },
  options: BindOneOptions,
): Promise<BrainBindingOutcome> {
  const out = (result: BrainBindingResult, generation?: number): BrainBindingOutcome => ({
    agentId: row.id,
    companyId: row.companyId,
    result,
    ...(generation === undefined ? {} : { generation }),
  });
  if (row.status === "terminated" || row.status === "pending_approval") return out("skipped_terminated");
  if (row.companyStatus === "archived") return out("skipped_company_archived");
  const eligibility = classify(row);
  if (!eligibility.eligible) return out(eligibility.result);
  const { request, marker, arcana } = eligibility;
  const generation = request.generation;
  if (marker && marker.boardSub === request.boardSub) {
    if (marker.state === "bound") return out("already_current", generation);
    if (!options.retrySettled) return out(marker.state, generation);
  }
  if (options.dryRun) return out("would_bind", generation);
  if (!options.config.ok) return out(options.config.reason, generation);

  const put = await putBrainBinding(options.config.config, request, options.fetchImpl);
  if (!put.ok && put.settled === null) return out("bind_failed", generation);
  const state = put.ok ? "bound" : put.settled;
  const at = (options.now?.() ?? new Date()).toISOString();
  const brainBinding = { state, boardSub: request.boardSub, generation, at };
  const stored = arcana.binding!;
  // Also persists the runtime and brain id for agents provisioned before they were recorded (same recipe-checked values).
  const updated = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(jsonb_set(jsonb_set(jsonb_set(${agents.metadata}, ${arcanaBindingPath("brainBinding")}, ${JSON.stringify(brainBinding)}::jsonb, true), ${arcanaBindingPath("arcanaRuntimeId")}, ${JSON.stringify(request.runtime)}::jsonb, true), ${arcanaBindingPath("arcanaBrainId")}, ${JSON.stringify(request.brainId)}::jsonb, true), ${arcanaBindingPath("arcanaRecipeVersion")}, ${JSON.stringify(ARCANA_IDENTITY_RECIPE_VERSION)}::jsonb, true)`,
    })
    .where(
      and(
        eq(agents.id, row.id),
        sql`${agents.metadata} #>> ${arcanaBindingPath("secretId")} = ${stored.secretId!}`,
        sql`${agents.metadata} #>> ${sql`ARRAY['defaultMcp','entries','arcana-brain','setup','state']::text[]`} = 'ready'`,
      ),
    )
    .returning({ id: agents.id });
  // ACA already holds the row; only the marker is missing, so the next run repeats the idempotent PUT.
  if (updated.length !== 1) return out("marker_write_failed", generation);

  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "arcana-brain-binding",
    action: `agent.arcana_brain.binding_${state}`,
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only.
    details: { boardSub: request.boardSub, generation, created: put.ok ? put.created : false },
  });
  return out(state === "bound" ? "bound" : state, generation);
}

export interface BrainBindingBackfillOptions {
  companyId: string;
  limit?: number;
  afterId?: string;
  /** Default TRUE: a read-only census. */
  dryRun?: boolean;
  /** Required (exactly `BRAIN_BINDING_CONFIRMATION`) when `dryRun` is false. */
  confirm?: string;
  retrySettled?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

function emptyCounts(): BrainBindingReport["counts"] {
  return Object.fromEntries(RESULTS.map((r) => [r, 0])) as BrainBindingReport["counts"];
}

// One real run per company per process at a time; the idempotent PUT keeps overlapping runs across instances harmless.
const runningCompanies = new Set<string>();

export async function backfillBrainBindings(db: Db, options: BrainBindingBackfillOptions): Promise<BrainBindingReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== BRAIN_BINDING_CONFIRMATION) throw new BrainBindingConfirmationError();
  if (!dryRun) {
    if (runningCompanies.has(options.companyId)) throw new BrainBindingInProgressError();
    runningCompanies.add(options.companyId);
  }
  try {
    const limit = Math.max(1, Math.min(options.limit ?? BRAIN_BINDING_BATCH_LIMIT, BRAIN_BINDING_BATCH_LIMIT));
    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        metadata: agents.metadata,
        status: agents.status,
        companyStatus: companies.status,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(agents.companyId, options.companyId), options.afterId ? gt(agents.id, options.afterId) : undefined))
      .orderBy(asc(agents.id))
      .limit(limit);
    // Fail closed before any per-agent call: no config, no HTTP call (the resolver reads the frozen boot snapshots).
    const config = resolveBrainBindingConfig(options.env);
    const outcomes: BrainBindingOutcome[] = [];
    for (const row of rows) {
      try {
        outcomes.push(await bindOneAgent(db, row, { dryRun, retrySettled: options.retrySettled, config, fetchImpl: options.fetchImpl }));
      } catch (err) {
        // Only the error class is logged: never a message, URL, header, token or body.
        logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "arcana brain binding item failed");
        outcomes.push({ agentId: row.id, companyId: row.companyId, result: "bind_error" });
      }
    }
    const counts = emptyCounts();
    for (const outcome of outcomes) counts[outcome.result] += 1;
    return { dryRun, scanned: rows.length, outcomes, counts, nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
  } finally {
    if (!dryRun) runningCompanies.delete(options.companyId);
  }
}

export const BRAIN_BINDING_SWEEP_LIMIT = 10;

// The sweep walks candidates in id order with a rotating cursor, so agents that can never be bound (legacy keyed comms
// subs, mismatched ids) cannot occupy the batch and starve the rest. The cursor is per process and only an optimisation of
// order: every PUT is idempotent.
let sweepCursor: string | null = null;

/** Test seam. */
export function __resetBrainBindingSweepForTests(): void {
  sweepCursor = null;
}

/**
 * Binds agents whose two entries are ready and whose recorded marker is absent or names a different board sub. Settled agents
 * are excluded in the query; agents that cannot be bound are passed over by the rotating id cursor. Three transient failures in a row end
 * the tick (ACA is likely down; the next tick retries). No-op (no query) when the binding token is not configured.
 */
export async function sweepBrainBindings(
  db: Db,
  ctx: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => Date; limit?: number } = {},
): Promise<number> {
  const config = resolveBrainBindingConfig(ctx.env);
  if (!config.ok) return 0;
  const entry = (key: string, ...rest: string[]) =>
    sql`a.metadata #>> ${sql`ARRAY['defaultMcp','entries',${key},${sql.join(rest.map((part) => sql`${part}`), sql`,`)}]::text[]`}`;
  const result: unknown = await db.execute(sql`
    select a.id as id, a.company_id as company_id, a.metadata as metadata, a.status as status, c.status as company_status
    from agents a
    join companies c on c.id = a.company_id
    where a.status not in ('pending_approval', 'terminated')
      and c.status <> 'archived'
      and jsonb_typeof(a.metadata -> ${DEFAULT_MCP_METADATA_KEY}) = 'object'
      and ${entry(BRAIN_BINDING_ARCANA_ENTRY_KEY, "setup", "state")} = 'ready'
      and ${entry(BRAIN_BINDING_COMMS_ENTRY_KEY, "setup", "state")} = 'ready'
      and coalesce(${entry(BRAIN_BINDING_ARCANA_ENTRY_KEY, "binding", "brainBinding", "boardSub")}, '') <>
          coalesce(${entry(BRAIN_BINDING_COMMS_ENTRY_KEY, "binding", "boardSub")}, '-')
      ${sweepCursor ? sql`and a.id > ${sweepCursor}::uuid` : sql``}
    order by a.id asc
    limit ${ctx.limit ?? BRAIN_BINDING_SWEEP_LIMIT}
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
    id: string;
    company_id: string;
    metadata: unknown;
    status: string;
    company_status: string;
  }>;
  const limit = ctx.limit ?? BRAIN_BINDING_SWEEP_LIMIT;
  // Wrap to the start once the end is reached.
  sweepCursor = rows.length < limit ? null : (rows[rows.length - 1]?.id ?? null);
  let consecutiveFailures = 0;
  for (const row of rows) {
    try {
      const outcome = await bindOneAgent(
        db,
        { id: row.id, companyId: row.company_id, metadata: row.metadata, status: row.status, companyStatus: row.company_status },
        { dryRun: false, config, fetchImpl: ctx.fetchImpl, now: ctx.now },
      );
      // ACA is likely down after a few failures in a row: end the tick rather than wait out every timeout.
      consecutiveFailures = outcome.result === "bind_failed" ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= 3) break;
    } catch (err) {
      logger.warn({ agentId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "arcana brain binding sweep item failed");
    }
  }
  return rows.length;
}
