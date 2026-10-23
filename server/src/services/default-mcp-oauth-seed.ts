/**
 * Managed discovery-only OAuth seeds for the default MCP spec (TECH-7340).
 *
 * For each OAuth entry in DEFAULT_MCP_SPEC with an `oauthSeed` config and a valid
 * endpoint URL configured in the corresponding env var:
 * Provisions a discovery-only seed connection (status: "draft", enabled: false,
 * config.defaultMcpManaged: "seed", identityModel: "personal_only", tag: entry.key)
 * and its parent tool application (key: "default-mcp-<entry.key>", type: "mcp_http").
 *
 * Seeding is local RAM/DB only: NO external network calls, NO DNS resolution,
 * NO catalog discovery, NO membership grants, NO agent writes, NO model wakes.
 *
 * Seeds are NON-INSTALLABLE and NON-CALLABLE for ALL agents.
 *
 * Pinned fixed UID: `<entry.connectionName>/default-mcp-seed`.
 * If an archived row exists, it is treated as an org opt-out and not re-created.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  companies,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  isCompanyInDefaultMcpTemplateScope,
  parseDefaultMcpTemplateScope,
  readDefaultMcpTemplateScope,
  type DefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY,
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  type DefaultMcpEntrySpec,
} from "./default-mcp-spec.js";

export const DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT = 25;
export const DEFAULT_MCP_OAUTH_SEED_INTERVAL_MS = 60_000;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validates endpoint URL using the same rules as Comms:
 * Absolute https: URL (any host), or http: for loopback hostname only.
 * No userinfo, query string, or fragment.
 */
