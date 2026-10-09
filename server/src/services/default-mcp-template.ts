/**
 * Managed company template for the default MCP spec (TECH-7271).
 *
 * `default-mcp-setup.ts` clones a per-agent comms-board connection from an org-authored, read-only
 * template named `rh-comms-board`. This module makes that template exist for EVERY non-archived
 * company, without an operator creating it by hand and without a new route, table, migration or
 * framework. It composes the existing services:
 *
 *  - Durable claim: `tool_connections.config.defaultMcpTemplate` on a connection with the fixed uid
 *    `DEFAULT_MCP_TEMPLATE_UID` (unique per company, so one row per company). Every checkpoint is a
 *    path-scoped `jsonb_set` guarded by a random `claimId`, mirroring the per-agent setup. A stale or
 *    losing worker can neither lose nor clobber an outcome.
 *  - L1 (one local transaction, advisory-locked per company): find / adopt / create the application and
 *    the template connection (DRAFT, disabled, no credential refs yet, quarantine-new-entries, server
 *    markers) and freeze the human owner.
 *  - Mint (the only external write): the server's existing ownership API `POST /agents` with
 *    `comms:read` ONLY, 365 days, subject `paperclip-company-template-<company uuid>`. No board admin
 *    registration, no admin credential. The checkpoint is written BEFORE the POST: an unknown outcome or
 *    a 409 is terminal and never rotated or retried. Only a definitive 400/401/403/422 (no row can have
 *    been created) clears the checkpoint and is retried with backoff. The token only ever exists in the
 *    encrypted vault and is never logged or recorded in activity.
 *  - L2 (local transaction): header credential reference (`Authorization: Bearer`, latest) + bindings.
 *    The connection stays DRAFT.
 *  - Discovery (OUTSIDE any transaction): the existing `refreshCatalog`, with the default profile sync
 *    skipped (the managed-template guard in tool-access.ts also makes it a no-op).
 *  - L3 (local transaction, claim re-checked): the reviewed allowlist is applied. Allowlisted actions are
 *    ACTIVE with `reviewedAt`; every other discovered action is DISABLED. The default-deny `app:<id>`
 *    profile includes the allowlisted actions only and has NO bindings. The template has NO install rows;
 *    one is drift and is reported, never deleted. Only then is the connection activated and the claim ready.
 *
 * The template is provisioning-only. It is never installable or usable by any agent (see the guards in
 * `tool-access.ts`, `default-mcp-install-gate.ts` and `installAppliesToAgent`). A ready template is
 * trusted only while its token is unexpired and its local wiring agrees; an expired or drifted template is
 * terminal and is NEVER silently re-issued. See doc/connections/DEFAULT-MCP-SPEC.md.
 *
 * Scope is the boot-frozen `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS` (unset = every company).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecrets,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  isCompanyInDefaultMcpTemplateScope,
  readDefaultMcpTemplateScope,
  type DefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import {
  composeTemplateSub,
  mintCommsBoardTemplateCredential,
  resolveCommsBoardProvisionerConfig,
  type CommsBoardProvisionerConfig,
  type FetchLike,
} from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_LEASE_MS,
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  DEFAULT_MCP_MAX_ATTEMPTS,
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_TEMPLATE_CONFIG_KEY,
  DEFAULT_MCP_TEMPLATE_UID,
  defaultMcpBackoffMs,
  isDefaultMcpSpecEnabled,
  isManagedTemplate,
  readTemplateClaim,
  type DefaultMcpEntrySpec,
  type DefaultMcpSetupReason,
  type DefaultMcpTemplateClaim,
} from "./default-mcp-spec.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";

type Connection = typeof toolConnections.$inferSelect;
type ToolAccessOptions = NonNullable<Parameters<typeof toolAccessService>[1]>;

export const DEFAULT_MCP_TEMPLATE_SWEEP_LIMIT = 25;
/** Deterministic vault key of the template token (company-scoped). */
export const DEFAULT_MCP_TEMPLATE_SECRET_KEY = "default_mcp.comms_board.template";
/**
 * In-process retry spacing for outcomes that leave no durable state (no owner yet, collision): 30s doubling
 * to a 10 minute cap. A brand-new company usually gets its owner membership milliseconds after the
 * create hook ran, so its retry is quick; a company that never has an eligible owner decays to the cap and
 * can never starve the sweep.
 */
export const DEFAULT_MCP_TEMPLATE_DEFER_BASE_MS = 30_000;
export const DEFAULT_MCP_TEMPLATE_DEFER_MAX_MS = 10 * 60_000;
const TEMPLATE_TOKEN_TTL_DAYS = 365;
/**
 * The adoption window compares the database's `created_at` with the app server's `mintAttemptedAt`, two clocks.
 * A small bounded tolerance keeps owned recovery working under skew. It does not weaken the ownership proof:
 * minting is refused while ANY active secret holds the deterministic key, so no foreign secret can pre-date the
 * attempt, and adoption additionally requires our description and the frozen owner as creator.
 */
export const DEFAULT_MCP_TEMPLATE_ADOPT_SKEW_MS = 30_000;
const MAX_DEFERRED = 5_000;

export interface DefaultMcpTemplateContext {
  db: Db;
  /** Feature flag + provisioner source. Absent or `process.env` means the boot-frozen provisioner snapshot. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  spec?: readonly DefaultMcpEntrySpec[];
  /** Explicit rollout scope (tests / config seams). Production uses the boot-frozen scope. */
  scope?: DefaultMcpTemplateScope;
  toolAccessOptions?: ToolAccessOptions;
}

let runtimeToolAccessOptions: ToolAccessOptions | undefined;

/** Lets the server pass its deployment mode/exposure to template discovery (same as the other tool-access users). */
export function configureDefaultMcpTemplateRuntime(options: { toolAccessOptions?: ToolAccessOptions }): void {
  runtimeToolAccessOptions = options.toolAccessOptions;
}

export type CompanyTemplateSkipReason =
  | "feature_disabled"
  | "out_of_scope"
  | "no_bootstrap_entry"
  | "provisioner_not_configured"
  | "provisioner_config_invalid"
  | "company_not_found"
  | "company_archived";

