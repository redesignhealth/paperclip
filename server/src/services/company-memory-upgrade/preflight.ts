import {
  agents,
  companies,
  companyMemoryDatabases,
  type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import {
  deriveCompanyMemoryDatabaseNames,
  isSupportedCompanyMemoryEmbedding,
} from "../company-memory-constants.js";
import { assertNonSuperuserAndRestrictedRole } from "./census.js";
import {
  assertTenantRolePreflight,
  introspectCollection,
  type TenantCollectionShape,
} from "./sweep-tenant.js";
import { assertSupportedStagingVectorType } from "./tenant-tables.js";
import type { CpAgentRow } from "./agent-routing.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface TenantPreflightParams {
  companyId: string;
  tableName?: string;
}

export interface TenantPreflightDependencies {
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
}

export interface TenantPreflightResult {
  shape: TenantCollectionShape;
  stagingVectorType: string;
  resolvedCompanyName: string | null;
  cpAgentMap: Map<string, CpAgentRow>;
  currentDatabase: string;
  currentUser: string;
}

/**
 * Executes preflight validation steps 1-5 across control-plane and tenant connections.
 * Pure preflight with ZERO control-plane side effects (no leases, no fences, no record creations).
 */
export async function runTenantPreflight(
  cpDb: Db,
  tenantSql: postgres.Sql,
  params: TenantPreflightParams,
  deps: TenantPreflightDependencies = {},
): Promise<TenantPreflightResult> {
  const { companyId, tableName = "mem0_memories" } = params;

  // 1. Role preflights on both connections
  await assertTenantRolePreflight(tenantSql, "tenant");

  await cpDb.transaction(async (tx) => {
    await assertNonSuperuserAndRestrictedRole(tx, "control-plane");
  });

  // 2. Fetch tenant current_database() and current_user
  const dbInfoRows = await tenantSql`
    SELECT current_database()::text AS current_database, current_user::text AS current_user;
  `;
  const currentDatabase = deps._internalDatabaseIdentityOverride?.database !== undefined
    ? (deps._internalDatabaseIdentityOverride.database ?? "").trim()
    : (dbInfoRows[0]?.current_database ?? "").trim();
  const currentUser = deps._internalDatabaseIdentityOverride?.user !== undefined
    ? (deps._internalDatabaseIdentityOverride.user ?? "").trim()
    : (dbInfoRows[0]?.current_user ?? "").trim();

  if (!currentDatabase || !currentUser) {
    throw new CompanyMemoryUpgradeError(
      "Unable to determine current database and user identity from tenant connection.",
      "DATABASE_IDENTITY_UNAVAILABLE",
    );
  }

  // 3. Control plane binding verification
  let resolvedCompanyName: string | null = null;
  await cpDb.transaction(async (tx) => {
    const compRows = await tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId));

    if (!compRows[0]) {
      throw new CompanyMemoryUpgradeError(
        "Target company record does not exist in control plane database.",
        "COMPANY_NOT_FOUND",
      );
    }
    resolvedCompanyName = compRows[0].name;

    const memDbRows = await tx
      .select({
        databaseName: companyMemoryDatabases.databaseName,
        databaseRole: companyMemoryDatabases.databaseRole,
        host: companyMemoryDatabases.host,
        port: companyMemoryDatabases.port,
        status: companyMemoryDatabases.status,
        embeddingModel: companyMemoryDatabases.embeddingModel,
        embeddingDimensions: companyMemoryDatabases.embeddingDimensions,
      })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .limit(1);

    if (!memDbRows[0]) {
      throw new CompanyMemoryUpgradeError(
        "No company_memory_databases record found for target company.",
        "COMPANY_BINDING_MISMATCH",
      );
    }

    const memRow = memDbRows[0];
    if (memRow.status !== "ready") {
      throw new CompanyMemoryUpgradeError(
        "Company memory database binding status is not ready (refusing pending, failed, deprovisioning, archived).",
        "COMPANY_BINDING_MISMATCH",
      );
    }

    // Preflight BEFORE lease work spends money:
    // company_memory_databases embedding model/dims must satisfy isSupportedCompanyMemoryEmbedding;
    // agree with converter (text-embedding-3-small, 1536).
    if (
      !isSupportedCompanyMemoryEmbedding({
        model: memRow.embeddingModel,
        dimensions: memRow.embeddingDimensions,
      })
    ) {
      throw new CompanyMemoryUpgradeError(
        `Company memory database embedding (${memRow.embeddingModel}, ${memRow.embeddingDimensions}) is not supported.`,
        "EMBEDDING_FAILED",
      );
    }
    if (memRow.embeddingModel !== "text-embedding-3-small" || memRow.embeddingDimensions !== 1536) {
      throw new CompanyMemoryUpgradeError(
        `Company memory database embedding (${memRow.embeddingModel}, ${memRow.embeddingDimensions}) does not match converter target (text-embedding-3-small, 1536).`,
        "EMBEDDING_FAILED",
      );
    }

    if (memRow.databaseName !== currentDatabase || memRow.databaseRole !== currentUser) {
      throw new CompanyMemoryUpgradeError(
        "Company memory database binding mismatch between control plane and connected tenant.",
        "COMPANY_BINDING_MISMATCH",
      );
    }

    const pcmemPattern = /^pcmem_[0-9a-f]{32}$/;
    if (pcmemPattern.test(currentDatabase)) {
      const derived = deriveCompanyMemoryDatabaseNames(companyId);
      if (currentDatabase !== derived.databaseName || currentUser !== derived.databaseRole) {
        throw new CompanyMemoryUpgradeError(
          "Company memory database binding mismatch with derived credentials.",
          "COMPANY_BINDING_MISMATCH",
        );
      }
    }
  });

  // 4. Introspect live collection shape
  const shape = await introspectCollection(tenantSql, tableName, {
    skipVectorIdentityCheck: deps._internalSkipVectorIdentityCheck,
  });

  const stagingVectorType = deps._internalSkipVectorIdentityCheck
    ? "text"
    : shape.embeddingType;

  // Preflight BEFORE any control-plane side effect: a staging column we cannot write to must
  // not open or resume an upgrade row. A non-terminal upgrade row blocks company deletion in
  // this slice (see the runbook WARNING), so failing after openUpgrade/claimUpgradeLease is
  // strictly worse than failing here. ensureUpgradeTables re-asserts this as defence in depth.
  assertSupportedStagingVectorType(stagingVectorType);

  // 5. Pre-load company agents for routing
  const agentRows = await cpDb
    .select({
      id: agents.id,
      name: agents.name,
      adapterType: agents.adapterType,
      status: agents.status,
      pausedAt: agents.pausedAt,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const cpAgentMap = new Map<string, CpAgentRow>();
  for (const a of agentRows) {
    cpAgentMap.set(a.id.trim().toLowerCase(), a);
  }

  return {
    shape,
    stagingVectorType,
    resolvedCompanyName,
    cpAgentMap,
    currentDatabase,
    currentUser,
  };
}