export function validOAuthSeedEndpoint(raw: string): boolean {
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

export interface DefaultMcpOAuthSeedContext {
  db: Db;
  env?: NodeJS.ProcessEnv;
  spec?: readonly DefaultMcpEntrySpec[];
  scope?: DefaultMcpTemplateScope;
  now?: () => Date;
}

export function defaultMcpSeedUid(connectionName: string): string {
  return `${connectionName}/default-mcp-seed`;
}

export function defaultMcpApplicationKey(entryKey: string): string {
  return `default-mcp-${entryKey}`;
}

/**
 * Scope precedence: an explicit `ctx.scope` wins; an injected `ctx.env` that carries its own rollout-scope value is
 * parsed with the normal semantics; otherwise (no env, or an injected env that omits the property) the boot-frozen
 * scope applies. An omitted property must never parse as "unset" (= every company), which would widen the allowlist.
 */
function resolveSeedScope(ctx: DefaultMcpOAuthSeedContext): DefaultMcpTemplateScope {
  if (ctx.scope) return ctx.scope;
  const raw = ctx.env ? ctx.env[DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV] : undefined;
  return typeof raw === "string" ? parseDefaultMcpTemplateScope(raw) : readDefaultMcpTemplateScope();
}

const MAX_LOGGED_APP_CONFLICTS = 1000;
const loggedAppConflicts = new Set<string>();

function logAppConflictOnce(key: string, logFn: () => void): void {
  if (loggedAppConflicts.has(key)) return;
  if (loggedAppConflicts.size >= MAX_LOGGED_APP_CONFLICTS) {
    const first = loggedAppConflicts.values().next().value;
    if (first !== undefined) loggedAppConflicts.delete(first);
  }
  loggedAppConflicts.add(key);
  logFn();
}

/**
 * Ensures discovery-only seeds exist for one company.
 * Skips archived companies and companies outside template rollout scope.
 */
export async function ensureCompanyDefaultMcpOAuthSeeds(
  ctx: DefaultMcpOAuthSeedContext,
  input: { companyId: string },
): Promise<void> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return;

  const scope = resolveSeedScope(ctx);
  if (!isCompanyInDefaultMcpTemplateScope(scope, input.companyId)) return;

  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const oauthEntries = spec.filter((entry) => entry.authKind === "oauth" && entry.oauthSeed);
  if (oauthEntries.length === 0) return;

  // Verify company is active or paused (not archived)
  const [companyRow] = await ctx.db
    .select({ id: companies.id, status: companies.status })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!companyRow || (companyRow.status !== "active" && companyRow.status !== "paused")) {
    return;
  }

  for (const entry of oauthEntries) {
    const urlEnvKey = entry.oauthSeed?.urlEnv;
    if (!urlEnvKey) continue;
    const rawUrl = env[urlEnvKey]?.trim();
    if (!rawUrl || !validOAuthSeedEndpoint(rawUrl)) {
      // Missing or invalid endpoint: availability is disabled, no seed created
      continue;
    }

    const seedUid = defaultMcpSeedUid(entry.connectionName);
    const appKey = defaultMcpApplicationKey(entry.key);

    await ctx.db.transaction(async (tx) => {
      // Transaction-scoped advisory lock for this company and entry
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'paperclip:default-mcp:oauth-seed:' + input.companyId + ':' + entry.key}, 0))`
      );

      // Check if seed connection already exists in any status (including archived -> opt-out)
      const [existingSeed] = await tx
        .select({ id: toolConnections.id, status: toolConnections.status })
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.uid, seedUid)))
        .limit(1);
      if (existingSeed) return;

      // Check or create tool application
      const [existingApp] = await tx
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.companyId, input.companyId),
            eq(toolApplications.applicationKey, appKey),
          ),
        )
        .limit(1);

      let applicationId: string;
      if (existingApp) {
        if (existingApp.type !== "mcp_http" || existingApp.archivedAt) {
          logAppConflictOnce(`${input.companyId}:${appKey}`, () => {
            logger.warn(
              { companyId: input.companyId, applicationKey: appKey },
              "default MCP seed application conflict (invalid type or archived); skipping seed creation",
            );
          });
          return;
        }
        applicationId = existingApp.id;
      } else {
        // S2: When KEY lookup finds none, check by NAME (entry.displayName):
        // if an existing application with the same name has a different key, that is a terminal collision on (company_id, name)
        const [existingByName] = await tx
          .select({ id: toolApplications.id, applicationKey: toolApplications.applicationKey })
          .from(toolApplications)
          .where(
            and(
              eq(toolApplications.companyId, input.companyId),
              eq(toolApplications.name, entry.displayName),
            ),
          )
          .limit(1);
        if (existingByName) {
          logAppConflictOnce(`${input.companyId}:name:${entry.displayName}`, () => {
            logger.warn(
              { companyId: input.companyId, name: entry.displayName },
              "default MCP seed application name collision with existing different key; skipping seed creation",
            );
          });
          return;
        }

        await tx
          .insert(toolApplications)
          .values({
            companyId: input.companyId,
            applicationKey: appKey,
            name: entry.displayName,
            type: "mcp_http",
            status: "active",
            metadata: {},
          })
          .onConflictDoNothing();

        const [createdApp] = await tx
          .select({ id: toolApplications.id, type: toolApplications.type, archivedAt: toolApplications.archivedAt })
          .from(toolApplications)
          .where(
            and(
              eq(toolApplications.companyId, input.companyId),
              eq(toolApplications.applicationKey, appKey),
            ),
          )
          .limit(1);

        if (!createdApp || createdApp.type !== "mcp_http" || createdApp.archivedAt) {
          logAppConflictOnce(`${input.companyId}:create:${appKey}`, () => {
            logger.warn(
              { companyId: input.companyId, applicationKey: appKey },
              "default MCP seed application creation failed or conflicted (missing, wrong type or archived); skipping seed creation",
            );
          });
          return;
        }
        applicationId = createdApp.id;
      }

      // Insert discovery-only seed connection
      const seedConfig = {
        url: rawUrl,
        mcpSessionRequired: true,
        quarantineNewEntries: true,
        [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "seed",
        [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: entry.key,
        identityModel: "personal_only",
      };
      const seedTransportConfig = {
        url: rawUrl,
        quarantineNewEntries: true,
        [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "seed",
        [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: entry.key,
        identityModel: "personal_only",
      };

      await tx
        .insert(toolConnections)
        .values({
          companyId: input.companyId,
          applicationId,
          name: entry.displayName,
          uid: seedUid,
          connectionKind: "managed",
          ownership: "customer",
          transport: "mcp_remote",
          authKind: "oauth",
          credentialPolicy: "per_user",
          status: "draft",
          enabled: false,
          config: seedConfig,
          transportConfig: seedTransportConfig,
          credentialRefs: [],
          credentialSecretRefs: [],
          createdByUserId: null,
          createdByAgentId: null,
        })
        .onConflictDoNothing();
    });
  }
}

/**
 * Sweep tick: finds up to 25 companies needing default MCP OAuth seeds.
 */
export async function sweepDefaultMcpOAuthSeeds(
  ctx: DefaultMcpOAuthSeedContext & { limit?: number },
): Promise<number> {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return 0;

  const scope = resolveSeedScope(ctx);
  if (scope.mode === "none") return 0;
  if (scope.mode === "allowlist" && scope.companyIds.length === 0) return 0;

  const spec = ctx.spec ?? DEFAULT_MCP_SPEC;
  const oauthEntries = spec.filter((entry) => {
    if (entry.authKind !== "oauth" || !entry.oauthSeed) return false;
    const rawUrl = env[entry.oauthSeed.urlEnv]?.trim();
    return Boolean(rawUrl && validOAuthSeedEndpoint(rawUrl));
  });
  if (oauthEntries.length === 0) return 0;

  const scopeSql: SQL =
    scope.mode === "allowlist"
      ? sql`and c.id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;

  const eligibleSeedsCheck: SQL = sql.join(
    oauthEntries.map((e) => {
      const seedUid = defaultMcpSeedUid(e.connectionName);
      const appKey = defaultMcpApplicationKey(e.key);
      return sql`(
        not exists (select 1 from tool_connections tc where tc.company_id = c.id and tc.uid = ${seedUid})
        and not exists (select 1 from tool_applications ta where ta.company_id = c.id and ta.application_key = ${appKey} and (ta.type <> 'mcp_http' or ta.archived_at is not null))
        and (
          exists (select 1 from tool_applications ta where ta.company_id = c.id and ta.application_key = ${appKey})
          or not exists (select 1 from tool_applications ta where ta.company_id = c.id and ta.name = ${e.displayName})
        )
      )`;
    }),
    sql` or `,
  );

  const result: unknown = await ctx.db.execute(sql`
    select c.id as id
    from companies c
    where c.status in ('active', 'paused')
      ${scopeSql}
      and (${eligibleSeedsCheck})
    order by c.created_at asc
    limit ${ctx.limit ?? DEFAULT_MCP_OAUTH_SEED_SWEEP_LIMIT}
  `);

  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>;
  for (const row of rows) {
    try {
      await ensureCompanyDefaultMcpOAuthSeeds(ctx, { companyId: row.id });
    } catch (err) {
      logger.warn(
        { companyId: row.id, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "default MCP OAuth seed sweep item failed",
      );
    }
  }
  return rows.length;
}