export type CompanyTemplateOutcome =
  | { kind: "skipped"; reason: CompanyTemplateSkipReason }
  /** An existing, valid, user-managed `rh-comms-board` connection is trusted as before: nothing is written. */
  | { kind: "adopted" }
  /** Malformed or ambiguous same-name collision: fail closed, nothing inserted or minted. */
  | { kind: "collision"; reason: "template_ambiguous" | "template_unsupported" }
  | { kind: "waiting"; reason: DefaultMcpSetupReason }
  /** Our fixed-uid template was archived by an operator: terminal, never recreated. */
  | { kind: "revoked" }
  | { kind: "ready" }
  | { kind: "pending"; reason: DefaultMcpSetupReason | null }
  | { kind: "error"; reason: DefaultMcpSetupReason }
  | { kind: "not_claimed" };

class ClaimLostError extends Error {}

// ---------------------------------------------------------------------------
// SQL helpers (path-scoped writes of `config.defaultMcpTemplate.*` only)
// ---------------------------------------------------------------------------

function claimPathSql(...rest: string[]): SQL {
  const parts = [DEFAULT_MCP_TEMPLATE_CONFIG_KEY, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

const claimField = (field: string): SQL => sql`${toolConnections.config} #>> ${claimPathSql(field)}`;
const managedMarkerIsTemplate: SQL = sql`${toolConnections.config} #>> ${sql`ARRAY[${DEFAULT_MCP_MANAGED_CONFIG_KEY}::text]`} = 'template'`;

type ClaimPatch = Partial<
  Pick<
    DefaultMcpTemplateClaim,
    | "state"
    | "reason"
    | "nextAttemptAt"
    | "leaseUntil"
    | "claimId"
    | "mintAttemptedAt"
    | "secretId"
    | "tokenExpiresAt"
    | "allowlistVersion"
    | "readyAt"
    | "ownerUserId"
    | "ownerEmailNorm"
    | "updatedAt"
  >
>;

function applyClaimPatch(patch: ClaimPatch): SQL {
  let expr: SQL = sql`${toolConnections.config}`;
  for (const [field, value] of Object.entries(patch)) {
    expr = sql`jsonb_set(${expr}, ${claimPathSql(field)}, ${JSON.stringify(value)}::jsonb, true)`;
  }
  return expr;
}

/**
 * Path-scoped write, and only while the row is still claimed (`in_progress`) by `claimId` AND not archived. An
 * operator archive (revocation) always wins: a claim write, including the activation columns, can never
 * touch an archived row, so it can never flip it back to `active`.
 */
async function patchUnderClaim(
  db: Pick<Db, "update">,
  connectionId: string,
  claimId: string,
  patch: ClaimPatch,
  columns: Partial<Pick<typeof toolConnections.$inferInsert, "status" | "enabled" | "credentialRefs" | "healthStatus">> = {},
): Promise<boolean> {
  const rows = await db
    .update(toolConnections)
    .set({ ...columns, config: applyClaimPatch(patch), updatedAt: new Date() })
    .where(
      and(
        eq(toolConnections.id, connectionId),
        managedMarkerIsTemplate,
        ne(toolConnections.status, "archived"),
        sql`${claimField("claimId")} = ${claimId}`,
        sql`${claimField("state")} = 'in_progress'`,
      ),
    )
    .returning({ id: toolConnections.id });
  return rows.length === 1;
}

/** Path-scoped state change guarded on the CURRENT state (used for ready -> error/pending verification). */
async function patchIfState(
  db: Pick<Db, "update">,
  connectionId: string,
  fromState: string,
  patch: ClaimPatch,
): Promise<boolean> {
  const rows = await db
    .update(toolConnections)
    .set({ config: applyClaimPatch(patch), updatedAt: new Date() })
    .where(
      and(
        eq(toolConnections.id, connectionId),
        managedMarkerIsTemplate,
        ne(toolConnections.status, "archived"),
        sql`${claimField("state")} = ${fromState}`,
      ),
    )
    .returning({ id: toolConnections.id });
  return rows.length === 1;
}

/**
 * Claims the template once: pending and due, or in progress with an expired lease. Exactly one caller on
 * any instance wins. Text-compared ISO timestamps, so a malformed stored value can never raise a cast error.
 */
async function claimTemplate(db: Pick<Db, "update">, connectionId: string, now: Date): Promise<DefaultMcpTemplateClaim | null> {
  const claimId = randomUUID();
  const nowIso = now.toISOString();
  const stamp = (field: string) => sql`coalesce(${claimField(field)}, '') COLLATE "C"`;
  const attemptCountSql = sql`CASE WHEN (${claimField("attemptCount")}) ~ '^[0-9]{1,6}$' THEN (${claimField("attemptCount")})::int ELSE 0 END`;
  const patch = {
    state: "in_progress",
    reason: null,
    nextAttemptAt: null,
    leaseUntil: new Date(now.getTime() + DEFAULT_MCP_LEASE_MS).toISOString(),
    claimId,
    updatedAt: nowIso,
  };
  const claimKeyPath = claimPathSql();
  const rows = await db
    .update(toolConnections)
    .set({
      config: sql`jsonb_set(${toolConnections.config}, ${claimKeyPath}, (${toolConnections.config} #> ${claimKeyPath}) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('attemptCount', ${attemptCountSql} + 1), false)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(toolConnections.id, connectionId),
        managedMarkerIsTemplate,
        ne(toolConnections.status, "archived"),
        sql`exists (select 1 from companies c where c.id = ${toolConnections.companyId} and c.status in ('active', 'paused'))`,
        sql`(
          (${claimField("state")} = 'pending' AND ${stamp("nextAttemptAt")} <= ${nowIso}::text COLLATE "C")
          OR (${claimField("state")} = 'in_progress' AND ${stamp("leaseUntil")} <= ${nowIso}::text COLLATE "C")
        )`,
      ),
    )
    .returning({ config: toolConnections.config });
  return rows[0] ? readTemplateClaim(rows[0].config) : null;
}

// ---------------------------------------------------------------------------
// Owner, secrets, readiness
// ---------------------------------------------------------------------------

export interface TemplateOwner {
  userId: string;
  emailNorm: string;
}

/**
 * The human owner the template credential is registered to: an ACTIVE `owner` membership of THIS company
 * whose user has a verified, non-empty email. The company's `defaultResponsibleUserId` wins when eligible,
 * otherwise the earliest owner (ties by principal id). Never invented, never an agent or built-in principal.
 */
export async function pickTemplateOwner(db: Pick<Db, "select">, companyId: string): Promise<TemplateOwner | null> {
  const [company] = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const rows = await db
    .select({ userId: companyMemberships.principalId, email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
        eq(authUsers.emailVerified, true),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.principalId));
  const eligible = rows
    .map((row) => ({ userId: row.userId, emailNorm: (row.email ?? "").trim().toLowerCase() }))
    .filter((row) => row.emailNorm.length > 0);
  return eligible.find((row) => row.userId === company?.defaultResponsibleUserId) ?? eligible[0] ?? null;
}

/** The frozen owner is still an eligible owner with the same verified email (checked before the first mint). */
async function frozenOwnerStillEligible(db: Pick<Db, "select">, companyId: string, claim: DefaultMcpTemplateClaim): Promise<boolean> {
  const [row] = await db
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, claim.ownerUserId),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
        eq(authUsers.emailVerified, true),
      ),
    )
    .limit(1);
  return Boolean(row && (row.email ?? "").trim().toLowerCase() === claim.ownerEmailNorm && claim.ownerEmailNorm.length > 0);
}

const secretDescription = (principalSub: string) =>
  `Managed default-MCP comms-board template token for ${principalSub}. Read-only discovery credential provisioned by Paperclip.`;

async function vaultSecretUsable(db: Pick<Db, "select">, companyId: string, secretId: string): Promise<boolean> {
  const [secret] = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.id, secretId),
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(secret);
}

/**
 * A previous attempt that crashed between storing the token and checkpointing its id may adopt ONLY the
 * deterministic vault secret that is provably ours: this company, the fixed key, `local_encrypted`, active,
 * not deleted, our own description, and created at or after the checkpointed attempt. A pre-existing or
 * foreign secret is never adopted (a pre-mint check refuses to mint while the key is taken).
 */
async function findOwnedTemplateSecret(
  db: Pick<Db, "select">,
  companyId: string,
  claim: DefaultMcpTemplateClaim,
): Promise<{ id: string } | null> {
  const attemptedAt = claim.mintAttemptedAt ? Date.parse(claim.mintAttemptedAt) : Number.NaN;
  if (!Number.isFinite(attemptedAt)) return null;
  const rows = await db
    .select({ id: companySecrets.id, createdAt: companySecrets.createdAt })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.key, DEFAULT_MCP_TEMPLATE_SECRET_KEY),
        eq(companySecrets.provider, "local_encrypted"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
        eq(companySecrets.description, secretDescription(claim.principalSub)),
        eq(companySecrets.createdByUserId, claim.ownerUserId),
      ),
    );
  const owned = rows.filter((row) => row.createdAt.getTime() >= attemptedAt - DEFAULT_MCP_TEMPLATE_ADOPT_SKEW_MS);
  return owned.length === 1 ? { id: owned[0]!.id } : null;
}

async function secretKeyTaken(db: Pick<Db, "select">, companyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.key, DEFAULT_MCP_TEMPLATE_SECRET_KEY),
        isNull(companySecrets.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type TemplateReadiness = "ok" | "expired" | "drift" | "version";

/**
 * Cheap, local check that a READY template still matches reality: unexpired token, usable vault secret,
 * active + enabled, exactly the one header credential, NO install rows and NO profile bindings. Never
 * calls anything external and never repairs anything.
 */
export async function verifyTemplateReady(
  db: Pick<Db, "select">,
  connection: Connection,
  options: { now?: Date; expectedAllowlistVersion?: number | null; allowedTools?: readonly string[] } = {},
): Promise<TemplateReadiness> {
  const claim = readTemplateClaim(connection.config);
  const now = options.now ?? new Date();
  if (!claim || claim.state !== "ready" || !isManagedTemplate(connection.config)) return "drift";
  if (!claim.tokenExpiresAt || !Number.isFinite(Date.parse(claim.tokenExpiresAt))) return "drift";
  if (Date.parse(claim.tokenExpiresAt) <= now.getTime()) return "expired";
  if (connection.status !== "active" || !connection.enabled) return "drift";
  const headers = (connection.credentialRefs ?? []).filter((ref) => ref.placement === "header");
  if (headers.length !== 1 || connection.credentialRefs.length !== 1 || headers[0]!.secretId !== claim.secretId) return "drift";
  if (!claim.secretId || !(await vaultSecretUsable(db, connection.companyId, claim.secretId))) return "drift";
  const installs = await db
    .select({ id: toolConnectionInstalls.id })
    .from(toolConnectionInstalls)
    .where(and(eq(toolConnectionInstalls.companyId, connection.companyId), eq(toolConnectionInstalls.connectionId, connection.id)))
    .limit(1);
  if (installs.length > 0) return "drift";
  const [profile] = await db
    .select({ id: toolProfiles.id })
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, connection.companyId), eq(toolProfiles.profileKey, `app:${connection.id}`)))
    .limit(1);
  if (!profile) return "drift";
  const bindings = await db
    .select({ id: toolProfileBindings.id })
    .from(toolProfileBindings)
    .where(and(eq(toolProfileBindings.companyId, connection.companyId), eq(toolProfileBindings.profileId, profile.id)))
    .limit(1);
  if (bindings.length > 0) return "drift";
  // A stale allowlist version is re-reviewed (never treated as drift): the review reconciles the catalog and profile.
  if (options.expectedAllowlistVersion != null && claim.allowlistVersion !== options.expectedAllowlistVersion) return "version";
  if (options.allowedTools) {
    // The template must expose EXACTLY the reviewed allowlist: no ACTIVE action outside it, and no profile entry
    // other than an include of an allowlisted action of this connection. Profile/catalog edits are refused by the
    // service guards; this catches anything that still got through (and is re-checked when an agent clone is made).
    const allow = new Set(options.allowedTools);
    const catalog = await db
      .select({ id: toolCatalogEntries.id, toolName: toolCatalogEntries.toolName, status: toolCatalogEntries.status })
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id)));
    if (catalog.some((row) => row.status === "active" && !allow.has(row.toolName))) return "drift";
    const byId = new Map(catalog.map((row) => [row.id, row]));
    const entries = await db
      .select({ selectorType: toolProfileEntries.selectorType, effect: toolProfileEntries.effect, catalogEntryId: toolProfileEntries.catalogEntryId })
      .from(toolProfileEntries)
      .where(and(eq(toolProfileEntries.companyId, connection.companyId), eq(toolProfileEntries.profileId, profile.id)));
    // A template that exposes nothing (an empty allowlist or an empty profile) is not a usable template.
    if (allow.size === 0 || entries.length === 0) return "drift";
    for (const entry of entries) {
      if (entry.selectorType !== "catalog_entry" || entry.effect !== "include" || !entry.catalogEntryId) return "drift";
      const target = byId.get(entry.catalogEntryId);
      if (!target || !allow.has(target.toolName)) return "drift";
    }
  }
  return "ok";
}

/**
 * Read-only usability of a managed template for the per-agent setup. Only a verified-ready template is
 * cloned; a template that is still provisioning, failed, expired or drifted yields a waiting reason and
 * is NEVER cloned.
 */
export async function managedTemplateUsability(
  db: Pick<Db, "select">,
  connection: Connection,
  options: { now?: Date; expectedAllowlistVersion?: number | null; allowedTools?: readonly string[] } = {},
): Promise<{ ok: true } | { ok: false; reason: DefaultMcpSetupReason }> {
  const claim = readTemplateClaim(connection.config);
  if (!claim) return { ok: false, reason: "template_failed" };
  if (claim.state === "pending" || claim.state === "in_progress") return { ok: false, reason: "template_provisioning" };
  if (claim.state === "error") {
    return { ok: false, reason: claim.reason === "template_expired" ? "template_expired" : "template_failed" };
  }
  const readiness = await verifyTemplateReady(db, connection, options);
  if (readiness === "ok") return { ok: true };
  if (readiness === "expired") return { ok: false, reason: "template_expired" };
  if (readiness === "version") return { ok: false, reason: "template_provisioning" };
  return { ok: false, reason: "template_failed" };
}

// ---------------------------------------------------------------------------
// L1: find / adopt / create
// ---------------------------------------------------------------------------

/** Mirrors the per-agent resolver's contract for an org-authored template. */
function isValidUserManagedTemplate(row: Connection): boolean {
  const header = (row.credentialRefs ?? []).find((ref) => ref.placement === "header");
  return row.status === "active" && row.authKind === "api_key" && row.transport === "mcp_remote" && Boolean(header);
}

type L1Result =
  | { kind: "row"; connection: Connection }
  | Exclude<CompanyTemplateOutcome, { kind: "ready" | "pending" | "error" | "not_claimed" }>;

async function ensureTemplateRow(
  ctx: DefaultMcpTemplateContext,
  entry: DefaultMcpEntrySpec,
  companyId: string,
  provisioner: CommsBoardProvisionerConfig,
  now: Date,
): Promise<L1Result> {
  const principalSub = composeTemplateSub(companyId);
  if (!principalSub) return { kind: "waiting", reason: "invalid_subject" };
  return ctx.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:template:" + companyId}, 0))`);
    const [company] = await txDb.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company) return { kind: "skipped", reason: "company_not_found" } as const;
    if (company.status !== "active" && company.status !== "paused") return { kind: "skipped", reason: "company_archived" } as const;

    const rows = await txDb
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          or(eq(toolConnections.uid, DEFAULT_MCP_TEMPLATE_UID), and(eq(toolConnections.name, entry.connectionName), ne(toolConnections.status, "archived"))),
        ),
      );
    const ours = rows.find((row) => row.uid === DEFAULT_MCP_TEMPLATE_UID);
    const sameName = rows.filter((row) => row.name === entry.connectionName && row.status !== "archived");
    if (ours) {
      // The reserved uid is ours only with the server marker and a valid claim; anything else fails closed.
      if (ours.status === "archived") return { kind: "revoked" } as const;
      if (!isManagedTemplate(ours.config) || !readTemplateClaim(ours.config)) {
        return { kind: "collision", reason: "template_unsupported" } as const;
      }
      // Our row is not exempt from the same-name rule: a second unarchived `rh-comms-board` makes the per-agent
      // template lookup ambiguous, so it is reported here too (nothing claimed, minted or modified).
      if (sameName.length > 1) return { kind: "collision", reason: "template_ambiguous" } as const;
      return { kind: "row", connection: ours } as const;
    }
    if (sameName.length > 1) return { kind: "collision", reason: "template_ambiguous" } as const;
    if (sameName.length === 1) {
      // Exactly one valid user-managed template is trusted unchanged: no writes, secrets, profiles, bindings or installs.
      return isValidUserManagedTemplate(sameName[0]!)
        ? ({ kind: "adopted" } as const)
        : ({ kind: "collision", reason: "template_unsupported" } as const);
    }

    const owner = await pickTemplateOwner(txDb, companyId);
    if (!owner) return { kind: "waiting", reason: "owner_required" } as const;

    const apps = await txDb
      .select()
      .from(toolApplications)
      .where(and(eq(toolApplications.companyId, companyId), or(eq(toolApplications.name, entry.connectionName), eq(toolApplications.applicationKey, entry.connectionName))));
    if (apps.length > 1) return { kind: "collision", reason: "template_ambiguous" } as const;
    let application = apps[0];
    if (application && (application.type !== "mcp_http" || application.status !== "active" || application.archivedAt)) {
      return { kind: "collision", reason: "template_unsupported" } as const;
    }
    if (!application) {
      await txDb
        .insert(toolApplications)
        .values({ companyId, applicationKey: entry.connectionName, name: entry.connectionName, type: "mcp_http", status: "active", metadata: {} })
        .onConflictDoNothing();
      [application] = await txDb
        .select()
        .from(toolApplications)
        .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.name, entry.connectionName)))
        .limit(1);
      if (!application || application.type !== "mcp_http") return { kind: "collision", reason: "template_unsupported" } as const;
    }

    const claim: DefaultMcpTemplateClaim = {
      version: 1,
      entryKey: entry.key,
      principalSub,
      ownerUserId: owner.userId,
      ownerEmailNorm: owner.emailNorm,
      state: "pending",
      reason: null,
      attemptCount: 0,
      nextAttemptAt: null,
      leaseUntil: null,
      claimId: null,
      mintAttemptedAt: null,
      secretId: null,
      tokenExpiresAt: null,
      allowlistVersion: null,
      readyAt: null,
      updatedAt: now.toISOString(),
    };
    const endpoint = { url: provisioner.boardMcpUrl, mcpSessionRequired: true, quarantineNewEntries: true };
    const [created] = await txDb
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: entry.connectionName,
        uid: DEFAULT_MCP_TEMPLATE_UID,
        connectionKind: "managed",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "draft",
        enabled: false,
        config: { ...endpoint, [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "template", [DEFAULT_MCP_TEMPLATE_CONFIG_KEY]: claim },
        transportConfig: { ...endpoint },
        credentialRefs: [],
        credentialSecretRefs: [],
      })
      .onConflictDoNothing()
      .returning();
    if (!created) return { kind: "collision", reason: "template_unsupported" } as const;
    return { kind: "row", connection: created } as const;
  });
}

