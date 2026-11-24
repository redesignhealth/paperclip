/**
 * Operator-triggered restore of a company's ARCHIVED managed comms-board template.
 *
 * An operator archive of the managed template is terminal by design: the sweep reads it as "revoked" and never
 * recreates it, and the connection update API refuses to touch a managed template except to archive it. A company
 * can therefore end up with no usable template (new agents wait with `template_not_found` / `template_unsupported`)
 * although the template's board credential is still valid.
 *
 * A real run puts the SAME row back in the provisioning pipeline: status archived -> draft, claim -> pending with a
 * fresh attempt budget, header credential refs cleared (the review rebuilds them from the claim's own vault secret).
 * The stored secret, the board principal, the owner and the token expiry are kept, so no token is minted and nothing
 * is written to the board. The normal template review then re-runs discovery and the reviewed allowlist, publishes
 * the template at the current version, and wakes agents that wait on it.
 *
 * It never changes an agent, an agent's connection, grant, secret or board identity (it only reads each agent's comms-board
 * entry to refuse when one points at the template row). It refuses, and reports why, when the preconditions do not hold
 * (see `CommsTemplateReprovisionResult`). Undo: archive the template again; that stops the template, but does not undo
 * what the review did meanwhile for waiting agents (their own connections, credentials and secrets).
 *
 * The report carries ids, counts and closed reason codes only.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  agents,
  companies,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { resolveCommsBoardProvisionerConfig } from "./comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_SPEC,
  DEFAULT_MCP_TEMPLATE_CONFIG_KEY,
  DEFAULT_MCP_TEMPLATE_UID,
  isDefaultMcpSpecEnabled,
  isManagedTemplate,
  readDefaultMcpState,
  readTemplateClaim,
} from "./default-mcp-spec.js";
import { scheduleCompanyTemplateEnsure, vaultSecretUsable, type DefaultMcpTemplateContext } from "./default-mcp-template.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";

export const COMMS_TEMPLATE_REPROVISION_ENTRY_KEY = "comms-board";
/** A real run must carry this exact string; it is a typo guard, not a secret. */
export const COMMS_TEMPLATE_REPROVISION_CONFIRMATION = "reprovision-comms-board-template";

export type CommsTemplateReprovisionResult =
  | "would_restore"
  | "restored"
  | "refused_feature_disabled"
  | "refused_out_of_scope"
  | "refused_company_inactive"
  | "refused_no_template"
  | "refused_template_not_archived"
  | "refused_template_invalid"
  | "refused_competing_template"
  | "refused_secret_unavailable"
  | "refused_token_expired"
  | "refused_template_in_use"
  | "refused_agent_bound_to_template";

export interface CommsTemplateReprovisionReport {
  dryRun: boolean;
  companyId: string;
  result: CommsTemplateReprovisionResult;
  /** The archived managed template (ids and closed facts only). */
  template?: { id: string; status: string; allowlistVersion: number | null; tokenExpiresAt: string | null };
  /** Non-archived connections that share the template's name; the operator must rename or retire them first. */
  competing?: Array<{ id: string; name: string; status: string; authKind: string }>;
  /** Agents (by id) whose comms-board entry points at the template row itself; a restore would move them. */
  boundAgents?: string[];
  /** What a restore does to the row, in plain terms. Present on `would_restore` and `restored`. */
  changes?: string[];
  /** How many agents have a comms-board entry. None of them is changed by this action. */
  agentsLeftUntouched: number;
}

export class CommsTemplateReprovisionConfirmationError extends Error {
  constructor() {
    super("A real run requires dryRun=false and the exact confirmation string");
  }
}

export class CommsTemplateReprovisionInProgressError extends Error {
  constructor() {
    super("A reprovision run is already in progress for this company");
  }
}

const running = new Set<string>();

type Reader = Pick<Db, "select" | "execute">;

function commsSpec() {
  const spec = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === COMMS_TEMPLATE_REPROVISION_ENTRY_KEY);
  if (!spec?.reviewedTools) throw new Error("comms-board spec has no reviewed allowlist");
  return spec;
}

