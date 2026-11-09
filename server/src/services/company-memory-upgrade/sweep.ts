/**
 * Orchestrator for company memory upgrade sweep (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * 1. Counters vs Ledger:
 *    The tenant ledger (`paperclip_memory_upgrade_ledger`) is authoritative for all source
 *    outcomes and reconciliation. Counters in `company_memory_upgrades` track cumulative activity
 *    and do not partition the live source table.
 * 2. Crash Consistency:
 *    A crash or lease fence between a tenant commit and the control-plane counter update
 *    means undercounting in control plane counters, which is acceptable by design.
 *    Resumption strictly keys on the tenant ledger and live table keysets.
 * 3. ZERO network egress, ZERO API-key handling, and ZERO staging writes in this phase (PR3a).
 *    Rows requiring LLM conversion are recorded as pendingConversion without staging writes.
 * 4. Read-only Live Table:
 *    The live collection table is accessed exclusively via SELECT queries.
 * 5. Sensitive Data Protection:
 *    Memory text MUST NEVER appear in control plane columns, reports, logs, or error codes.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  type Db,
} from "@paperclipai/db";
import { INVOKABLE_AGENT_STATUSES } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { adapterSupportsRuntimeMemory, deriveCompanyMemoryDatabaseNames, isSupportedCompanyMemoryEmbedding } from "../company-memory-constants.js";
import { countActiveCompanyRuns, createActiveRunGate } from "./active-runs.js";
import { assertCompanyAcceptsMemoryWork, findActiveUpgrade } from "./admission.js";
import { CONVERSION_BUDGET_CONSTANTS } from "./budget.js";
import {
  buildCostRatesNanodollars,
  ceilTokenCostNanodollars,
  createCostTracker,
  estimateWorstCaseSourceCostNanodollarsForText,
  usdToNanodollars,
} from "./cost.js";
import {
  assertNoElevatedRolePrivileges,
  assertNonSuperuserAndRestrictedRole,
  isValidUuid,
  ROLE_PRIVILEGE_PREFLIGHT_SQL_TEXT,
  type RolePrivilegeRow,
  type UnroutableReason,
  validateAndResolveTableIdentifier,
  validateDatabaseUrl,
  validateOutputPath,
} from "./census.js";
import { classifyMemoryNoiseDetailed } from "./classify-noise.js";
import { createSystemClock, createSystemSleeper, type MonotonicClock, type Sleeper } from "./clock.js";
import {
  buildTargetPayload,
  computeRecordDataSha256,
  CONVERTER_ID,
  CONVERTER_VERSION,
  SUPPORTED_CONVERTER_MODELS,
  type SupportedConverterModel,
} from "./converter-contract.js";
import { createOpenAiEmbeddingClient, type EmbeddingClient } from "./embedding-client.js";
import { createOpenAiConversionClient, type ConversionClient, type ConversionClientResult } from "./llm-converter.js";
import { RedactionRegistry, resolveCompanyOpenAiKey } from "./openai-key.js";
import { createRateLimiter } from "./rate-limiter.js";
import { detectSensitiveFamilies, type SensitiveFamilyName } from "./sensitive-patterns.js";
import { computeSourceContentSha256 } from "./source-hash.js";
import {
  claimUpgradeLease,
  openUpgrade,
  releaseUpgradeLease,
  startLeaseHeartbeat,
  updateUpgradeCounters,
} from "./state-machine.js";
import {
  assertTenantRolePreflight,
  commitSourceOutcome,
  ensureUpgradeTables,
  introspectCollection,
  iterateSourcePages,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  stageSourceRecords,
  type StageSourceRecordItem,
  type TenantSourceRow,
} from "./sweep-tenant.js";
import { claimTenantFenceGuarded, type TenantFence } from "./tenant-fence.js";
import {
  type Clock,
  CompanyMemoryUpgradeError,
  mapSweepErrorCode,
  type UpgradeErrorCode,
  UPGRADE_ERROR_CODES,
} from "./types.js";

export function shouldHaltOnQuarantine(quarantined: number, considered: number): boolean {
  return quarantined > 50 || (considered >= 200 && (quarantined / considered) > 0.02);
}

export interface SweepOptions {
  databaseUrl: string;
  controlPlaneUrl: string;
  companyId: string;
  tableName?: string;
  pageSize?: number;
  maxRows?: number;
  pauseWhenActiveRuns?: number;
  activeRunPollMs?: number;
  maxPauseSeconds?: number;
  operatorLabel?: string | null;
  allowProd?: boolean;
  outputPath?: string | null;
  format?: "text" | "json";
  model?: string;
  openaiKeyFile?: string | null;
  maxCostUsd?: number | null;
  chatRpm?: number;
  chatTpm?: number;
  embeddingRpm?: number;
  embeddingTpm?: number;
  chatInputUsdPerMillion?: number;
  chatOutputUsdPerMillion?: number;
  embeddingUsdPerMillion?: number;
}

export interface SweepDependencies {
  clock?: MonotonicClock & Clock;
  sleeper?: Sleeper;
  tenantSql?: postgres.Sql;
  controlPlaneDb?: Db;
  _internalSkipVectorIdentityCheck?: boolean;
  _internalDatabaseIdentityOverride?: { database?: string | null; user?: string | null };
  _internalNow?: Date;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  conversionClient?: ConversionClient;
  embeddingClient?: EmbeddingClient;
  fetchImpl?: typeof fetch;
}

export interface SweepCounts {
  sourceSeenCount: number;
  unroutableCount: number;
  droppedNoiseCount: number;
  droppedSensitiveCount: number;
  pendingConversionCount: number;
  stagedPendingPublishCount: number;
  stagedCount?: number;
  deduplicatedCount: number;
  quarantinedCount: number;
  supersededCount: number;
  sourceDeletedCount: number;
  skippedUnchangedCount: number;
  llmInputTokens?: number;
  llmOutputTokens?: number;
  embeddingTokens?: number;
  estimatedCostNanodollars?: number;
}

export interface SweepReport {
  schemaVersion: "1.0";
  generatedAt: string;
  company: {
    id: string;
    name?: string | null;
  };
  upgradeId: string;
  leaseOwner: string;
  status: "completed" | "aborted" | "interrupted";
  counts: SweepCounts;
  activeRunGate: {
    pauseCount: number;
    totalPausedMs: number;
  };
  caveats: string[];
}

interface CpAgentRow {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  pausedAt: Date | string | null;
}

function classifyAgentRouting(
  rawAgentId: string | null | undefined,
  cpAgentMap: Map<string, CpAgentRow>,
): { isRoutable: boolean; matchedAgentId: string | null; unroutableReason?: UnroutableReason } {
  if (!rawAgentId || rawAgentId.trim() === "" || rawAgentId.trim() === "(none)") {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "missing_agent_id" };
  }

  const trimmed = rawAgentId.trim().toLowerCase();
  if (!isValidUuid(trimmed)) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "malformed_agent_id" };
  }

  const cpAgent = cpAgentMap.get(trimmed);
  if (!cpAgent) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "unknown_agent" };
  }

  const matchedAgentId = cpAgent.id;

  if (!adapterSupportsRuntimeMemory(cpAgent.adapterType)) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "non_memory_adapter" };
  }

  if (cpAgent.status === "terminated") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "terminated" };
  }

  if (cpAgent.status === "pending_approval") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "pending_approval" };
  }

  const isInvokable = INVOKABLE_AGENT_STATUSES.has(cpAgent.status);
  const isPausedStatus = cpAgent.status === "paused";

  if (!isInvokable && !isPausedStatus) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "unknown_status" };
  }

  return { isRoutable: true, matchedAgentId };
}

export function formatSweepTextReport(report: SweepReport): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("              Paperclip Company Memory Upgrade Sweep Report (TECH-8191)         ");
  lines.push("================================================================================");
  lines.push("");
  lines.push(`Upgrade ID:       ${report.upgradeId}`);
  lines.push(`Company ID:       ${report.company.id}${report.company.name ? ` (${report.company.name})` : ""}`);
  lines.push(`Lease Owner:      ${report.leaseOwner}`);
  lines.push(`Status:           ${report.status}`);
  lines.push(`Generated At:     ${report.generatedAt}`);
  lines.push("");
  lines.push("--------------------------------------------------------------------------------");
  lines.push("Classification Counts");
  lines.push("--------------------------------------------------------------------------------");
  lines.push(`  Total Sources Scanned:        ${report.counts.sourceSeenCount}`);
  lines.push(`  Staged (Pending Publish):     ${report.counts.stagedPendingPublishCount ?? report.counts.stagedCount ?? 0}`);
  lines.push(`  Deduplicated:                 ${report.counts.deduplicatedCount ?? 0}`);
  lines.push(`  Quarantined:                  ${report.counts.quarantinedCount ?? 0}`);
  lines.push(`  Dropped Noise:                ${report.counts.droppedNoiseCount}`);
  lines.push(`  Dropped Sensitive:            ${report.counts.droppedSensitiveCount}`);
  lines.push(`  Unroutable:                   ${report.counts.unroutableCount}`);
  lines.push(`  Superseded (Changed Content): ${report.counts.supersededCount}`);
  lines.push(`  Source Deleted (Tombstones):  ${report.counts.sourceDeletedCount}`);
  lines.push(`  Skipped Unchanged:            ${report.counts.skippedUnchangedCount}`);
  if (
    (report.counts.llmInputTokens ?? 0) > 0 ||
    (report.counts.embeddingTokens ?? 0) > 0
  ) {
    lines.push("");
    lines.push("--------------------------------------------------------------------------------");
    lines.push("Resource Usage (Cumulative)");
    lines.push("--------------------------------------------------------------------------------");
    lines.push(`  LLM Input Tokens:             ${report.counts.llmInputTokens ?? 0}`);
    lines.push(`  LLM Output Tokens:            ${report.counts.llmOutputTokens ?? 0}`);
    lines.push(`  Embedding Tokens:             ${report.counts.embeddingTokens ?? 0}`);
    if (report.counts.estimatedCostNanodollars !== undefined) {
      lines.push(`  Estimated Cost:               $${(report.counts.estimatedCostNanodollars / 1e9).toFixed(4)}`);
    }
  }
  lines.push("");
  lines.push("--------------------------------------------------------------------------------");
  lines.push("Active Run Gate");
  lines.push("--------------------------------------------------------------------------------");
  lines.push(`  Pauses Triggered:             ${report.activeRunGate.pauseCount}`);
  lines.push(`  Total Paused Duration:        ${Math.round(report.activeRunGate.totalPausedMs / 1000)}s`);
  lines.push("");
  if (report.caveats.length > 0) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("Caveats & Notes");
    lines.push("--------------------------------------------------------------------------------");
    for (const c of report.caveats) {
      lines.push(`  * ${c}`);
    }
    lines.push("");
  }
  lines.push("================================================================================");
  return lines.join("\n");
}

function guardCleanupErrorCode(err: unknown): UpgradeErrorCode {
  if (err && typeof err === "object" && "code" in err && typeof (err as any).code === "string") {
    return mapSweepErrorCode((err as any).code);
  }
  return "unexpected_failure";
}

export async function runSweep(
  options: SweepOptions,
  deps: SweepDependencies = {},
): Promise<SweepReport> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? createSystemClock();
  const sleeper = deps.sleeper ?? createSystemSleeper();

  const {
    databaseUrl,
    controlPlaneUrl,
    companyId,
    tableName = "mem0_memories",
    pageSize = 1000,
    maxRows,
    pauseWhenActiveRuns = 1,
    activeRunPollMs = 15_000,
    maxPauseSeconds = 0,
    operatorLabel = null,
    allowProd = false,
    outputPath,
  } = options;

  if (operatorLabel !== null && operatorLabel !== undefined) {
    if (
      typeof operatorLabel !== "string" ||
      operatorLabel.length < 1 ||
      operatorLabel.length > 64 ||
      !/^[A-Za-z0-9._:@-]+$/.test(operatorLabel)
    ) {
      throw new CompanyMemoryUpgradeError(
        "Invalid --operator-label. Must be 1-64 characters matching [A-Za-z0-9._:@-].",
        "INVALID_ARGUMENT",
      );
    }
  }

  if (options.model !== undefined && options.model !== null) {
    if (!SUPPORTED_CONVERTER_MODELS.includes(options.model as SupportedConverterModel)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid --model. Only 'gpt-5.4-mini' is supported.`,
        "INVALID_ARGUMENT",
      );
    }
  }

  if (options.maxCostUsd !== undefined && options.maxCostUsd !== null) {
    if (typeof options.maxCostUsd !== "number" || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
      throw new CompanyMemoryUpgradeError(
        "Flag '--max-cost-usd' requires a positive number value.",
        "INVALID_ARGUMENT",
      );
    }
    // Programmatic validation against the operational USD cap (shared with CLI parsing).
    usdToNanodollars(options.maxCostUsd, "maxCostUsd");
  }

  for (const [priceFlag, priceValue] of [
    ["chatInputUsdPerMillion", options.chatInputUsdPerMillion],
    ["chatOutputUsdPerMillion", options.chatOutputUsdPerMillion],
    ["embeddingUsdPerMillion", options.embeddingUsdPerMillion],
  ] as const) {
    if (priceValue !== undefined && priceValue !== null) {
      usdToNanodollars(priceValue, priceFlag);
    }
  }

  if (!isValidUuid(companyId)) {
    throw new CompanyMemoryUpgradeError(
      "Invalid --company. Must be a valid UUID.",
      "INVALID_ARGUMENT",
    );
  }

  // Prod guard applies to BOTH DSNs
  const parsedTenantUrl = validateDatabaseUrl(databaseUrl, env, { allowProd });
  validateDatabaseUrl(controlPlaneUrl, env, { allowProd });

  if (outputPath) {
    validateOutputPath(outputPath, deps.repoRoot);
  }

  const caveats: string[] = [
    "CONVERSION SWEEP (PR3b): Routable memories converted and staged into tenant staging table (published_at NULL).",
    "Zero memories published to the live collection table.",
    "Live collection table accessed read-only (SELECT ONLY).",
  ];

  // Open connections
  const tenantSql = deps.tenantSql ?? openTenantClient(databaseUrl);
  const ownsTenantSql = !deps.tenantSql;

  const cpDb = deps.controlPlaneDb ?? createDb(controlPlaneUrl, { maxConnections: 1 });
  const ownsCpDb = !deps.controlPlaneDb;

  let leaseToken: string | null = null;
  let upgradeId: string | null = null;
  let heartbeatHandle: ReturnType<typeof startLeaseHeartbeat> | null = null;
  let activeRunGate: ReturnType<typeof createActiveRunGate> | null = null;

  const counts: SweepCounts = {
    sourceSeenCount: 0,
    unroutableCount: 0,
    droppedNoiseCount: 0,
    droppedSensitiveCount: 0,
    pendingConversionCount: 0,
    stagedPendingPublishCount: 0,
    stagedCount: 0,
    deduplicatedCount: 0,
    quarantinedCount: 0,
    supersededCount: 0,
    sourceDeletedCount: 0,
    skippedUnchangedCount: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    embeddingTokens: 0,
    estimatedCostNanodollars: 0,
  };

  const rand8 = randomUUID().replace(/-/g, "").slice(0, 8);
  const leaseOwner = `memupg_sweep_${process.pid}_${rand8}`;

  try {
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

    // 6. Acquire upgrade record in control-plane transaction
    let upgrade = await cpDb.transaction(async (tx) => {
      await assertCompanyAcceptsMemoryWork(tx, companyId);
      return await findActiveUpgrade(tx, companyId);
    });

    if (!upgrade) {
      upgrade = await openUpgrade(
        cpDb,
        {
          companyId,
          converterId: CONVERTER_ID,
          converterVersion: CONVERTER_VERSION,
          collectionName: tableName,
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
          operatorLabel: operatorLabel ?? null,
        },
        { clock },
      );
    } else if (upgrade.state === "sweeping") {
      if (
        upgrade.converterId !== CONVERTER_ID ||
        upgrade.converterVersion !== CONVERTER_VERSION ||
        upgrade.collectionName !== tableName
      ) {
        throw new CompanyMemoryUpgradeError(
          "Upgrade record converter contract or collection mismatch",
          "CONVERTER_CONTRACT_MISMATCH",
        );
      }
    } else if (upgrade.state === "needs_recovery") {
      throw new CompanyMemoryUpgradeError(
        "Upgrade is in needs_recovery. Recovery/status/rollback are unavailable in this slice.",
        "STATE_MISMATCH",
      );
    } else {
      throw new CompanyMemoryUpgradeError(
        "Cannot run sweep: active upgrade is not in sweeping state.",
        "STATE_MISMATCH",
      );
    }

    upgradeId = upgrade.id;

    // 7. Claim upgrade lease
    const claim = await claimUpgradeLease(cpDb, {
      upgradeId: upgrade.id,
      leaseOwner,
      now: clock.now(),
    });

    if (!claim.acquired || !claim.leaseToken || !claim.leaseExpiresAt) {
      throw new CompanyMemoryUpgradeError(
        "Failed to acquire lease for upgrade. Another worker may hold the lease.",
        "LEASE_FENCED_OUT",
      );
    }

    leaseToken = claim.leaseToken;

    // 8. Start lease heartbeat
    heartbeatHandle = startLeaseHeartbeat(cpDb, upgrade.id, leaseToken, {
      initialExpiresAt: claim.leaseExpiresAt,
      clock,
      onLost: () => {
        // Will be asserted at next checkpoint
      },
    });

    // 9. Ensure tenant upgrade tables exist (DDL runs only after lease acquired)
    heartbeatHandle.assertActive();
    await ensureUpgradeTables(tenantSql, stagingVectorType);

    // 9b. Claim the tenant-side write fence. Must happen after the CP lease is claimed and
    // ensureUpgradeTables has run, and BEFORE any tenant data-write transaction. Every
    // tenant mutation below (including reconciliation) must thread this exact fence value
    // through and validate it inside the same transaction as the write.
    heartbeatHandle.assertActive();
    const tenantFence: TenantFence = await claimTenantFenceGuarded(cpDb, tenantSql, {
      upgradeId,
      cpLeaseToken: leaseToken,
      leaseOwner,
      now: clock.now(),
    });

    // 10. Rate limiters and conversion clients
    const redaction = new RedactionRegistry();

    const chatLimiter = createRateLimiter({
      rpm: options.chatRpm ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.chatRpmCap,
      tpm: options.chatTpm ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.chatTpmCap,
      concurrency: 2,
      clock,
      sleeper,
    });

    const embeddingLimiter = createRateLimiter({
      rpm: options.embeddingRpm ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.embeddingRpmCap,
      tpm: options.embeddingTpm ?? CONVERSION_BUDGET_CONSTANTS.rateLimits.embeddingTpmCap,
      concurrency: 2,
      clock,
      sleeper,
    });

    let convClient: ConversionClient | null = deps.conversionClient ?? null;
    let embClient: EmbeddingClient | null = deps.embeddingClient ?? null;

    async function getClients(): Promise<{
      conversionClient: ConversionClient;
      embeddingClient: EmbeddingClient;
    }> {
      if (convClient && embClient) {
        return { conversionClient: convClient, embeddingClient: embClient };
      }

      const apiKey = await resolveCompanyOpenAiKey({
        controlPlaneDb: cpDb,
        companyId,
        keyFilePath: options.openaiKeyFile,
        redaction,
        repoRoot: deps.repoRoot,
      });

      if (!convClient) {
        convClient = createOpenAiConversionClient({
          apiKey,
          model: options.model ?? "gpt-5.4-mini",
          limiter: chatLimiter,
          sleeper,
          clock,
          redaction,
          fetchImpl: deps.fetchImpl,
        });
      }

      if (!embClient) {
        embClient = createOpenAiEmbeddingClient({
          apiKey,
          limiter: embeddingLimiter,
          sleeper,
          clock,
          redaction,
          fetchImpl: deps.fetchImpl,
        });
      }

      return { conversionClient: convClient, embeddingClient: embClient };
    }

    const chatInPrice = options.chatInputUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.chatInputUsdPerMillion;
    const chatOutPrice = options.chatOutputUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.chatOutputUsdPerMillion;
    const embPrice = options.embeddingUsdPerMillion ?? CONVERSION_BUDGET_CONSTANTS.pricing.embeddingUsdPerMillion;
    const costRates = buildCostRatesNanodollars({
      chatInputUsdPerMillion: chatInPrice,
      chatOutputUsdPerMillion: chatOutPrice,
      embeddingUsdPerMillion: embPrice,
    });
    // Pure bigint nanodollar cost accounting (TECH-8191 finding COST). spentNanodollars is
    // the cumulative total for the whole sweep; pageCostNanodollars is the delta since the
    // last successful control-plane counter flush -- the two must never be conflated.
    const costTracker = createCostTracker(options.maxCostUsd ?? null);
    let consideredCount = 0;
    let didPrintBudgetLine = false;
    const quarantinedHistogram: Record<string, number> = {};

    // 11. Active run gate
    activeRunGate = createActiveRunGate({
      db: cpDb,
      companyId,
      threshold: pauseWhenActiveRuns,
      pollMs: activeRunPollMs,
      maxPauseMs: maxPauseSeconds * 1000,
      clock,
      sleeper,
      assertLeaseActive: () => heartbeatHandle?.assertActive(),
    });

    // 12. Process live source pages
    let isFirstPage = true;

    const sourceIterator = iterateSourcePages(tenantSql, tableName, {
      pageSize,
      maxRows,
      isUuidId: shape.isUuidId,
    });

    while (true) {
      heartbeatHandle.assertActive();
      await activeRunGate.waitUntilQuiet();
      heartbeatHandle.assertActive();

      const iterResult = await sourceIterator.next();
      if (iterResult.done) {
        break;
      }
      const page = iterResult.value;

      // Upfront validation: reject non-UUID source IDs and duplicate case variants before any mutations
      const seenPageIds = new Set<string>();
      for (const source of page) {
        if (!isValidUuid(source.id)) {
          throw new CompanyMemoryUpgradeError(
            "Collection table contains source row with non-UUID id. Upgrade ledger requires valid UUID source IDs.",
            "UNSUPPORTED_SOURCE_ID",
          );
        }
        const canonical = source.id.toLowerCase();
        if (seenPageIds.has(canonical)) {
          throw new CompanyMemoryUpgradeError(
            "Collection table contains duplicate source IDs differing only in case.",
            "UNSUPPORTED_SOURCE_ID",
          );
        }
        seenPageIds.add(canonical);
      }

      const pageDeltas = {
        sourceSeenCount: page.length,
        unroutableCount: 0,
        droppedNoiseCount: 0,
        droppedSensitiveCount: 0,
        stagedCount: 0,
        deduplicatedCount: 0,
        quarantinedCount: 0,
        supersededCount: 0,
        sourceDeletedCount: 0,
        skippedUnchangedCount: 0,
        pendingConversionCount: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
        embeddingTokens: 0,
      };

      const pageSourceIds = page.map((r) => r.id.toLowerCase());
      const minPageId = pageSourceIds[0];
      const maxPageId = pageSourceIds[pageSourceIds.length - 1];

      // Reconcile tombstones for this page's keyset range
      heartbeatHandle.assertActive();
      const tombstoneResult = await reconcileTombstones(tenantSql, upgradeId, {
        minSourceId: minPageId,
        maxSourceId: maxPageId,
        liveSourceIds: pageSourceIds,
        assertLeaseActive: () => heartbeatHandle?.assertActive(),
      }, tenantFence);
      pageDeltas.sourceDeletedCount += tombstoneResult.tombstonesCount;

      // Load existing ledger rows for live sources in this page
      heartbeatHandle.assertActive();
      const ledgerMap = await loadLedgerForSources(tenantSql, upgradeId, pageSourceIds);

      // Classify each source in this page
      for (const source of page) {
        heartbeatHandle.assertActive();

        const canonicalSourceId = source.id.toLowerCase();
        const contentSha256 = computeSourceContentSha256(source.data);
        const existingLedger = ledgerMap.get(canonicalSourceId);

        // Pre-compute routing to compare agent assignment
        const routing = classifyAgentRouting(source.agentId, cpAgentMap);
        const matchedAgentId = routing.matchedAgentId;

        if (existingLedger) {
          if (
            existingLedger.sourceContentSha256 === contentSha256 &&
            existingLedger.agentId === matchedAgentId
          ) {
            pageDeltas.skippedUnchangedCount++;
            continue;
          }

          // Content or agent assignment changed: reconcile to superseded
          heartbeatHandle.assertActive();
          await reconcileChangedContent(tenantSql, upgradeId, canonicalSourceId, tenantFence);
          pageDeltas.supersededCount++;
          // Then source re-enters classification in this same sweep
        }

        // Gate 1: Routing -> unroutable
        if (!routing.isRoutable) {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: routing.matchedAgentId,
            outcome: "unroutable",
            reasonCode: routing.unroutableReason!,
          }, tenantFence);
          pageDeltas.unroutableCount++;
          continue;
        }

        // Gate 2: Noise -> dropped_noise
        const noise = classifyMemoryNoiseDetailed(source.data);
        if (noise.isNoise) {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_noise",
            reasonCode: noise.reason!,
          }, tenantFence);
          pageDeltas.droppedNoiseCount++;
          continue;
        }

        // Gate 3: Sensitive -> dropped_sensitive
        const sensitive = detectSensitiveFamilies(source.data);
        if (sensitive.isSensitive) {
          const families = (Object.entries(sensitive.matches) as Array<[SensitiveFamilyName, boolean]>)
            .filter(([, hit]) => hit)
            .map(([fam]) => fam)
            .sort()
            .join(",");
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_sensitive",
            reasonCode: families,
          }, tenantFence);
          pageDeltas.droppedSensitiveCount++;
          continue;
        }

        // Gate 4: Routable non-noise non-sensitive -> LLM conversion + re-embedding
        if (!didPrintBudgetLine) {
          didPrintBudgetLine = true;
          console.error(
            `[memory-upgrade] Budget line: running conversion sweep (model: ${options.model ?? "gpt-5.4-mini"}, embedding: text-embedding-3-small, max-rows: ${maxRows ?? "unbounded"}, max-cost-usd: ${options.maxCostUsd ? `$${options.maxCostUsd}` : "unbounded"})`,
          );
        }

        // PREFLIGHT: compute the worst-case nanodollar cost ceiling for converting THIS
        // source (up to 2 chat calls + up to 3 embedding calls, conservative UTF-8
        // byte-based projection) and check the budget BEFORE resolving any API key or
        // making any paid call. If the worst case would exceed the remaining budget, abort
        // here with ZERO additional API calls.
        const preflight = estimateWorstCaseSourceCostNanodollarsForText(
          source.data,
          options.model ?? "gpt-5.4-mini",
          costRates,
        );
        costTracker.assertBudgetAllows(preflight.worstCaseNanodollars);

        heartbeatHandle.assertActive();
        const { conversionClient, embeddingClient } = await getClients();
        consideredCount++;

        const convRes = await conversionClient.convert(source.data ?? "");
        pageDeltas.llmInputTokens += convRes.inputTokens;
        pageDeltas.llmOutputTokens += convRes.outputTokens;
        // Actual-usage accounting (defense in depth): record real spend and re-check the
        // budget immediately after, in addition to the preflight ceiling above.
        costTracker.addActualCostNanodollars(
          ceilTokenCostNanodollars(convRes.inputTokens, costRates.chatInputNanoPerMillion) +
            ceilTokenCostNanodollars(convRes.outputTokens, costRates.chatOutputNanoPerMillion),
        );
        costTracker.assertBudgetAllows(0n);

        if (convRes.status === "drop_noise") {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_noise",
            reasonCode: "exact_placeholder_or_greeting",
          }, tenantFence);
          pageDeltas.droppedNoiseCount++;
          continue;
        }

        if (convRes.status === "drop_sensitive") {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "dropped_sensitive",
            reasonCode: convRes.reasonCode,
          }, tenantFence);
          pageDeltas.droppedSensitiveCount++;
          continue;
        }

        if (convRes.status === "quarantined") {
          heartbeatHandle.assertActive();
          await commitSourceOutcome(tenantSql, {
            upgradeId,
            sourceId: canonicalSourceId,
            sourceContentSha256: contentSha256,
            agentId: matchedAgentId,
            outcome: "quarantined",
            reasonCode: convRes.rejectCode,
          }, tenantFence);
          pageDeltas.quarantinedCount++;
          counts.quarantinedCount++;
          quarantinedHistogram[convRes.rejectCode] =
            (quarantinedHistogram[convRes.rejectCode] ?? 0) + 1;

          if (shouldHaltOnQuarantine(counts.quarantinedCount, consideredCount)) {
            console.error(
              "[memory-upgrade] Quarantine threshold exceeded. Halting sweep.",
            );
            console.error("[memory-upgrade] Quarantine reason histogram:");
            for (const [code, cnt] of Object.entries(quarantinedHistogram)) {
              console.error(`  ${code}: ${cnt}`);
            }

            heartbeatHandle.assertActive();
            const quarantineFlushDeltaNano = costTracker.pageCostNanodollars;
            await updateUpgradeCounters(
              cpDb,
              upgradeId,
              leaseToken,
              {
                sourceSeenCount: pageDeltas.sourceSeenCount,
                unroutableCount: pageDeltas.unroutableCount,
                droppedNoiseCount: pageDeltas.droppedNoiseCount,
                droppedSensitiveCount: pageDeltas.droppedSensitiveCount,
                // NOTE (COUNTER finding): publishedCount is intentionally NOT written here.
                // The control-plane publishedCount column tracks live-published records,
                // which this sweep phase never writes (published_at stays NULL in staging).
                // stagedPendingPublishCount is reported locally only -- see counts below.
                deduplicatedCount: pageDeltas.deduplicatedCount,
                quarantinedCount: pageDeltas.quarantinedCount,
                supersededCount: pageDeltas.supersededCount,
                sourceDeletedCount: pageDeltas.sourceDeletedCount,
                llmInputTokens: pageDeltas.llmInputTokens > 0 ? pageDeltas.llmInputTokens : undefined,
                llmOutputTokens: pageDeltas.llmOutputTokens > 0 ? pageDeltas.llmOutputTokens : undefined,
                embeddingTokens: pageDeltas.embeddingTokens > 0 ? pageDeltas.embeddingTokens : undefined,
                estimatedCostNanodollars: quarantineFlushDeltaNano,
                lastError: "conversion_failed",
              },
              { clock },
            );
            // Only reset the page delta AFTER the control-plane flush above has
            // succeeded; never flush the cumulative total as if it were a page delta.
            costTracker.resetPageDelta();

            await heartbeatHandle.stop();
            heartbeatHandle = null;
            await releaseUpgradeLease(cpDb, upgradeId, leaseToken, { clock });
            leaseToken = null;

            throw new CompanyMemoryUpgradeError(
              "Quarantine threshold exceeded: sweep halted.",
              "CONVERSION_FAILED",
            );
          }
          continue;
        }

        // convRes.status === "convert"
        const stageItems: StageSourceRecordItem[] = [];
        for (const rec of convRes.records) {
          heartbeatHandle.assertActive();
          const emb = await embeddingClient.embed(rec.data);
          pageDeltas.embeddingTokens += emb.tokens;
          costTracker.addActualCostNanodollars(
            ceilTokenCostNanodollars(emb.tokens, costRates.embeddingNanoPerMillion),
          );
          costTracker.assertBudgetAllows(0n);

          const dataSha256 = computeRecordDataSha256(rec.data);
          const payload = buildTargetPayload({
            record: rec,
            sourceId: canonicalSourceId,
            agentId: matchedAgentId!,
            companyId,
            upgradeId,
            sourcePayloadCreatedAt: source.createdAt,
            sourcePayload: source.rawPayload,
          });

          stageItems.push({
            outputId: randomUUID(),
            dataSha256,
            payload,
            embedding: emb.embedding,
          });
        }

        heartbeatHandle.assertActive();
        const stageRes = await stageSourceRecords(tenantSql, {
          upgradeId,
          sourceId: canonicalSourceId,
          sourceContentSha256: contentSha256,
          agentId: matchedAgentId!,
          records: stageItems,
          vectorType: stagingVectorType,
        }, tenantFence);

        if (stageRes.outcome === "published") {
          pageDeltas.stagedCount++;
        } else {
          pageDeltas.deduplicatedCount++;
        }
      }

      // Flush counter deltas for this page to control plane. Read the page cost delta
      // BEFORE the flush (never the cumulative total) and only reset it after the flush
      // below has durably succeeded.
      const pageFlushDeltaNano = costTracker.pageCostNanodollars;
      heartbeatHandle.assertActive();
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        {
          sweepCount: isFirstPage ? 1 : undefined,
          sourceSeenCount: pageDeltas.sourceSeenCount,
          unroutableCount: pageDeltas.unroutableCount,
          droppedNoiseCount: pageDeltas.droppedNoiseCount,
          droppedSensitiveCount: pageDeltas.droppedSensitiveCount,
          // NOTE (COUNTER finding): publishedCount is intentionally NOT written here. This
          // sweep phase only stages records (published_at stays NULL); it never publishes
          // to the live collection table, so the control-plane publishedCount column must
          // stay zero through this phase (including the quarantine-halt flush above).
          // stagedPendingPublishCount is surfaced in the report only -- see
          // counts.stagedPendingPublishCount below, and docs/runbooks/memory-upgrade-sweep
          // for the staging-count query operators should use instead of a CP column.
          deduplicatedCount: pageDeltas.deduplicatedCount,
          quarantinedCount: pageDeltas.quarantinedCount,
          supersededCount: pageDeltas.supersededCount,
          sourceDeletedCount: pageDeltas.sourceDeletedCount,
          llmInputTokens: pageDeltas.llmInputTokens > 0 ? pageDeltas.llmInputTokens : undefined,
          llmOutputTokens: pageDeltas.llmOutputTokens > 0 ? pageDeltas.llmOutputTokens : undefined,
          embeddingTokens: pageDeltas.embeddingTokens > 0 ? pageDeltas.embeddingTokens : undefined,
          estimatedCostNanodollars: pageFlushDeltaNano,
        },
        { clock },
      );
      // Only reset the page delta AFTER the flush above has succeeded.
      costTracker.resetPageDelta();

      // Accumulate into report counts
      counts.sourceSeenCount += pageDeltas.sourceSeenCount;
      counts.unroutableCount += pageDeltas.unroutableCount;
      counts.droppedNoiseCount += pageDeltas.droppedNoiseCount;
      counts.droppedSensitiveCount += pageDeltas.droppedSensitiveCount;
      counts.stagedPendingPublishCount += pageDeltas.stagedCount;
      counts.stagedCount = counts.stagedPendingPublishCount;
      counts.deduplicatedCount += pageDeltas.deduplicatedCount;
      counts.supersededCount += pageDeltas.supersededCount;
      counts.sourceDeletedCount += pageDeltas.sourceDeletedCount;
      counts.skippedUnchangedCount += pageDeltas.skippedUnchangedCount;
      counts.llmInputTokens = (counts.llmInputTokens ?? 0) + pageDeltas.llmInputTokens;
      counts.llmOutputTokens = (counts.llmOutputTokens ?? 0) + pageDeltas.llmOutputTokens;
      counts.embeddingTokens = (counts.embeddingTokens ?? 0) + pageDeltas.embeddingTokens;
      counts.estimatedCostNanodollars = Number(costTracker.spentNanodollars);

      isFirstPage = false;
    }

    // If live table was completely empty, still record sweepCount: 1 if first page never ran
    if (isFirstPage) {
      heartbeatHandle.assertActive();
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        { sweepCount: 1 },
        { clock },
      );
    }

    // Final pass for any tombstones in ledger that were outside the live keyset bounds
    heartbeatHandle.assertActive();
    const finalTombstones = await reconcileTombstones(tenantSql, upgradeId, {
      liveTableName: tableName,
      isUuidId: shape.isUuidId,
      assertLeaseActive: () => heartbeatHandle?.assertActive(),
    }, tenantFence);
    if (finalTombstones.tombstonesCount > 0) {
      heartbeatHandle.assertActive();
      counts.sourceDeletedCount += finalTombstones.tombstonesCount;
      await updateUpgradeCounters(
        cpDb,
        upgradeId,
        leaseToken,
        { sourceDeletedCount: finalTombstones.tombstonesCount },
        { clock },
      );
    }

    const gateStats = activeRunGate ? activeRunGate.stats() : { pauseCount: 0, totalPausedMs: 0 };

    const report: SweepReport = {
      schemaVersion: "1.0",
      generatedAt: (deps._internalNow ?? clock.now()).toISOString(),
      company: {
        id: companyId,
        name: resolvedCompanyName,
      },
      upgradeId: upgrade.id,
      leaseOwner,
      status: "completed",
      counts,
      activeRunGate: gateStats,
      caveats,
    };

    if (outputPath) {
      const serialized = options.format === "json"
        ? JSON.stringify(report, null, 2)
        : formatSweepTextReport(report);
      await writeFile(outputPath, serialized, { mode: 0o600, flag: "wx" });
    }

    return report;
  } catch (error) {
    if (upgradeId && leaseToken) {
      try {
        const errorCode = error instanceof CompanyMemoryUpgradeError
          ? mapSweepErrorCode(error.code)
          : "unexpected_failure";

        if (errorCode !== "lease_fenced_out" && errorCode !== "lease_expired" && errorCode !== "lease_lapsed") {
          await updateUpgradeCounters(
            cpDb,
            upgradeId,
            leaseToken,
            { lastError: errorCode },
            { clock },
          ).catch((cleanupErr: any) => {
            console.error("[memory-upgrade] failed to record lastError:", guardCleanupErrorCode(cleanupErr));
          });
        }
      } catch (err: any) {
        console.error("[memory-upgrade] error in lastError recording:", guardCleanupErrorCode(err));
      }
    }
    throw error;
  } finally {
    if (heartbeatHandle) {
      await heartbeatHandle.stop().catch((err: any) => {
        console.error("[memory-upgrade] heartbeat stop error:", guardCleanupErrorCode(err));
      });
    }

    if (upgradeId && leaseToken) {
      try {
        await releaseUpgradeLease(cpDb, upgradeId, leaseToken, { clock }).catch((err: any) => {
          console.error("[memory-upgrade] lease release error:", guardCleanupErrorCode(err));
        });
      } catch (err: any) {
        console.error("[memory-upgrade] lease release failure:", guardCleanupErrorCode(err));
      }
    }

    if (ownsTenantSql) {
      await tenantSql.end().catch((err: any) => {
        console.error("[memory-upgrade] tenant connection close error:", guardCleanupErrorCode(err));
      });
    }

    if (ownsCpDb) {
      await cpDb.$client?.end().catch((err: any) => {
        console.error("[memory-upgrade] control plane connection close error:", guardCleanupErrorCode(err));
      });
    }
  }
}