// ---------------------------------------------------------------------------
// Stages under a claim
// ---------------------------------------------------------------------------

type StageResult =
  | { kind: "ready" }
  | { kind: "waiting"; reason: DefaultMcpSetupReason }
  | { kind: "retry"; reason: DefaultMcpSetupReason }
  | { kind: "error"; reason: DefaultMcpSetupReason };

const TEMPLATE_ACTOR = { actorType: "system", actorId: "default-mcp-template" } as const;

/** L3: apply the reviewed allowlist, reconcile the default-deny profile, activate. One local transaction. */
async function applyReviewedAllowlist(
  ctx: DefaultMcpTemplateContext,
  entry: DefaultMcpEntrySpec,
  connection: Connection,
  claimId: string,
  now: Date,
): Promise<StageResult> {
  const reviewed = entry.reviewedTools!;
  const allow = new Set(reviewed.allow);
  return ctx.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:template:" + connection.companyId}, 0))`);
    // The claim is re-checked inside the locked transaction: a stale worker mutates nothing.
    // Row lock (FOR UPDATE), not only the advisory lock: archiving goes through plain UPDATEs that never take the
    // advisory lock. Holding the row serializes activation against archive: an archive that already committed is
    // seen here (the worker loses its claim), and one that arrives later waits for this commit and then wins.
    const [fresh] = await txDb.select().from(toolConnections).where(eq(toolConnections.id, connection.id)).limit(1).for("update");
    const freshClaim = fresh ? readTemplateClaim(fresh.config) : null;
    if (!fresh || fresh.status === "archived" || !isManagedTemplate(fresh.config) || freshClaim?.claimId !== claimId || freshClaim.state !== "in_progress") {
      throw new ClaimLostError();
    }

    // Drift (an install row or a profile binding) is reported, never auto-deleted: those are user grants.
    const installs = await txDb
      .select({ id: toolConnectionInstalls.id })
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, fresh.companyId), eq(toolConnectionInstalls.connectionId, fresh.id)))
      .limit(1);
    const [existingProfile] = await txDb
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, fresh.companyId), eq(toolProfiles.profileKey, `app:${fresh.id}`)))
      .limit(1);
    const bindings = existingProfile
      ? await txDb
          .select({ id: toolProfileBindings.id })
          .from(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, fresh.companyId), eq(toolProfileBindings.profileId, existingProfile.id)))
          .limit(1)
      : [];
    if (installs.length > 0 || bindings.length > 0) return { kind: "error", reason: "template_drift" } as StageResult;

    const catalog = await txDb
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, fresh.companyId), eq(toolCatalogEntries.connectionId, fresh.id)));
    const allowed = catalog.filter((row) => row.entryKind === "tool" && allow.has(row.toolName));
    const rest = catalog.filter((row) => !allowed.includes(row));
    if (rest.length > 0) {
      await txDb
        .update(toolCatalogEntries)
        .set({ status: "disabled", quarantinedAt: null, quarantineReason: null, updatedAt: now })
        .where(inArray(toolCatalogEntries.id, rest.map((row) => row.id)));
    }
    if (allowed.length === 0) return { kind: "waiting", reason: "catalog_unreviewed" } as StageResult;
    await txDb
      .update(toolCatalogEntries)
      .set({ status: "active", reviewedAt: now, quarantinedAt: null, quarantineReason: null, updatedAt: now })
      .where(inArray(toolCatalogEntries.id, allowed.map((row) => row.id)));

    // Default-deny profile that offers the allowlisted actions only. NO bindings are ever created here.
    const profileMetadata = { source: "app_gallery_finish", connectionId: fresh.id, managedTemplate: true };
    let profile = existingProfile;
    if (!profile) {
      const [sameName] = await txDb
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, fresh.companyId), eq(toolProfiles.name, fresh.name)))
        .limit(1);
      [profile] = await txDb
        .insert(toolProfiles)
        .values({
          companyId: fresh.companyId,
          profileKey: `app:${fresh.id}`,
          name: sameName ? `${fresh.name} (${fresh.id.replace(/-/g, "").slice(0, 8)})` : fresh.name,
          description: `Access profile for ${fresh.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: profileMetadata,
        })
        .returning();
    } else {
      [profile] = await txDb
        .update(toolProfiles)
        .set({ status: "active", defaultAction: "deny", metadata: profileMetadata, updatedAt: now })
        .where(eq(toolProfiles.id, profile.id))
        .returning();
    }
    const wantedIds = new Set(allowed.map((row) => row.id));
    const entries = await txDb.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
    const stale = entries.filter((row) => !(row.selectorType === "catalog_entry" && row.effect === "include" && row.catalogEntryId && wantedIds.has(row.catalogEntryId)));
    if (stale.length > 0) {
      await txDb.delete(toolProfileEntries).where(inArray(toolProfileEntries.id, stale.map((row) => row.id)));
    }
    const have = new Set(entries.filter((row) => !stale.includes(row)).map((row) => row.catalogEntryId));
    for (const row of allowed) {
      if (have.has(row.id)) continue;
      await txDb.insert(toolProfileEntries).values({
        companyId: fresh.companyId,
        profileId: profile!.id,
        selectorType: "catalog_entry",
        effect: "include",
        applicationId: fresh.applicationId,
        connectionId: fresh.id,
        catalogEntryId: row.id,
      });
    }

    const patch: ClaimPatch = { allowlistVersion: reviewed.version, updatedAt: now.toISOString() };
    const ok = await patchUnderClaim(txDb, fresh.id, claimId, patch, { status: "active", enabled: true, healthStatus: "ok" });
    if (!ok) throw new ClaimLostError();
    return { kind: "ready" } as StageResult;
  });
}

async function provisionTemplate(
  ctx: DefaultMcpTemplateContext,
  entry: DefaultMcpEntrySpec,
  provisioner: CommsBoardProvisionerConfig,
  connectionId: string,
  initial: DefaultMcpTemplateClaim,
): Promise<StageResult> {
  const { db } = ctx;
  const now = () => ctx.now?.() ?? new Date();
  const claimId = initial.claimId!;
  let claim = initial;
  const checkpoint = async (patch: ClaimPatch, tx?: Pick<Db, "update">) => {
    const full = { ...patch, updatedAt: now().toISOString() };
    if (!(await patchUnderClaim(tx ?? db, connectionId, claimId, full))) throw new ClaimLostError();
    claim = { ...claim, ...full } as DefaultMcpTemplateClaim;
  };
  const reload = async () => {
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1);
    if (!row || row.status === "archived" || !isManagedTemplate(row.config)) throw new ClaimLostError();
    return row;
  };
  const companyId = (await reload()).companyId;

  // ---- Mint: the only external write. Nothing that can be missing is left to discover after the POST. ----
  if (!claim.secretId) {
    if (claim.mintAttemptedAt) {
      // A checkpoint without its result: adopt only a provably-owned stored secret, else the outcome is unknown.
      const adopted = await findOwnedTemplateSecret(db, companyId, claim);
      if (!adopted) return { kind: "error", reason: "mint_unknown" };
      // The reply that carried the real expiry was lost: use the conservative lower bound (attempt + TTL).
      const bound = new Date(Date.parse(claim.mintAttemptedAt) + TEMPLATE_TOKEN_TTL_DAYS * 86_400_000).toISOString();
      await checkpoint({ secretId: adopted.id, tokenExpiresAt: bound });
    } else {
      // The owner is frozen before the FIRST mint attempt; until then a lost owner is re-picked.
      if (!(await frozenOwnerStillEligible(db, companyId, claim))) {
        const owner = await pickTemplateOwner(db, companyId);
        if (!owner) return { kind: "waiting", reason: "owner_required" };
        await checkpoint({ ownerUserId: owner.userId, ownerEmailNorm: owner.emailNorm });
      }
      // A taken deterministic key would lose the token after a successful mint: refuse BEFORE minting.
      if (await secretKeyTaken(db, companyId)) return { kind: "error", reason: "secret_store_failed" };

      await checkpoint({ mintAttemptedAt: now().toISOString() });
      const minted = await mintCommsBoardTemplateCredential(
        provisioner,
        { companyId, ownerEmail: claim.ownerEmailNorm },
        ctx.fetchImpl ?? fetch,
      );
      if (!minted.ok) {
        if (minted.noRowCreated) {
          // Definitive refusal of a locally validated request: no registry row exists, so the attempt is cleared.
          await checkpoint({ mintAttemptedAt: null });
          return { kind: "retry", reason: minted.reason };
        }
        // 409, any 5xx, a network failure or a contradictory reply: unknown or conflicting. Never rotated or retried.
        return { kind: "error", reason: minted.reason };
      }
      let secretId: string;
      try {
        const secret = await secretService(db).create(
          companyId,
          {
            name: `Comms Board template token (company ${companyId})`,
            key: DEFAULT_MCP_TEMPLATE_SECRET_KEY,
            provider: "local_encrypted",
            value: minted.boardToken,
            description: secretDescription(claim.principalSub),
          },
          { userId: claim.ownerUserId },
        );
        secretId = secret.id;
      } catch {
        // The token cannot be fetched again; the checkpoint stays so the orphan row is identifiable.
        return { kind: "error", reason: "secret_store_failed" };
      }
      await checkpoint({ secretId, tokenExpiresAt: minted.tokenExpiresAt });
    }
  }
  if (!claim.secretId || !(await vaultSecretUsable(db, companyId, claim.secretId))) {
    return { kind: "error", reason: "secret_unavailable" };
  }

  // ---- L2: header credential + bindings, still DRAFT. One local, idempotent transaction. ----
  const secretId = claim.secretId;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:template:" + companyId}, 0))`);
    const [row] = await txDb.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1).for("update");
    if (!row || row.status === "archived" || !isManagedTemplate(row.config)) throw new ClaimLostError();
    const ref = { name: "credentials.authorization", secretId, version: "latest" as const, placement: "header" as const, key: "Authorization", prefix: "Bearer " };
    const current = row.credentialRefs ?? [];
    const intact = current.length === 1 && current[0]!.secretId === secretId && current[0]!.placement === "header";
    const credentialRefs = intact ? current : [ref];
    if (!(await patchUnderClaim(txDb, connectionId, claimId, { updatedAt: now().toISOString() }, { credentialRefs }))) throw new ClaimLostError();
    const [updated] = await txDb.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).limit(1);
    await syncConnectionCredentialBindings(txDb, updated!);
  });

  // ---- Discovery: OUTSIDE any transaction. The existing refresh; the template is a managed, draft row. ----
  const beforeDiscovery = await reload();
  if (readTemplateClaim(beforeDiscovery.config)?.claimId !== claimId) throw new ClaimLostError();
  try {
    await toolAccessService(db, ctx.toolAccessOptions ?? runtimeToolAccessOptions).refreshCatalog(connectionId, TEMPLATE_ACTOR, {
      skipDefaultProfileSync: true,
    });
  } catch {
    return { kind: "retry", reason: "template_discovery_failed" };
  }

  // ---- L3: reviewed allowlist, default-deny profile with NO bindings, then activation. ----
  const afterDiscovery = await reload();
  return applyReviewedAllowlist(ctx, entry, afterDiscovery, claimId, now());
}