const CHANGES = [
  "template connection: archived -> draft (same row, same secret, same board principal); its application is made active again if archiving the template archived it",
  "template claim: pending, attempt budget reset, allowlist version cleared so the review re-runs",
  "template header credential refs: cleared, rebuilt by the review from the stored secret",
  "no token is minted, nothing is written to the board, no agent connection, grant, secret or board identity is touched",
];

/** Read-only evaluation of every precondition. Never writes. */
async function inspect(
  db: Reader,
  companyId: string,
  ctx: Omit<DefaultMcpTemplateContext, "db">,
  now: Date,
): Promise<{ report: CommsTemplateReprovisionReport; templateId: string | null }> {
  const spec = commsSpec();
  const env = ctx.env ?? process.env;
  const base = (result: CommsTemplateReprovisionResult, extra: Partial<CommsTemplateReprovisionReport> = {}, templateId: string | null = null) => ({
    report: { dryRun: true, companyId, result, agentsLeftUntouched: 0, ...extra } as CommsTemplateReprovisionReport,
    templateId,
  });

  if (!isDefaultMcpSpecEnabled(env) || !resolveCommsBoardProvisionerConfig(ctx.env).ok) return base("refused_feature_disabled");
  const scope = ctx.scope ?? readDefaultMcpTemplateScope();
  if (!isCompanyInDefaultMcpTemplateScope(scope, companyId)) return base("refused_out_of_scope");
  const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company || (company.status !== "active" && company.status !== "paused")) return base("refused_company_inactive");

  const agentRows = await db.select({ id: agents.id, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId));
  let withEntry = 0;
  const entries = new Map<string, { connectionId: string | null; bindingConnectionId: string | null }>();
  for (const row of agentRows) {
    const entry = readDefaultMcpState(row.metadata)?.entries[COMMS_TEMPLATE_REPROVISION_ENTRY_KEY];
    if (!entry) continue;
    withEntry += 1;
    entries.set(row.id, { connectionId: entry.connectionId ?? null, bindingConnectionId: entry.binding?.connectionId ?? null });
  }

  const rows = await db
    .select()
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, companyId),
        or(eq(toolConnections.uid, DEFAULT_MCP_TEMPLATE_UID), and(eq(toolConnections.name, spec.connectionName), ne(toolConnections.status, "archived"))),
      ),
    );
  const ours = rows.find((row) => row.uid === DEFAULT_MCP_TEMPLATE_UID);
  const competing = rows
    .filter((row) => row.id !== ours?.id && row.name === spec.connectionName && row.status !== "archived")
    .map((row) => ({ id: row.id, name: row.name, status: row.status, authKind: row.authKind }));
  if (!ours) return base("refused_no_template", { agentsLeftUntouched: withEntry, ...(competing.length > 0 ? { competing } : {}) });

  const claim = readTemplateClaim(ours.config);
  const template = { id: ours.id, status: ours.status, allowlistVersion: claim?.allowlistVersion ?? null, tokenExpiresAt: claim?.tokenExpiresAt ?? null };
  const refuse = (result: CommsTemplateReprovisionResult, extra: Partial<CommsTemplateReprovisionReport> = {}) =>
    base(result, { template, agentsLeftUntouched: withEntry, ...(competing.length > 0 ? { competing } : {}), ...extra }, ours.id);

  if (ours.status !== "archived") return refuse("refused_template_not_archived");
  if (!isManagedTemplate(ours.config) || !claim) return refuse("refused_template_invalid");
  if (!claim.secretId || !claim.tokenExpiresAt || !Number.isFinite(Date.parse(claim.tokenExpiresAt))) return refuse("refused_secret_unavailable");
  if (Date.parse(claim.tokenExpiresAt) <= now.getTime()) return refuse("refused_token_expired");
  if (!(await vaultSecretUsable(db, companyId, claim.secretId))) return refuse("refused_secret_unavailable");
  if (competing.length > 0) return refuse("refused_competing_template");

  const boundAgents = [...entries.entries()]
    .filter(([, entry]) => entry.connectionId === ours.id || entry.bindingConnectionId === ours.id)
    .map(([id]) => id);
  if (boundAgents.length > 0) return refuse("refused_agent_bound_to_template", { boundAgents });

  const installs = await db
    .select({ id: toolConnectionInstalls.id })
    .from(toolConnectionInstalls)
    .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.connectionId, ours.id)))
    .limit(1);
  const profiles = await db
    .select({ id: toolProfiles.id })
    .from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${ours.id}`)));
  const bindings =
    profiles.length > 0
      ? await db
          .select({ id: toolProfileBindings.id })
          .from(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, companyId), inArray(toolProfileBindings.profileId, profiles.map((p) => p.id))))
          .limit(1)
      : [];
  if (installs.length > 0 || bindings.length > 0) return refuse("refused_template_in_use");

  return refuse("would_restore", { changes: CHANGES });
}

export async function reprovisionCommsTemplate(
  db: Db,
  options: { companyId: string; dryRun?: boolean; confirm?: string; actorId?: string },
  ctx: Omit<DefaultMcpTemplateContext, "db"> = {},
): Promise<CommsTemplateReprovisionReport> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== COMMS_TEMPLATE_REPROVISION_CONFIRMATION) throw new CommsTemplateReprovisionConfirmationError();
  const now = ctx.now?.() ?? new Date();
  if (dryRun) {
    const { report } = await inspect(db, options.companyId, ctx, now);
    return { ...report, dryRun: true };
  }
  if (running.has(options.companyId)) throw new CommsTemplateReprovisionInProgressError();
  running.add(options.companyId);
  try {
    const report = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // The same lock the template review takes, so a restore never interleaves with a sweep for this company.
      await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:template:" + options.companyId}, 0))`);
      const { report: checked, templateId } = await inspect(txDb, options.companyId, ctx, now);
      if (checked.result !== "would_restore" || !templateId) return { ...checked, dryRun: false };
      const [row] = await txDb.select().from(toolConnections).where(eq(toolConnections.id, templateId)).limit(1).for("update");
      const claim = row ? readTemplateClaim(row.config) : null;
      if (!row || row.status !== "archived" || !claim) return { ...checked, dryRun: false, result: "refused_template_invalid" as const };
      const nowIso = now.toISOString();
      const restoredClaim = {
        ...claim,
        state: "pending",
        reason: null,
        attemptCount: 0,
        nextAttemptAt: null,
        leaseUntil: null,
        claimId: null,
        readyAt: null,
        allowlistVersion: null,
        missingReviewedTools: null,
        missingCheckAt: null,
        updatedAt: nowIso,
      };
      // Archiving the last connection of an application archives the application too: put it back, or the review
      // (which only reads the template row) would publish a template whose application is still archived.
      await txDb
        .update(toolApplications)
        .set({ status: "active", archivedAt: null, updatedAt: now })
        .where(and(eq(toolApplications.id, row.applicationId), eq(toolApplications.companyId, options.companyId), eq(toolApplications.status, "archived")));
      await txDb
        .update(toolConnections)
        .set({
          status: "draft",
          enabled: false,
          credentialRefs: [],
          config: { ...(row.config as Record<string, unknown>), [DEFAULT_MCP_TEMPLATE_CONFIG_KEY]: restoredClaim },
          updatedAt: now,
        })
        .where(eq(toolConnections.id, row.id));
      await logActivity(txDb, {
        companyId: options.companyId,
        actorType: "user",
        actorId: options.actorId ?? "board",
        action: "company.default_mcp_template_reprovisioned",
        entityType: "company",
        entityId: options.companyId,
        // Ids and closed facts only.
        details: { connectionId: row.id, from: "archived", to: "draft", allowlistVersionBefore: claim.allowlistVersion ?? null },
      });
      return { ...checked, dryRun: false, result: "restored" as const, template: { ...checked.template!, status: "draft" } };
    });
    if (report.result === "restored") scheduleCompanyTemplateEnsure(db, { companyId: options.companyId }, ctx);
    return report;
  } finally {
    running.delete(options.companyId);
  }
}
