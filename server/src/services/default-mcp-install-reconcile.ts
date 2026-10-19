/**
 * One-shot default install for EXISTING agents (`installByDefault` entries, i.e. comms-board).
 *
 * New agents get their own dedicated connection installed in the transaction that creates it (`installOnReady`). Agents
 * that predate that, or whose entry was added by an operator route, carry no `installOnReady` marker. This sweep (run
 * after the setup sweep, same flag, same frozen rollout scope) settles each such entry exactly once:
 *  - entry still `pending`: the marker is set true, so setup installs the connection when it makes it (this keeps an
 *    owner_required agent blocked until an owner exists; nothing is created here);
 *  - entry `ready` with the real wiring intact (`commsWiringIntact`): the agent's OWN dedicated connection is installed
 *    through the normal helper, the entry is marked enabled and the marker consumed (false), so a later removal of the
 *    install by the owner is never undone;
 *  - `error` and every other state are left alone (they have no usable connection to install).
 * It only ever installs the agent's own dedicated connection (never the org template or another agent's connection), and
 * a failure on one agent is logged by class only and never affects another agent or agent creation.
 */
import { and, eq, sql } from "drizzle-orm";
import { agents, toolConnections, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isCompanyInDefaultMcpTemplateScope, readDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { logActivity } from "./activity-log.js";
import { commsWiringIntact } from "./default-mcp-setup.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  readDefaultMcpState,
  type DefaultMcpEntrySpec,
} from "./default-mcp-spec.js";
import { toolAccessService } from "./tool-access.js";

export const DEFAULT_INSTALL_RECONCILE_LIMIT = 50;

function entryPath(key: string, ...rest: string[]) {
  const parts = [DEFAULT_MCP_METADATA_KEY, "entries", key, ...rest];
  return sql`ARRAY[${sql.join(parts.map((part) => sql`${part}::text`), sql`, `)}]`;
}

export type DefaultInstallOutcome = "marked" | "installed" | "skipped";

async function reconcileOne(db: Db, row: { id: string; companyId: string; metadata: unknown }, spec: DefaultMcpEntrySpec): Promise<DefaultInstallOutcome> {
  const entry = readDefaultMcpState(row.metadata)?.entries[spec.key];
  if (!entry || !entry.dedicated || entry.installOnReady !== undefined) return "skipped";
  const unsettled = sql`NOT (coalesce(${agents.metadata} #> ${entryPath(spec.key)}, '{}'::jsonb) ? 'installOnReady')`;
  if (entry.setup.state === "pending") {
    const marked = await db
      .update(agents)
      .set({ metadata: sql`jsonb_set(${agents.metadata}, ${entryPath(spec.key, "installOnReady")}, 'true'::jsonb, true)` })
      .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId), sql`${agents.metadata} #>> ${entryPath(spec.key, "setup", "state")} = 'pending'`, unsettled))
      .returning({ id: agents.id });
    return marked.length === 1 ? "marked" : "skipped";
  }
  if (entry.setup.state !== "ready") return "skipped";
  if (!(await commsWiringIntact(db, row.companyId, row.id, entry))) return "skipped";
  const connectionId = entry.binding!.connectionId!;
  const installed = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [connection] = await txDb
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, row.companyId)))
      .limit(1);
    // Only the agent's OWN dedicated connection, the one its stored binding names.
    if (!connection || connection.credentialPolicy !== "per_agent" || connection.status === "archived") return false;
    const flipped = await txDb
      .update(agents)
      .set({
        metadata: sql`jsonb_set(jsonb_set(${agents.metadata}, ${entryPath(spec.key, "enabled")}, 'true'::jsonb, false), ${entryPath(spec.key, "installOnReady")}, 'false'::jsonb, true)`,
      })
      .where(and(eq(agents.id, row.id), eq(agents.companyId, row.companyId), sql`${agents.metadata} #>> ${entryPath(spec.key, "setup", "state")} = 'ready'`, unsettled))
      .returning({ id: agents.id });
    if (flipped.length !== 1) return false; // lost a race with setup or a concurrent reconcile
    await toolAccessService(txDb).addAgentConnectionInstall(txDb, connection, row.id, undefined, {
      install: true,
      bindingSource: "default_mcp_spec",
    });
    return true;
  });
  if (!installed) return "skipped";
  await logActivity(db, {
    companyId: row.companyId,
    actorType: "system",
    actorId: "default-mcp-install-reconcile",
    action: "agent.default_mcp.dedicated_installed",
    entityType: "agent",
    entityId: row.id,
    // Non-secret facts only.
    details: { key: spec.key, connectionId, source: "reconcile" },
  });
  return "installed";
}

export async function sweepDefaultInstalls(
  db: Db,
  options: { env?: NodeJS.ProcessEnv; spec?: readonly DefaultMcpEntrySpec[]; limit?: number } = {},
): Promise<{ marked: number; installed: number }> {
  const totals = { marked: 0, installed: 0 };
  if (!isDefaultMcpSpecEnabled(options.env ?? process.env)) return totals;
  const scope = readDefaultMcpTemplateScope();
  if (scope.mode === "none" || (scope.mode === "allowlist" && scope.companyIds.length === 0)) return totals;
  const scopeSql =
    scope.mode === "allowlist"
      ? sql`and a.company_id::text in (${sql.join(scope.companyIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  for (const spec of (options.spec ?? DEFAULT_MCP_SPEC).filter((entry) => entry.installByDefault && entry.setupHook)) {
    // Type-guarded in the expression itself, so one malformed legacy row cannot abort the batch.
    const found: unknown = await db.execute(sql`
      select a.id as id
      from agents a
      join companies c on c.id = a.company_id
      where a.status not in ('pending_approval', 'terminated')
        and c.status <> 'archived'
        ${scopeSql}
        and jsonb_typeof(a.metadata #> ${entryPath(spec.key)}) = 'object'
        and not (a.metadata #> ${entryPath(spec.key)} ? 'installOnReady')
        and a.metadata #>> ${entryPath(spec.key, "dedicated")} = 'true'
        and a.metadata #>> ${entryPath(spec.key, "setup", "state")} in ('pending', 'ready')
      order by random()
      limit ${options.limit ?? DEFAULT_INSTALL_RECONCILE_LIMIT}
    `);
    const ids = ((Array.isArray(found) ? found : ((found as { rows?: unknown[] }).rows ?? [])) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      try {
        const [row] = await db
          .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!row) continue;
        const outcome = await reconcileOne(db, row, spec);
        if (outcome === "marked") totals.marked += 1;
        if (outcome === "installed") totals.installed += 1;
      } catch (err) {
        logger.warn({ agentId: id, errorClass: err instanceof Error ? err.constructor.name : typeof err }, "default MCP install reconcile failed");
      }
    }
  }
  return totals;
}