// ---------------------------------------------------------------------------
// Deferral (in-process spacing for outcomes that leave no durable state)
// ---------------------------------------------------------------------------

const deferred = new Map<string, { until: number; attempts: number }>();

function deferCompany(companyId: string, now: Date) {
  if (deferred.size >= MAX_DEFERRED) deferred.clear();
  const attempts = (deferred.get(companyId)?.attempts ?? 0) + 1;
  const delay = Math.min(DEFAULT_MCP_TEMPLATE_DEFER_BASE_MS * 2 ** (attempts - 1), DEFAULT_MCP_TEMPLATE_DEFER_MAX_MS);
  deferred.set(companyId, { until: now.getTime() + delay, attempts });
}

function deferredCompanyIds(now: Date): string[] {
  const ids: string[] = [];
  for (const [id, entry] of deferred) {
    // An expired entry stays (its attempt count drives the next, longer delay) but no longer excludes the company.
    if (entry.until > now.getTime()) ids.push(id);
  }
  return ids;
}

function clearDeferral(companyId: string) {
  deferred.delete(companyId);
}

export function __resetCompanyTemplateDeferralsForTests(): void {
  deferred.clear();
}

// ---------------------------------------------------------------------------
// Ensure (one company)
// ---------------------------------------------------------------------------