const inFlight = new Set<Promise<unknown>>();

/**
 * Asynchronously ensure OAuth seeds for a company. Non-blocking.
 */
export function scheduleCompanyDefaultMcpOAuthSeedsEnsure(
  db: Db,
  input: { companyId: string },
  ctx: Omit<DefaultMcpOAuthSeedContext, "db"> = {},
): void {
  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      ensureCompanyDefaultMcpOAuthSeeds({ db, ...ctx }, input)
        .catch((err) =>
          logger.warn(
            { companyId: input.companyId, errorClass: err instanceof Error ? err.constructor.name : typeof err },
            "default MCP OAuth seed ensure failed",
          ),
        )
        .finally(resolve);
    });
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Test seam: wait for all in-flight scheduled OAuth seed ensures to complete. */
export async function waitForScheduledCompanyOAuthSeeds(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * Starts periodic background sweep for default MCP OAuth seeds.
 */
export function startDefaultMcpOAuthSeedSweep(
  db: Db,
  ctx: Omit<DefaultMcpOAuthSeedContext, "db"> = {},
): () => void {
  const env = ctx.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) return () => {};

  let active = true;
  let timer: NodeJS.Timeout | null = null;
  let initialImmediate: NodeJS.Immediate | null = null;

  const tick = () => {
    initialImmediate = null;
    if (!active) return;
    sweepDefaultMcpOAuthSeeds({ db, ...ctx })
      .catch((err) =>
        logger.warn(
          { errorClass: err instanceof Error ? err.constructor.name : typeof err },
          "default MCP OAuth seed sweep failed",
        ),
      )
      .finally(() => {
        if (!active) return;
        timer = setTimeout(tick, DEFAULT_MCP_OAUTH_SEED_INTERVAL_MS);
        timer.unref?.();
      });
  };

  // Kick initial tick
  initialImmediate = setImmediate(tick);

  return () => {
    active = false;
    if (initialImmediate) {
      clearImmediate(initialImmediate);
      initialImmediate = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
