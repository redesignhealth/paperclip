/**
 * Static-catalog company template bootstrap (TECH-7253).
 *
 * The comms-board bootstrap (`default-mcp-template.ts`) discovers an MCP's tools with a company-scoped credential.
 * Arcana has no company-level credential: exchange keys are per agent and each resolves to exactly one brain.
 * So for an entry that declares `templateBootstrap: "static"` Paperclip creates the company's read-only
 * template connection itself and seeds its catalog directly with the entry's reviewed verbs. Nothing here ever
 * contacts the MCP, mints a credential or reads an agent.
 *
 * The template is deliberately NOT a "managed template" (that marker belongs to the comms claim machinery): it is
 * an ordinary active, api-key, `mcp_remote` connection carrying one header credential ref, which is exactly what
 * the per-agent resolver already accepts from an operator-authored template. It is identified as ours only by its
 * fixed, unforgeable uid. The header ref points at a placeholder vault secret holding a random value that
 * authorizes nothing; every agent's dedicated clone re-points the ref at the agent's own exchange-key secret.
 *
 * Idempotent and conflict-safe: one advisory lock per company, an existing same-named connection that is not ours
 * is adopted unchanged, an archived template of ours is never recreated, and drift in our catalog is only ever
 * narrowed (anything outside the reviewed verbs is disabled).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  companies,
  companySecrets,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { resolveArcanaMcpUrl } from "./arcana-provisioner-client.js";
import {
  ARCANA_STATIC_TEMPLATE_UID,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  type DefaultMcpEntrySpec,
} from "./default-mcp-spec.js";
import { nudgeWaitingAgents } from "./default-mcp-template.js";
import type { DefaultMcpTemplateContext } from "./default-mcp-template.js";
import { secretService } from "./secrets.js";

export const ARCANA_TEMPLATE_PLACEHOLDER_SECRET_KEY = "default_mcp.arcana_brain.template_placeholder";
const SWEEP_LIMIT = 25;

export type StaticTemplateOutcome =
  | { kind: "skipped"; reason: "feature_disabled" | "out_of_scope" | "no_static_entry" | "company_not_found" | "company_archived" }
  | { kind: "waiting"; reason: "mcp_url_not_configured" | "mcp_url_invalid" }
  /** A same-named connection that is not ours exists: trusted unchanged, nothing written. */
  | { kind: "adopted" }
  | { kind: "collision"; reason: "template_ambiguous" }
  /** Our fixed-uid template was archived by an operator: terminal, never recreated. */
  | { kind: "revoked" }
  | { kind: "ready"; created: boolean };

export function staticTemplateEntries(spec: readonly DefaultMcpEntrySpec[]): DefaultMcpEntrySpec[] {
  return spec.filter((entry) => entry.templateBootstrap === "static" && entry.setupHook && entry.reviewedTools);
}

const versionHashOf = (entryKey: string, tool: string, version: number) =>
  createHash("sha256").update(`paperclip:static-template:${entryKey}:${tool}:v${version}`).digest("hex");

/** An active placeholder secret for the template's header ref: reused if one exists, else created (outside the tx). */
async function ensurePlaceholderSecret(db: Db, txDb: Db, companyId: string): Promise<string> {
  const [existing] = await txDb
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.key, ARCANA_TEMPLATE_PLACEHOLDER_SECRET_KEY),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  // A random value that is not, and cannot become, a valid exchange key (Arcana only accepts keys whose hash it
  // registered); every agent's clone re-points the ref at the agent's own secret. Created on its own connection:
  // a failure later in the template transaction at worst leaves this unused row, reused on the retry.
  const created = await secretService(db).create(
    companyId,
    {
      name: "Arcana brain template placeholder",
      key: ARCANA_TEMPLATE_PLACEHOLDER_SECRET_KEY,
      provider: "local_encrypted",
      value: randomBytes(36).toString("base64url"),
      description: "Placeholder for the Arcana brain template connection. Authorizes nothing; never used by an agent.",
    },
    { userId: null },
  );
  return created.id;
}