/**
 * Nudges (path-only `nextAttemptAt`, nothing else) every NEW agent of the company whose comms entry is
 * waiting on the template, so the next sweep picks it up immediately instead of after its backoff.
 */
async function nudgeWaitingAgents(db: Pick<Db, "execute">, companyId: string, entryKey: string, now: Date): Promise<void> {
  const path = sql`ARRAY[${DEFAULT_MCP_METADATA_KEY}::text, 'entries'::text, ${entryKey}::text, 'setup'::text, 'nextAttemptAt'::text]`;
  const statePath = sql`ARRAY[${DEFAULT_MCP_METADATA_KEY}::text, 'entries'::text, ${entryKey}::text, 'setup'::text, 'state'::text]`;
  const reasonPath = sql`ARRAY[${DEFAULT_MCP_METADATA_KEY}::text, 'entries'::text, ${entryKey}::text, 'setup'::text, 'reason'::text]`;
  await db.execute(sql`
    update ${agents}
    set metadata = jsonb_set(metadata, ${path}, to_jsonb(${now.toISOString()}::text), false)
    where company_id = ${companyId}
      and status not in ('pending_approval', 'terminated')
      and jsonb_typeof(metadata -> ${DEFAULT_MCP_METADATA_KEY}) = 'object'
      and metadata #>> ${statePath} = 'pending'
      and metadata #>> ${reasonPath} in ('template_not_found', 'template_provisioning', 'template_unsupported', 'template_ambiguous')
  `);
}

export async function ensureCompanyTemplate(
  ctx: DefaultMcpTemplateContext,
  input: { companyId: string },
): Promise<CompanyTemplateOutcome> {
  const env = ctx.env ?? process.env;
  const now = ctx.now?.() ?? new Date();
  const skip = (reason: CompanyTemplateSkipReason): CompanyTemplateOutcome => ({ kind: "skipped", reason });
  if (!isDefaultMcpSpecEnabled(env)) return skip("feature_disabled");
  const scope = ctx.scope ?? readDefaultMcpTemplateScope();
  if (!isCompanyInDefaultMcpTemplateScope(scope, input.companyId)) return skip("out_of_scope");
  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const entry = spec.find((candidate) => candidate.templateBootstrap && candidate.setupHook && candidate.reviewedTools);
  if (!entry) return skip("no_bootstrap_entry");
  // Both frozen configurations must be valid before anything is read or written for the company.
  const resolved = resolveCommsBoardProvisionerConfig(ctx.env);
  if (!resolved.ok) return skip(resolved.reason);
  const provisioner = resolved.config;

  const l1 = await ensureTemplateRow(ctx, entry, input.companyId, provisioner, now);
  if (l1.kind !== "row") {
    if (l1.kind === "waiting" || l1.kind === "collision") deferCompany(input.companyId, now);
    else clearDeferral(input.companyId);
    return l1;
  }
  clearDeferral(input.companyId);

  let connection = l1.connection;
  let claim = readTemplateClaim(connection.config)!;
  if (claim.state === "ready") {
    const readiness = await verifyTemplateReady(ctx.db, connection, {
      now,
      expectedAllowlistVersion: entry.reviewedTools!.version,
      allowedTools: entry.reviewedTools!.allow,
    });
    if (readiness === "ok") return { kind: "ready" };
    // Expired or drifted: terminal, never silently re-issued. A newer reviewed allowlist re-runs discovery + L3 only.
    if (readiness === "version") {
      await patchIfState(ctx.db, connection.id, "ready", { state: "pending", reason: null, nextAttemptAt: null, updatedAt: now.toISOString() });
    } else {
      const reason: DefaultMcpSetupReason = readiness === "expired" ? "template_expired" : "template_drift";
      await patchIfState(ctx.db, connection.id, "ready", { state: "error", reason, updatedAt: now.toISOString() });
      await logTemplateActivity(ctx.db, input.companyId, connection, { state: "error", reason, attemptCount: claim.attemptCount });
      return { kind: "error", reason };
    }
  } else if (claim.state === "error") {
    return { kind: "error", reason: claim.reason ?? "template_failed" };
  }

  const claimed = await claimTemplate(ctx.db, connection.id, now);
  if (!claimed) return { kind: "not_claimed" };
  claim = claimed;
  connection = (await ctx.db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)).limit(1))[0] ?? connection;

  let result: StageResult;
  try {
    result = await provisionTemplate(ctx, entry, provisioner, connection.id, claim);
  } catch (err) {
    if (err instanceof ClaimLostError) return { kind: "not_claimed" };
    // Only the error class is logged: never a message, URL, header or body.
    logger.warn(
      { companyId: input.companyId, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "default MCP template provisioning stage failed",
    );
    result = { kind: "retry", reason: "provisioner_failed" };
  }

  const finished = ctx.now?.() ?? new Date();
  const [latest] = await ctx.db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)).limit(1);
  const attempts = (latest ? readTemplateClaim(latest.config)?.attemptCount : null) ?? claim.attemptCount;
  let state: DefaultMcpTemplateClaim["state"];
  let nextAttemptAt: string | null = null;
  const reason = result.kind === "ready" ? null : result.reason;
  if (result.kind === "ready") state = "ready";
  else if (result.kind === "waiting") {
    state = "pending";
    nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
  } else if (result.kind === "retry") {
    if (attempts >= DEFAULT_MCP_MAX_ATTEMPTS) state = "error";
    else {
      state = "pending";
      nextAttemptAt = new Date(finished.getTime() + defaultMcpBackoffMs(attempts)).toISOString();
    }
  } else state = "error";

  const stored = await patchUnderClaim(ctx.db, connection.id, claim.claimId!, {
    state,
    reason,
    nextAttemptAt,
    leaseUntil: null,
    claimId: null,
    readyAt: state === "ready" ? finished.toISOString() : null,
    updatedAt: finished.toISOString(),
  });
  if (!stored) return { kind: "not_claimed" };
  await logTemplateActivity(ctx.db, input.companyId, connection, { state, reason, attemptCount: attempts });
  if (state === "ready") {
    await nudgeWaitingAgents(ctx.db, input.companyId, entry.key, finished);
    return { kind: "ready" };
  }
  if (state === "error") return { kind: "error", reason: reason! };
  return { kind: "pending", reason };
}