async function ensureOne(
  ctx: DefaultMcpTemplateContext,
  entry: DefaultMcpEntrySpec,
  companyId: string,
  mcpUrl: string,
  now: Date,
): Promise<StaticTemplateOutcome> {
  const reviewed = entry.reviewedTools!;
  const allow = new Set(reviewed.allow);
  const txResult = await ctx.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:default-mcp:static-template:" + companyId + ":" + entry.key}, 0))`);
    const [company] = await txDb.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company) return { kind: "skipped", reason: "company_not_found" } as const;
    if (company.status !== "active" && company.status !== "paused") return { kind: "skipped", reason: "company_archived" } as const;

    const rows = await txDb
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          or(eq(toolConnections.uid, ARCANA_STATIC_TEMPLATE_UID), and(eq(toolConnections.name, entry.connectionName), ne(toolConnections.status, "archived"))),
        ),
      );
    const ours = rows.find((row) => row.uid === ARCANA_STATIC_TEMPLATE_UID);
    const sameName = rows.filter((row) => row.name === entry.connectionName && row.status !== "archived");
    if (ours?.status === "archived") return { kind: "revoked" } as const;
    if (sameName.length > 1) return { kind: "collision", reason: "template_ambiguous" } as const;
    if (!ours && sameName.length === 1) return { kind: "adopted" } as const;

    let connection = ours;
    let created = false;
    if (!connection) {
      const apps = await txDb
        .select()
        .from(toolApplications)
        .where(and(eq(toolApplications.companyId, companyId), or(eq(toolApplications.name, entry.connectionName), eq(toolApplications.applicationKey, entry.connectionName))));
      if (apps.length > 1) return { kind: "collision", reason: "template_ambiguous" } as const;
      let application = apps[0];
      if (application && (application.type !== "mcp_http" || application.status !== "active" || application.archivedAt)) {
        return { kind: "collision", reason: "template_ambiguous" } as const;
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
        if (!application || application.type !== "mcp_http") return { kind: "collision", reason: "template_ambiguous" } as const;
      }
      // A placeholder the header ref can point at. It is a random value that is not, and cannot become, a valid
      // exchange key (Arcana only accepts keys whose hash it registered); every agent's clone replaces the ref.
      const placeholderId = await ensurePlaceholderSecret(ctx.db, txDb, companyId);
      const endpoint = { url: mcpUrl, mcpSessionRequired: true, quarantineNewEntries: true };
      const [row] = await txDb
        .insert(toolConnections)
        .values({
          companyId,
          applicationId: application.id,
          name: entry.connectionName,
          uid: ARCANA_STATIC_TEMPLATE_UID,
          connectionKind: "managed",
          ownership: "customer",
          transport: "mcp_remote",
          authKind: "api_key",
          credentialPolicy: "shared",
          status: "active",
          enabled: true,
          healthStatus: "ok",
          config: { ...endpoint },
          transportConfig: { ...endpoint },
          credentialRefs: [{ name: "Authorization", secretId: placeholderId, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
          credentialSecretRefs: [],
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return { kind: "collision", reason: "template_ambiguous" } as const;
      connection = row;
      created = true;
    }

    // Seed the catalog with exactly the reviewed verbs (conflict-safe), then narrow anything else.
    for (const tool of reviewed.allow) {
      await txDb
        .insert(toolCatalogEntries)
        .values({
          companyId,
          applicationId: connection.applicationId,
          connectionId: connection.id,
          entryKind: "tool",
          name: tool,
          toolName: tool,
          title: tool,
          description: `Arcana brain verb: ${tool}`,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          riskLevel: "read",
          isReadOnly: true,
          isWrite: false,
          isDestructive: false,
          status: "active",
          version: String(reviewed.version),
          versionHash: versionHashOf(entry.key, tool, reviewed.version),
          reviewedAt: now,
        })
        .onConflictDoNothing();
    }
    const catalog = await txDb
      .select()
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, connection.id)));
    const allowed = catalog.filter((row) => row.entryKind === "tool" && allow.has(row.toolName));
    const rest = catalog.filter((row) => !allowed.includes(row));
    if (rest.length > 0) {
      await txDb
        .update(toolCatalogEntries)
        .set({ status: "disabled", quarantinedAt: null, quarantineReason: null, updatedAt: now })
        .where(inArray(toolCatalogEntries.id, rest.map((row) => row.id)));
    }
    const needActive = allowed.filter((row) => row.status !== "active" || row.quarantinedAt);
    if (needActive.length > 0) {
      await txDb
        .update(toolCatalogEntries)
        .set({ status: "active", reviewedAt: now, quarantinedAt: null, quarantineReason: null, updatedAt: now })
        .where(inArray(toolCatalogEntries.id, needActive.map((row) => row.id)));
    }

    // Default-deny profile offering exactly the reviewed verbs. No bindings are ever created here.
    const profileMetadata = { source: "app_gallery_finish", connectionId: connection.id, staticTemplate: true };
    const [existingProfile] = await txDb
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connection.id}`)))
      .limit(1);
    let profile = existingProfile;
    if (!profile) {
      const [sameNameProfile] = await txDb
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.name, connection.name)))
        .limit(1);
      [profile] = await txDb
        .insert(toolProfiles)
        .values({
          companyId,
          profileKey: `app:${connection.id}`,
          name: sameNameProfile ? `${connection.name} (${connection.id.replace(/-/g, "").slice(0, 8)})` : connection.name,
          description: `Access profile for ${connection.name}.`,
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
    if (stale.length > 0) await txDb.delete(toolProfileEntries).where(inArray(toolProfileEntries.id, stale.map((row) => row.id)));
    const have = new Set(entries.filter((row) => !stale.includes(row)).map((row) => row.catalogEntryId));
    for (const row of allowed) {
      if (have.has(row.id)) continue;
      await txDb.insert(toolProfileEntries).values({
        companyId,
        profileId: profile!.id,
        selectorType: "catalog_entry",
        effect: "include",
        applicationId: connection.applicationId,
        connectionId: connection.id,
        catalogEntryId: row.id,
      });
    }
    return { kind: "ready", created } as const;
  });
  return txResult;
}

/** Ensures every static-catalog template for one company. Never throws for an expected non-ready state. */
export async function ensureStaticCompanyTemplates(
  ctx: DefaultMcpTemplateContext,
  input: { companyId: string },
): Promise<StaticTemplateOutcome[]> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return [{ kind: "skipped", reason: "feature_disabled" }];
  const scope = ctx.scope ?? readDefaultMcpTemplateScope();
  if (!isCompanyInDefaultMcpTemplateScope(scope, input.companyId)) return [{ kind: "skipped", reason: "out_of_scope" }];
  const entries = staticTemplateEntries(ctx.spec ?? DEFAULT_MCP_SPEC);
  if (entries.length === 0) return [{ kind: "skipped", reason: "no_static_entry" }];
  const url = resolveArcanaMcpUrl(ctx.env);
  if (!url.ok) return [{ kind: "waiting", reason: url.reason }];
  const now = ctx.now?.() ?? new Date();
  const outcomes: StaticTemplateOutcome[] = [];
  for (const entry of entries) {
    const outcome = await ensureOne(ctx, entry, input.companyId, url.url, now);
    if (outcome.kind === "ready" && outcome.created) await nudgeWaitingAgents(ctx.db, input.companyId, entry.key, now);
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * One tick: in-scope companies with no unarchived same-named connection and no template of ours (an archived one is
 * terminal and skipped). Bounded; never touches an agent. Catalog drift on an existing template is repaired by the
 * next `ensureStaticCompanyTemplates` call (create/reactivate), not by the sweep.
 */
export async function sweepStaticCompanyTemplates(ctx: DefaultMcpTemplateContext & { limit?: number }): Promise<number> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return 0;
  const scope = ctx.scope ?? readDefaultMcpTemplateScope();
  if (scope.mode === "none") return 0;
  if (scope.mode === "allowlist" && scope.companyIds.length === 0) return 0;
  const entries = staticTemplateEntries(ctx.spec ?? DEFAULT_MCP_SPEC);
  if (entries.length === 0 || !resolveArcanaMcpUrl(ctx.env).ok) return 0;
  let total = 0;
  for (const entry of entries) {
    const scopeSql =
      scope.mode === "allowlist"
        ? sql`and c.id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
    const result: unknown = await ctx.db.execute(sql`
      select c.id as id
      from companies c
      where c.status in ('active', 'paused')
        ${scopeSql}
        and not exists (
          select 1 from tool_connections t
          where t.company_id = c.id
            and (t.uid = ${ARCANA_STATIC_TEMPLATE_UID} or (t.name = ${entry.connectionName} and t.status <> 'archived'))
        )
      order by c.created_at asc
      limit ${ctx.limit ?? SWEEP_LIMIT}
    `);
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>;
    for (const row of rows) {
      try {
        await ensureStaticCompanyTemplates(ctx, { companyId: row.id });
      } catch (err) {
        logger.warn({ companyId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP static template sweep item failed");
      }
    }
    total += rows.length;
  }
  return total;
}