async function logTemplateActivity(
  db: Db,
  companyId: string,
  connection: Connection,
  details: { state: string; reason: DefaultMcpSetupReason | null; attemptCount: number },
) {
  try {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "default-mcp-template",
      action: "company.default_mcp_template",
      entityType: "company",
      entityId: companyId,
      // Non-secret facts only: ids, closed state/reason codes. Never a token, header or upstream text.
      details: { connectionId: connection.id, ...details },
    });
  } catch (err) {
    logger.warn({ companyId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP template activity log failed");
  }
}

// ---------------------------------------------------------------------------
// Durable sweep + non-blocking scheduling
// ---------------------------------------------------------------------------

/**
 * One tick: companies (active or paused, never archived, in scope) that have no template at all or whose
 * managed claim is pending and due / in progress with an expired lease. Ready, errored, revoked, adopted
 * and collided companies are skipped. Never touches an agent.
 */
export async function sweepCompanyTemplates(ctx: DefaultMcpTemplateContext & { limit?: number }): Promise<number> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return 0;
  const scope = ctx.scope ?? readDefaultMcpTemplateScope();
  if (scope.mode === "none") return 0;
  // An injected allowlist with no ids selects nothing (and must never render an invalid `in ()`).
  if (scope.mode === "allowlist" && scope.companyIds.length === 0) return 0;
  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const entry = spec.find((candidate) => candidate.templateBootstrap && candidate.setupHook && candidate.reviewedTools);
  if (!entry) return 0;
  if (!resolveCommsBoardProvisionerConfig(ctx.env).ok) return 0;

  const nowDate = ctx.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const scopeSql: SQL =
    scope.mode === "allowlist"
      ? sql`and c.id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  const skipped = deferredCompanyIds(nowDate);
  const skipSql: SQL = skipped.length > 0 ? sql`and c.id::text not in (${sql.join(skipped.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const claimJson = sql`t.config -> ${DEFAULT_MCP_TEMPLATE_CONFIG_KEY}`;
  const result: unknown = await ctx.db.execute(sql`
    select c.id as id
    from companies c
    where c.status in ('active', 'paused')
      ${scopeSql}
      ${skipSql}
      and (
        not exists (
          select 1 from tool_connections t
          where t.company_id = c.id
            and (t.uid = ${DEFAULT_MCP_TEMPLATE_UID} or (t.name = ${entry.connectionName} and t.status <> 'archived'))
        )
        or exists (
          select 1 from tool_connections t
          where t.company_id = c.id
            and t.uid = ${DEFAULT_MCP_TEMPLATE_UID}
            and t.status <> 'archived'
            and t.config ->> ${DEFAULT_MCP_MANAGED_CONFIG_KEY} = 'template'
            and jsonb_typeof(${claimJson}) = 'object'
            and (
              (${claimJson} ->> 'state' = 'pending'
                and coalesce(${claimJson} ->> 'nextAttemptAt', '') COLLATE "C" <= ${now}::text COLLATE "C")
              or (${claimJson} ->> 'state' = 'in_progress'
                and coalesce(${claimJson} ->> 'leaseUntil', '') COLLATE "C" <= ${now}::text COLLATE "C")
              -- A READY template reviewed under an older allowlist version: ensure re-runs discovery + review only
              -- (no new mint) and republishes it, so agents waiting on template_provisioning are not stuck forever.
              or (${claimJson} ->> 'state' = 'ready'
                and coalesce(${claimJson} ->> 'allowlistVersion', '') <> ${String(entry.reviewedTools!.version)})
            )
        )
      )
    order by c.created_at asc
    limit ${ctx.limit ?? DEFAULT_MCP_TEMPLATE_SWEEP_LIMIT}
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>;
  for (const row of rows) {
    try {
      await ensureCompanyTemplate(ctx, { companyId: row.id });
    } catch (err) {
      logger.warn({ companyId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP template sweep item failed");
    }
  }
  return rows.length;
}

const inFlight = new Set<Promise<unknown>>();

/** Fire-and-observe: kicks the ensure after the create/reactivate commit without blocking the request. */
export function scheduleCompanyTemplateEnsure(
  db: Db,
  input: { companyId: string },
  ctx: Omit<DefaultMcpTemplateContext, "db"> = {},
): void {
  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      ensureCompanyTemplate({ db, ...ctx }, input)
        .catch((err) =>
          logger.warn({ companyId: input.companyId, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP template ensure failed"),
        )
        .finally(resolve);
    });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Test seam: resolves once every scheduled template ensure has finished. */
export async function waitForScheduledCompanyTemplates(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
