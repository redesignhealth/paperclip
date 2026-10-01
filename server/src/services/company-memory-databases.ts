import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import postgres from "postgres";
import {
  companyMemoryDatabases,
  companySecrets,
  companySecretVersions,
} from "@paperclipai/db";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { logger } from "../middleware/logger.js";
import {
  generateRandomPassword,
  generateScramVerifier,
  rederiveScramVerifier,
  assertValidScramVerifier,
} from "./scram-verifier.js";
import {
  getCompanyMemoryConfig,
  CompanyMemoryConfigurationError,
} from "./company-memory-config.js";
import {
  SAFE_PG_IDENTIFIER_REGEX,
  UUID_REGEX,
  LEASE_TTL_MS,
} from "./company-memory-constants.js";

export { SAFE_PG_IDENTIFIER_REGEX, UUID_REGEX, LEASE_TTL_MS };

export class CompanyMemoryDatabaseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CompanyMemoryDatabaseError";
  }
}

export class CompanyMemorySecurityIsolationError extends CompanyMemoryDatabaseError {
  constructor(message: string) {
    super(message, "SECURITY_ISOLATION_FAILURE");
    this.name = "CompanyMemorySecurityIsolationError";
  }
}

export class CompanyMemoryNotReadyError extends CompanyMemoryDatabaseError {
  constructor(message: string) {
    super(message, "MEMORY_NOT_READY");
    this.name = "CompanyMemoryNotReadyError";
  }
}

export interface CompanyMemoryDatabaseRuntimeDescriptor {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly dbname: string;
  readonly sslmode: "require";
  readonly collectionName: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}

export interface RoleAccessVerificationInput {
  databaseName: string;
  databaseRole: string;
  password: string;
  host: string;
  port: number;
  sslmode: string;
}

export interface RoleAccessVerificationResult {
  connected: boolean;
  vectorInstalled: boolean;
  leakedDatabases: string[];
  publicHasTargetConnect: boolean;
  provisionerHasTargetConnect: boolean;
  provisionerIsSuperuser: boolean;
}

export interface CompanyMemoryDdlExecutor {
  executeMaintenance(sqlText: string, params?: unknown[]): Promise<any[]>;
  executeTarget(databaseName: string, sqlText: string, params?: unknown[]): Promise<any[]>;
  withRole<T>(role: string, fn: (client?: any) => Promise<T>): Promise<T>;
  verifyRoleAccess(input: RoleAccessVerificationInput): Promise<RoleAccessVerificationResult>;
  close(): Promise<void>;
}

export interface CompanyMemoryDatabaseService {
  ensureProvisioned(companyId: string): Promise<typeof companyMemoryDatabases.$inferSelect>;
  resolveRuntimeConfig(companyId: string, runId?: string): Promise<CompanyMemoryDatabaseRuntimeDescriptor | null>;
  rotateCredential(companyId: string): Promise<{ secretVersion: number; lastRotatedAt: Date }>;
  archiveCompanyMemory(companyId: string): Promise<void>;
  unarchiveCompanyMemory(companyId: string): Promise<void>;
  deleteCompanyMemory(companyId: string): Promise<void>;
  reconcileStaleLeases(): Promise<number>;
  isSupported(): boolean;
  isEligibleCompany(companyId: string): boolean;
}

export interface CompanyMemoryServiceOptions {
  adminDatabaseUrl?: string;
  enabled?: boolean;
  pilotCompanyIds?: readonly string[];
  ddlExecutor?: CompanyMemoryDdlExecutor;
}

export function deriveCompanyMemoryDatabaseNames(companyId: string): {
  databaseName: string;
  databaseRole: string;
} {
  const trimmed = companyId.trim().toLowerCase();
  if (!UUID_REGEX.test(trimmed)) {
    throw new CompanyMemoryDatabaseError("Invalid companyId UUID", "INVALID_COMPANY_ID");
  }
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  const databaseName = `pcmem_${hash}`;
  const databaseRole = `pcmem_r_${hash}`;

  if (!SAFE_PG_IDENTIFIER_REGEX.test(databaseName) || !SAFE_PG_IDENTIFIER_REGEX.test(databaseRole)) {
    throw new CompanyMemoryDatabaseError("Derived database identifier failed safety allowlist", "UNSAFE_IDENTIFIER");
  }

  return { databaseName, databaseRole };
}

export function quoteIdentifier(ident: string): string {
  if (!SAFE_PG_IDENTIFIER_REGEX.test(ident)) {
    throw new CompanyMemoryDatabaseError(`Unsafe PostgreSQL identifier: ${ident}`, "UNSAFE_IDENTIFIER");
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

export function sanitizeDbError(err: unknown, secrets: string[] = []): string {
  const raw = err instanceof Error ? err.message : String(err);
  let clean = raw
    .replace(/postgresql:\/\/[^@\s]+@[^\/\s]+(?:\/[^\s]*)?/gi, "postgresql://[REDACTED]")
    .replace(/postgres:\/\/[^@\s]+@[^\/\s]+(?:\/[^\s]*)?/gi, "postgres://[REDACTED]")
    .replace(/SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, "SCRAM-SHA-256$[REDACTED]");
  for (const s of secrets) {
    if (s && s.length > 0 && clean.includes(s)) {
      clean = clean.replaceAll(s, "[REDACTED]");
    }
  }
  return clean;
}

export interface LeaseHeartbeatHandle {
  isLost(): boolean;
  assertActive(): void;
  stop(): Promise<void>;
  getKnownExpiresAtMs(): number;
}

export function startLeaseHeartbeat(
  db: Db,
  recordId: string,
  leaseToken: string,
  initialExpiresAt?: Date | number,
  intervalMs = 40_000,
): LeaseHeartbeatHandle {
  let lost = false;
  let running = true;
  let activeRenewal: Promise<void> | null = null;
  let knownExpiresAtMs: number =
    initialExpiresAt instanceof Date
      ? initialExpiresAt.getTime()
      : typeof initialExpiresAt === "number"
      ? initialExpiresAt
      : Date.now() + LEASE_TTL_MS;

  async function performRenewal(): Promise<void> {
    if (!running || lost) return;
    try {
      const now = new Date();
      const newExpires = new Date(now.getTime() + LEASE_TTL_MS);
      const [renewed] = await db
        .update(companyMemoryDatabases)
        .set({ leaseExpiresAt: newExpires, updatedAt: now })
        .where(
          and(
            eq(companyMemoryDatabases.id, recordId),
            eq(companyMemoryDatabases.leaseToken, leaseToken),
            gt(companyMemoryDatabases.leaseExpiresAt, now),
          ),
        )
        .returning({ id: companyMemoryDatabases.id });

      if (!renewed) {
        lost = true;
      } else {
        knownExpiresAtMs = newExpires.getTime();
      }
    } catch {
      // Fail closed: do not treat network/db failure as harmless
      lost = true;
    }
  }

  const timer = setInterval(() => {
    if (activeRenewal) return; // prevent overlapping renewals
    activeRenewal = performRenewal().finally(() => {
      activeRenewal = null;
    });
  }, intervalMs);
  timer.unref?.();

  return {
    isLost: () => lost || Date.now() >= knownExpiresAtMs,
    getKnownExpiresAtMs: () => knownExpiresAtMs,
    assertActive: () => {
      if (lost || Date.now() >= knownExpiresAtMs) {
        lost = true;
        throw new CompanyMemoryDatabaseError(
          "Lease lost or expired during external operation",
          "LEASE_FENCED_OUT",
        );
      }
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      if (activeRenewal) {
        await activeRenewal.catch(() => {});
      }
    },
  };
}

export class PostgresCompanyMemoryDdlExecutor implements CompanyMemoryDdlExecutor {
  private readonly maintenanceClient: ReturnType<typeof postgres>;
  private readonly adminUrl: URL;
  private readonly sslConfig: any;

  constructor(private readonly adminDatabaseUrl: string) {
    this.adminUrl = new URL(adminDatabaseUrl);
    const sslParam = this.adminUrl.searchParams.get("sslmode")?.toLowerCase();
    this.sslConfig = sslParam === "disable" ? false : { rejectUnauthorized: false };
    this.maintenanceClient = postgres(adminDatabaseUrl, {
      max: 1,
      idle_timeout: 10,
      ssl: this.sslConfig,
      onnotice: () => {},
    });
  }

  async executeMaintenance(sqlText: string, params: unknown[] = []): Promise<any[]> {
    if (params.length > 0) {
      return this.maintenanceClient.unsafe(sqlText, params as any);
    }
    return this.maintenanceClient.unsafe(sqlText);
  }

  async withRole<T>(role: string, fn: (client?: any) => Promise<T>): Promise<T> {
    const client = postgres(this.adminDatabaseUrl, {
      max: 1,
      idle_timeout: 10,
      ssl: this.sslConfig,
      onnotice: () => {},
    });
    try {
      await client.unsafe(`SET ROLE ${quoteIdentifier(role)};`);
      return await fn(client);
    } finally {
      try {
        await client.unsafe("RESET ROLE;");
      } catch (err) {
        logger.error({ err: sanitizeDbError(err) }, "[company-memory] Failed to RESET ROLE on dedicated connection");
      } finally {
        await client.end().catch(() => {});
      }
    }
  }

  async executeTarget(databaseName: string, sqlText: string, params: unknown[] = []): Promise<any[]> {
    const targetUrl = new URL(this.adminDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    const targetClient = postgres(targetUrl.toString(), {
      max: 1,
      idle_timeout: 15,
      ssl: this.sslConfig,
      onnotice: () => {},
    });
    try {
      if (params.length > 0) {
        return await targetClient.unsafe(sqlText, params as any);
      }
      return await targetClient.unsafe(sqlText);
    } finally {
      await targetClient.end().catch(() => {});
    }
  }

  async verifyRoleAccess(input: RoleAccessVerificationInput): Promise<RoleAccessVerificationResult> {
    const roleUrl = new URL(this.adminDatabaseUrl);
    roleUrl.hostname = input.host;
    roleUrl.port = String(input.port);
    roleUrl.username = input.databaseRole;
    roleUrl.password = input.password;
    roleUrl.pathname = `/${input.databaseName}`;
    roleUrl.searchParams.set("sslmode", input.sslmode);

    const roleClient = postgres(roleUrl.toString(), {
      max: 1,
      idle_timeout: 5,
      ssl: this.sslConfig,
      onnotice: () => {},
    });

    try {
      // 1. Verify tenant role authentication to target DB
      const current = await roleClient`SELECT current_user, current_database();`;
      if (current.length === 0 || current[0].current_user !== input.databaseRole) {
        throw new CompanyMemoryDatabaseError("Role verification failed: connected as wrong user", "VERIFY_FAILED");
      }

      // 2. Verify pgvector extension is installed in target DB
      const extRows = await roleClient`SELECT 1 FROM pg_extension WHERE extname = 'vector';`;
      const vectorInstalled = extRows.length > 0;

      // 3. Query all non-target databases to check for forbidden CONNECT permissions
      const leakedRows = await roleClient<{ datname: string }[]>`
        SELECT datname
        FROM pg_database
        WHERE datname != current_database()
          AND has_database_privilege(current_user, datname, 'CONNECT') = true;
      `;

      // 4. Verify PUBLIC does NOT have CONNECT on target DB
      const publicCheck = await roleClient`
        SELECT has_database_privilege('public', current_database(), 'CONNECT') as has_connect;
      `;
      const publicHasTargetConnect = Boolean(publicCheck[0]?.has_connect);

      // 5. Verify provisioner does NOT retain permanent CONNECT unless superuser
      const adminUser = this.adminUrl.username || "postgres";
      const provisionerCheck = await roleClient<{ has_connect: boolean; is_super: boolean }[]>`
        SELECT has_database_privilege(${adminUser}, current_database(), 'CONNECT') as has_connect,
               COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = ${adminUser}), false) as is_super;
      `;
      const provisionerHasTargetConnect = Boolean(provisionerCheck[0]?.has_connect);
      const provisionerIsSuperuser = Boolean(provisionerCheck[0]?.is_super);

      return {
        connected: true,
        vectorInstalled,
        leakedDatabases: leakedRows.map((r: { datname: string }) => r.datname),
        publicHasTargetConnect,
        provisionerHasTargetConnect,
        provisionerIsSuperuser,
      };
    } finally {
      await roleClient.end().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.maintenanceClient.end().catch(() => {});
  }
}

export function createDisabledCompanyMemoryDatabaseService(): CompanyMemoryDatabaseService {
  return {
    ensureProvisioned: async () => {
      throw new CompanyMemoryDatabaseError("Tenant-isolated company memory databases are disabled", "DISABLED");
    },
    resolveRuntimeConfig: async () => null,
    rotateCredential: async () => {
      throw new CompanyMemoryDatabaseError("Tenant-isolated company memory databases are disabled", "DISABLED");
    },
    archiveCompanyMemory: async () => {},
    unarchiveCompanyMemory: async () => {},
    deleteCompanyMemory: async () => {},
    reconcileStaleLeases: async () => 0,
    isSupported: () => false,
    isEligibleCompany: () => false,
  };
}

export function createPostgresCompanyMemoryDatabaseService(
  db: Db,
  options: CompanyMemoryServiceOptions = {},
): CompanyMemoryDatabaseService {
  let isEnabled: boolean;
  let adminUrl: string;
  let pilotCompanyIds: readonly string[];

  if (options.enabled !== undefined) {
    if (!options.enabled) {
      return createDisabledCompanyMemoryDatabaseService();
    }
    // Explicitly enabled in options: validate strictly against identical rules
    if (!options.adminDatabaseUrl || options.adminDatabaseUrl.trim().length === 0) {
      throw new CompanyMemoryConfigurationError("Company memory is enabled but adminDatabaseUrl is missing or empty");
    }
    if (!options.pilotCompanyIds || options.pilotCompanyIds.length === 0) {
      throw new CompanyMemoryConfigurationError("Company memory is enabled but pilotCompanyIds allowlist is missing or empty");
    }
    for (const id of options.pilotCompanyIds) {
      if (id === "*" || !UUID_REGEX.test(id)) {
        throw new CompanyMemoryConfigurationError("pilotCompanyIds contains an invalid entry. Wildcard '*' is forbidden.");
      }
    }
    isEnabled = true;
    adminUrl = options.adminDatabaseUrl;
    pilotCompanyIds = Object.freeze(Array.from(new Set(options.pilotCompanyIds.map((s) => s.toLowerCase()))));
  } else {
    // Centralized validation from environment
    const centralized = getCompanyMemoryConfig();
    if (!centralized.enabled) {
      return createDisabledCompanyMemoryDatabaseService();
    }
    isEnabled = true;
    adminUrl = centralized.adminDatabaseUrl!;
    pilotCompanyIds = centralized.pilotCompanyIds;
  }

  let parsedAdminUrl: URL;
  try {
    parsedAdminUrl = new URL(adminUrl);
  } catch {
    throw new CompanyMemoryConfigurationError("adminDatabaseUrl is not a valid URL");
  }

  const ddlExecutor = options.ddlExecutor ?? new PostgresCompanyMemoryDdlExecutor(adminUrl);
  const secretProvider = getSecretProvider("local_encrypted");
  const leaseOwner = `srv_${process.pid}_${randomUUID().slice(0, 8)}`;

  function isEligibleCompany(companyId: string): boolean {
    if (!isEnabled) return false;
    return pilotCompanyIds.includes(companyId.trim().toLowerCase());
  }

  function assertPreflightInvariants(
    preflight: RoleAccessVerificationResult,
    databaseRole: string,
    databaseName: string,
  ): void {
    if (!preflight.connected) {
      throw new CompanyMemorySecurityIsolationError(
        `Security preflight failed: tenant role "${databaseRole}" cannot connect to target database "${databaseName}"`,
      );
    }

    if (!preflight.vectorInstalled) {
      throw new CompanyMemorySecurityIsolationError(
        "Security preflight failed: pgvector extension is not preinstalled in template1",
      );
    }

    if (preflight.publicHasTargetConnect) {
      throw new CompanyMemorySecurityIsolationError(
        `Security preflight failed: PUBLIC has CONNECT on target database "${databaseName}"`,
      );
    }

    if (preflight.provisionerHasTargetConnect) {
      if (preflight.provisionerIsSuperuser) {
        logger.warn(
          { databaseName, databaseRole },
          "[company-memory] Provisioner role is a superuser; has_database_privilege CONNECT is unrevocable. Proceeding with warning.",
        );
      } else {
        throw new CompanyMemorySecurityIsolationError(
          `Security preflight failed: provisioner role retains CONNECT on target database "${databaseName}"`,
        );
      }
    }

    if (preflight.leakedDatabases.length > 0) {
      throw new CompanyMemorySecurityIsolationError(
        `Security preflight failed: role "${databaseRole}" has CONNECT privilege on non-target databases (${preflight.leakedDatabases.join(", ")}). Revoke PUBLIC CONNECT cluster-wide.`,
      );
    }
  }

  type ClaimLeaseResult =
    | { kind: "already_ready"; row: typeof companyMemoryDatabases.$inferSelect }
    | { kind: "acquired"; recordId: string; leaseToken: string; row: typeof companyMemoryDatabases.$inferSelect };

  async function claimLease(
    companyId: string,
    operation: "provision" | "rotate" | "archive" | "unarchive" | "deprovision",
  ): Promise<ClaimLeaseResult> {
    const { databaseName, databaseRole } = deriveCompanyMemoryDatabaseNames(companyId);
    const host = parsedAdminUrl.hostname;
    const port = parseInt(parsedAdminUrl.port || "5432", 10);
    const sslmode = "require";
    const collectionName = "mem0_memories";
    const embeddingModel = "text-embedding-3-small";
    const embeddingDimensions = 1536;

    const leaseToken = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);

    return await db.transaction(async (tx) => {
      // Race-safe insert with onConflictDoNothing
      await tx
        .insert(companyMemoryDatabases)
        .values({
          companyId,
          databaseName,
          databaseRole,
          host,
          port,
          sslmode,
          collectionName,
          embeddingModel,
          embeddingDimensions,
          status: "pending",
          operation: "idle",
          attempts: 0,
          credentialEpoch: 1,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: companyMemoryDatabases.companyId });

      const existing = await tx
        .select()
        .from(companyMemoryDatabases)
        .where(eq(companyMemoryDatabases.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        throw new CompanyMemoryDatabaseError("Failed to resolve company memory database row", "ROW_NOT_FOUND");
      }

      // Check operation/status transitions allowed
      if (operation === "provision") {
        if (existing.status === "ready" && existing.secretId && !existing.pendingSecretVersion) {
          return { kind: "already_ready", row: existing };
        }
        if (!["pending", "failed"].includes(existing.status) && !(existing.status === "pending" && existing.leaseExpiresAt && existing.leaseExpiresAt < now)) {
          throw new CompanyMemoryDatabaseError(`Cannot provision company memory database from status "${existing.status}"`, "INVALID_STATE_TRANSITION");
        }
      } else if (operation === "rotate") {
        const canRecoverPending = Boolean(existing.pendingSecretVersion);
        if (existing.status !== "ready" && !(canRecoverPending && existing.status === "failed")) {
          throw new CompanyMemoryDatabaseError(`Cannot rotate credentials for database in status "${existing.status}"`, "INVALID_STATE_TRANSITION");
        }
      } else if (operation === "archive") {
        if (!["ready", "failed"].includes(existing.status)) {
          throw new CompanyMemoryDatabaseError(`Cannot archive company memory database from status "${existing.status}"`, "INVALID_STATE_TRANSITION");
        }
      } else if (operation === "unarchive") {
        if (existing.status !== "archived") {
          throw new CompanyMemoryDatabaseError(`Cannot unarchive company memory database from non-archived status "${existing.status}"`, "INVALID_STATE_TRANSITION");
        }
      } else if (operation === "deprovision") {
        if (existing.status === "deprovisioned") {
          throw new CompanyMemoryDatabaseError("Company memory database is already deprovisioned", "ALREADY_DEPROVISIONED");
        }
      }

      // Check if backoff is active
      if (existing.backoffUntil && existing.backoffUntil > now && existing.leaseToken !== leaseToken) {
        throw new CompanyMemoryDatabaseError(
          `Company memory operation in backoff until ${existing.backoffUntil.toISOString()}`,
          "IN_BACKOFF",
        );
      }

      // Claim lease if expired or matching token
      const [claimed] = await tx
        .update(companyMemoryDatabases)
        .set({
          operation,
          leaseToken,
          leaseOwner,
          leaseAcquiredAt: now,
          leaseExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(companyMemoryDatabases.id, existing.id),
            or(
              isNull(companyMemoryDatabases.leaseExpiresAt),
              lt(companyMemoryDatabases.leaseExpiresAt, now),
              eq(companyMemoryDatabases.leaseToken, leaseToken),
            ),
          ),
        )
        .returning();

      if (!claimed) {
        throw new CompanyMemoryDatabaseError(
          `Company memory database operation is locked by another process lease (expires at: ${existing.leaseExpiresAt?.toISOString()})`,
          "LEASE_ACQUISITION_FAILED",
        );
      }

      return { kind: "acquired", recordId: claimed.id, leaseToken, row: claimed };
    });
  }

  async function commitFencedSuccess(
    recordId: string,
    leaseToken: string,
    updates: Partial<typeof companyMemoryDatabases.$inferInsert>,
    executor: any = db,
    bumpCredentialEpoch = false,
  ): Promise<typeof companyMemoryDatabases.$inferSelect> {
    const now = new Date();
    const [committed] = await executor
      .update(companyMemoryDatabases)
      .set({
        ...updates,
        operation: "idle",
        leaseToken: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        attempts: 0,
        backoffUntil: null,
        lastError: null,
        ...(bumpCredentialEpoch
          ? { credentialEpoch: sql`${companyMemoryDatabases.credentialEpoch} + 1` }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(companyMemoryDatabases.id, recordId),
          eq(companyMemoryDatabases.leaseToken, leaseToken),
          gt(companyMemoryDatabases.leaseExpiresAt, now),
        ),
      )
      .returning();

    if (!committed) {
      throw new CompanyMemoryDatabaseError(
        "Fenced commit failed: lease was lost or expired during external operation",
        "LEASE_FENCED_OUT",
      );
    }

    return committed;
  }

  async function commitFencedFailure(
    recordId: string,
    leaseToken: string,
    errorMsg: string,
    nextStatus: "pending" | "ready" | "failed" | "archived" | "deprovisioning" | "deprovisioned" = "failed",
    attempts = 1,
    executor: any = db,
  ): Promise<void> {
    const now = new Date();
    const backoffMs = Math.min(60_000, 1000 * Math.pow(2, Math.min(attempts, 6)));
    const [failed] = await executor
      .update(companyMemoryDatabases)
      .set({
        status: nextStatus,
        operation: "idle",
        leaseToken: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        attempts: sql`${companyMemoryDatabases.attempts} + 1`,
        backoffUntil: new Date(now.getTime() + backoffMs),
        lastError: errorMsg,
        updatedAt: now,
      })
      .where(
        and(
          eq(companyMemoryDatabases.id, recordId),
          eq(companyMemoryDatabases.leaseToken, leaseToken),
          gt(companyMemoryDatabases.leaseExpiresAt, now),
        ),
      )
      .returning({ id: companyMemoryDatabases.id });

    if (!failed) {
      throw new CompanyMemoryDatabaseError(
        "Fenced failure commit failed: lease was lost or expired",
        "LEASE_FENCED_OUT",
      );
    }
  }

  async function ensureProvisioned(companyId: string): Promise<typeof companyMemoryDatabases.$inferSelect> {
    if (!isEligibleCompany(companyId)) {
      throw new CompanyMemoryDatabaseError("Company is not eligible for memory isolation pilot", "NOT_ELIGIBLE");
    }

    // Fast-path read
    const existingFast = await db
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (existingFast && existingFast.status === "ready" && existingFast.secretId && !existingFast.pendingSecretVersion) {
      return existingFast;
    }

    // Attempt claim or wait/converge
    let claim: ClaimLeaseResult | null = null;
    let attempts = 0;
    while (attempts < 10) {
      try {
        claim = await claimLease(companyId, "provision");
        break;
      } catch (err) {
        if (
          err instanceof CompanyMemoryDatabaseError &&
          (err.code === "LEASE_ACQUISITION_FAILED" || err.code === "IN_BACKOFF")
        ) {
          attempts++;
          await new Promise((r) => setTimeout(r, Math.min(500 * attempts, 2000)));
          const rowNow = await db
            .select()
            .from(companyMemoryDatabases)
            .where(eq(companyMemoryDatabases.companyId, companyId))
            .then((rows) => rows[0] ?? null);
          if (rowNow && rowNow.status === "ready" && rowNow.secretId && !rowNow.pendingSecretVersion) {
            return rowNow;
          }
          continue;
        }
        throw err;
      }
    }

    if (!claim) {
      throw new CompanyMemoryDatabaseError("Failed to acquire provision lease after multiple attempts", "LEASE_ACQUISITION_FAILED");
    }

    if (claim.kind === "already_ready") {
      return claim.row;
    }

    const { recordId, leaseToken, row } = claim;
    const databaseName = row.databaseName ?? deriveCompanyMemoryDatabaseNames(companyId).databaseName;
    const databaseRole = row.databaseRole ?? deriveCompanyMemoryDatabaseNames(companyId).databaseRole;
    const host = parsedAdminUrl.hostname;
    const port = parseInt(parsedAdminUrl.port || "5432", 10);
    const sslmode = "require";

    let plaintextPassword = "";
    let scramVerifierStr = "";
    const heartbeat = startLeaseHeartbeat(db, recordId, leaseToken, row.leaseExpiresAt ?? undefined);

    try {
      const password = generateRandomPassword();
      plaintextPassword = password;
      const scram = generateScramVerifier(password);
      scramVerifierStr = scram.verifier;

      // 1. Create or alter role using verifier
      const roleRows = await ddlExecutor.executeMaintenance(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [databaseRole],
      );
      if (roleRows.length === 0) {
        await ddlExecutor.executeMaintenance(
          `CREATE ROLE ${quoteIdentifier(databaseRole)} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${scram.verifier}';`,
        );
      } else {
        await ddlExecutor.executeMaintenance(
          `ALTER ROLE ${quoteIdentifier(databaseRole)} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${scram.verifier}';`,
        );
      }
      heartbeat.assertActive();

      // 2. Grant tenant role to provisioner role WITH SET TRUE, INHERIT FALSE
      await ddlExecutor.executeMaintenance(
        `GRANT ${quoteIdentifier(databaseRole)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;`,
      );
      heartbeat.assertActive();

      // 3. Create or alter database
      const dbRows = await ddlExecutor.executeMaintenance(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [databaseName],
      );
      if (dbRows.length === 0) {
        await ddlExecutor.executeMaintenance(
          `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(databaseRole)};`,
        );
      } else {
        await ddlExecutor.executeMaintenance(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${quoteIdentifier(databaseRole)};`,
        );
      }
      heartbeat.assertActive();

      // 4. Set role to tenant to revoke public connect and grant tenant connect
      await ddlExecutor.withRole(databaseRole, async (roleClient) => {
        const exec = (q: string) => (roleClient ? roleClient.unsafe(q) : ddlExecutor.executeMaintenance(q));
        await exec(
          `REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC;`,
        );
        await exec(
          `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(databaseRole)};`,
        );
        await exec(
          `ALTER DATABASE ${quoteIdentifier(databaseName)} ALLOW_CONNECTIONS true;`,
        );
      });
      heartbeat.assertActive();

      // 5. Preflight check
      const preflight = await ddlExecutor.verifyRoleAccess({
        databaseName,
        databaseRole,
        password: plaintextPassword,
        host,
        port,
        sslmode,
      });
      assertPreflightInvariants(preflight, databaseRole, databaseName);
      heartbeat.assertActive();

      // 6. Encrypt secret outside DB tx
      const secretKey = "HERMES_MEMORY_POSTGRES_PASSWORD";
      const secretName = `Memory Postgres Password (${databaseName})`;
      const preparedSecret = await secretProvider.createSecret({ value: plaintextPassword });
      heartbeat.assertActive();

      // 7. Fenced commit in short DB tx
      return await db.transaction(async (tx) => {
        const existingSecret = await tx
          .select()
          .from(companySecrets)
          .where(
            and(
              eq(companySecrets.companyId, companyId),
              eq(companySecrets.key, secretKey),
              isNull(companySecrets.deletedAt),
              eq(companySecrets.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        let secretId: string;
        let secretVersion: number;

        if (!existingSecret) {
          const [createdSecret] = await tx
            .insert(companySecrets)
            .values({
              companyId,
              scope: "company",
              key: secretKey,
              name: secretName,
              provider: "local_encrypted",
              status: "active",
              managedMode: "paperclip_managed",
              latestVersion: 1,
              updatedAt: new Date(),
            })
            .returning();

          await tx.insert(companySecretVersions).values({
            secretId: createdSecret.id,
            version: 1,
            status: "current",
            material: preparedSecret.material,
            valueSha256: preparedSecret.valueSha256,
            fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
            providerVersionRef: preparedSecret.providerVersionRef ?? null,
          });

          secretId = createdSecret.id;
          secretVersion = 1;
        } else {
          const nextVersion = existingSecret.latestVersion + 1;

          await tx
            .update(companySecretVersions)
            .set({ status: "archived" })
            .where(eq(companySecretVersions.secretId, existingSecret.id));

          await tx.insert(companySecretVersions).values({
            secretId: existingSecret.id,
            version: nextVersion,
            status: "current",
            material: preparedSecret.material,
            valueSha256: preparedSecret.valueSha256,
            fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
            providerVersionRef: preparedSecret.providerVersionRef ?? null,
          });

          await tx
            .update(companySecrets)
            .set({ latestVersion: nextVersion, lastRotatedAt: new Date(), updatedAt: new Date() })
            .where(eq(companySecrets.id, existingSecret.id));

          secretId = existingSecret.id;
          secretVersion = nextVersion;
        }

        return await commitFencedSuccess(
          recordId,
          leaseToken,
          {
            status: "ready",
            secretId,
            secretVersion,
            lastProvisionedAt: new Date(),
          },
          tx,
          true,
        );
      });
    } catch (err) {
      if (err instanceof CompanyMemorySecurityIsolationError) {
        // Attempt lockdown under withRole, resetting afterward
        await ddlExecutor
          .withRole(databaseRole, async (roleClient) => {
            const exec = (q: string) => (roleClient ? roleClient.unsafe(q) : ddlExecutor.executeMaintenance(q));
            await exec(`ALTER DATABASE ${quoteIdentifier(databaseName)} ALLOW_CONNECTIONS false;`);
          })
          .catch(() => {});
        await ddlExecutor
          .executeMaintenance(
            `ALTER ROLE ${quoteIdentifier(databaseRole)} NOLOGIN;`,
          )
          .catch(() => {});
      }
      const sanitized = sanitizeDbError(err, [plaintextPassword, scramVerifierStr]);
      await commitFencedFailure(recordId, leaseToken, sanitized, "failed", row.attempts + 1).catch(() => {});
      throw err;
    } finally {
      await heartbeat.stop();
    }
  }

  async function resolveRuntimeConfig(companyId: string, runId?: string): Promise<CompanyMemoryDatabaseRuntimeDescriptor | null> {
    if (!isEligibleCompany(companyId)) {
      return null;
    }

    if (runId) {
      logger.debug({ companyId, runId }, "[company-memory] Resolving runtime config for run");
    }

    let row = await db
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (!row || (row.status === "failed" && row.operation !== "rotate" && !row.pendingSecretVersion)) {
      try {
        row = await ensureProvisioned(companyId);
      } catch (err) {
        const reason = sanitizeDbError(err);
        throw new CompanyMemoryNotReadyError(`Failed to provision company memory database: ${reason}`);
      }
    }

    // If in rotation or pending rotation state, attempt convergence
    if (row && (row.operation === "rotate" || row.pendingSecretVersion)) {
      try {
        await rotateCredential(companyId);
        row = await db
          .select()
          .from(companyMemoryDatabases)
          .where(eq(companyMemoryDatabases.companyId, companyId))
          .then((rows) => rows[0] ?? null);
      } catch (err) {
        throw new CompanyMemoryNotReadyError(`Company memory database is in pending rotation and recovery failed: ${sanitizeDbError(err)}`);
      }
    }

    if (!row || row.status !== "ready" || !row.secretId || !row.secretVersion) {
      throw new CompanyMemoryNotReadyError(
        `Company memory database is not ready (status: ${row?.status ?? "unprovisioned"})`,
      );
    }

    // Require company secret to be active, not deleted, and version to be current
    const secretRow = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.id, row.secretId), isNull(companySecrets.deletedAt), eq(companySecrets.status, "active")))
      .then((rows) => rows[0] ?? null);

    if (!secretRow) {
      throw new CompanyMemoryDatabaseError("Company secret is inactive or deleted", "SECRET_INACTIVE");
    }

    const secretVersionRow = await db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, row.secretId),
          eq(companySecretVersions.version, row.secretVersion),
          isNull(companySecretVersions.revokedAt),
          eq(companySecretVersions.status, "current"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!secretVersionRow) {
      throw new CompanyMemoryDatabaseError(`Secret version ${row.secretVersion} is not in current active status`, "SECRET_NOT_FOUND");
    }

    const password = await secretProvider.resolveVersion({
      material: secretVersionRow.material,
      externalRef: null,
    });

    return {
      host: row.host,
      port: row.port,
      user: row.databaseRole,
      password,
      dbname: row.databaseName,
      sslmode: "require",
      collectionName: row.collectionName,
      embeddingModel: row.embeddingModel,
      embeddingDimensions: row.embeddingDimensions,
    };
  }

  async function rotateCredential(companyId: string): Promise<{ secretVersion: number; lastRotatedAt: Date }> {
    const claim = await claimLease(companyId, "rotate");
    if (claim.kind === "already_ready") {
      throw new CompanyMemoryDatabaseError("Cannot rotate: database already in ready state with no active rotation", "INVALID_STATE");
    }
    const { recordId, leaseToken, row } = claim;
    const databaseName = row.databaseName ?? deriveCompanyMemoryDatabaseNames(companyId).databaseName;
    const databaseRole = row.databaseRole ?? deriveCompanyMemoryDatabaseNames(companyId).databaseRole;
    const host = parsedAdminUrl.hostname;
    const port = parseInt(parsedAdminUrl.port || "5432", 10);
    const sslmode = "require";

    let plaintextPassword = "";
    let scramVerifierStr = "";
    let pendingStaged = false;
    const heartbeat = startLeaseHeartbeat(db, recordId, leaseToken, row.leaseExpiresAt ?? undefined);

    try {
      let pendingVersion = row.pendingSecretVersion;
      let pendingVerifier = row.pendingScramVerifier;

      if (pendingVersion && pendingVerifier && row.pendingScramSalt && row.pendingScramIterations) {
        pendingStaged = true;
        // Recovering existing pending rotation
        const secretVersionRow = await db
          .select()
          .from(companySecretVersions)
          .where(
            and(
              eq(companySecretVersions.secretId, row.secretId!),
              eq(companySecretVersions.version, pendingVersion),
              eq(companySecretVersions.status, "disabled"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!secretVersionRow) {
          throw new CompanyMemoryDatabaseError("Pending secret version missing from storage or not in disabled status", "PENDING_SECRET_MISSING");
        }

        plaintextPassword = await secretProvider.resolveVersion({ material: secretVersionRow.material, externalRef: null });

        // Rederive SCRAM verifier from decrypted plaintext + persisted salt/iterations and verify constant-time
        const rederived = rederiveScramVerifier(plaintextPassword, row.pendingScramSalt, row.pendingScramIterations);
        const expectedBuf = Buffer.from(rederived.verifier);
        const storedBuf = Buffer.from(pendingVerifier);
        if (expectedBuf.length !== storedBuf.length || !timingSafeEqual(expectedBuf, storedBuf)) {
          throw new CompanyMemoryDatabaseError("Pending verifier mismatch on recovery", "VERIFIER_MISMATCH");
        }
        scramVerifierStr = rederived.verifier;
      } else {
        // Derive new credentials
        plaintextPassword = generateRandomPassword();
        const scram = generateScramVerifier(plaintextPassword);
        scramVerifierStr = scram.verifier;

        const secret = await db
          .select()
          .from(companySecrets)
          .where(and(eq(companySecrets.id, row.secretId!), isNull(companySecrets.deletedAt), eq(companySecrets.status, "active")))
          .then((rows) => rows[0] ?? null);

        if (!secret) throw new CompanyMemoryDatabaseError("Secret not found or inactive for rotation", "SECRET_NOT_FOUND");
        const nextVersion = secret.latestVersion + 1;
        pendingVersion = nextVersion;

        // Prepare encrypted secret material outside DB transaction
        const preparedSecret = await secretProvider.createSecret({ value: plaintextPassword });

        // Atomic pending secret insert + mapping update in single fenced transaction
        await db.transaction(async (tx) => {
          await tx.insert(companySecretVersions).values({
            secretId: secret.id,
            version: nextVersion,
            status: "disabled",
            material: preparedSecret.material,
            valueSha256: preparedSecret.valueSha256,
            fingerprintSha256: preparedSecret.fingerprintSha256 ?? preparedSecret.valueSha256,
            providerVersionRef: preparedSecret.providerVersionRef ?? null,
          });

          const now = new Date();
          const [updated] = await tx
            .update(companyMemoryDatabases)
            .set({
              pendingSecretId: secret.id,
              pendingSecretVersion: nextVersion,
              pendingScramSalt: scram.saltBase64,
              pendingScramIterations: scram.iterations,
              pendingScramVerifier: scram.verifier,
              updatedAt: now,
            })
            .where(
              and(
                eq(companyMemoryDatabases.id, recordId),
                eq(companyMemoryDatabases.leaseToken, leaseToken),
                gt(companyMemoryDatabases.leaseExpiresAt, now),
              ),
            )
            .returning({ id: companyMemoryDatabases.id });

          if (!updated) {
            throw new CompanyMemoryDatabaseError("Lease expired before pending rotation could be committed", "LEASE_FENCED_OUT");
          }
        });
        pendingStaged = true;
      }
      heartbeat.assertActive();

      // ALTER ROLE with verifier outside DB transaction
      await ddlExecutor.executeMaintenance(
        `ALTER ROLE ${quoteIdentifier(databaseRole)} WITH PASSWORD '${scramVerifierStr}';`,
      );
      heartbeat.assertActive();

      // Verify new authentication and all preflight invariants
      const preflight = await ddlExecutor.verifyRoleAccess({
        databaseName,
        databaseRole,
        password: plaintextPassword,
        host,
        port,
        sslmode,
      });
      assertPreflightInvariants(preflight, databaseRole, databaseName);
      heartbeat.assertActive();

      // Commit fenced activation of new version and demotion of old version in single transaction
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(companySecretVersions)
          .set({ status: "archived" })
          .where(eq(companySecretVersions.secretId, row.secretId!));

        await tx
          .update(companySecretVersions)
          .set({ status: "current" })
          .where(and(eq(companySecretVersions.secretId, row.secretId!), eq(companySecretVersions.version, pendingVersion!)));

        await tx
          .update(companySecrets)
          .set({ latestVersion: pendingVersion!, lastRotatedAt: now, updatedAt: now })
          .where(eq(companySecrets.id, row.secretId!));

        await commitFencedSuccess(
          recordId,
          leaseToken,
          {
            status: "ready",
            secretVersion: pendingVersion!,
            lastRotatedAt: now,
            pendingSecretId: null,
            pendingSecretVersion: null,
            pendingScramSalt: null,
            pendingScramIterations: null,
            pendingScramVerifier: null,
          },
          tx,
          true,
        );
      });

      return { secretVersion: pendingVersion!, lastRotatedAt: now };
    } catch (err) {
      const sanitized = sanitizeDbError(err, [plaintextPassword, scramVerifierStr]);
      const failureStatus = pendingStaged ? "failed" : (row.status as any);
      await commitFencedFailure(recordId, leaseToken, sanitized, failureStatus, row.attempts + 1).catch(() => {});
      throw new CompanyMemoryDatabaseError(`Rotation failed: ${sanitized}`, "ROTATION_FAILED");
    } finally {
      await heartbeat.stop();
    }
  }

  async function archiveCompanyMemory(companyId: string): Promise<void> {
    const mapping = await db
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (!mapping || mapping.status === "archived" || mapping.status === "deprovisioned") return;

    const claim = await claimLease(companyId, "archive");
    if (claim.kind === "already_ready") return;
    const { recordId, leaseToken, row } = claim;
    const heartbeat = startLeaseHeartbeat(db, recordId, leaseToken, row.leaseExpiresAt ?? undefined);

    try {
      // 1. Under withRole: disable new connections and terminate active sessions
      await ddlExecutor.withRole(mapping.databaseRole, async (roleClient) => {
        const exec = (q: string, p?: unknown[]) => (roleClient ? roleClient.unsafe(q, p) : ddlExecutor.executeMaintenance(q, p));
        await exec(`ALTER DATABASE ${quoteIdentifier(mapping.databaseName)} ALLOW_CONNECTIONS false;`);
        await exec(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid != pg_backend_pid();",
          [mapping.databaseName],
        );
      });
      heartbeat.assertActive();

      // 2. Disable login on tenant role
      await ddlExecutor.executeMaintenance(
        `ALTER ROLE ${quoteIdentifier(mapping.databaseRole)} NOLOGIN;`,
      );
      heartbeat.assertActive();

      await commitFencedSuccess(recordId, leaseToken, { status: "archived" });
    } catch (err) {
      const sanitized = sanitizeDbError(err);
      await commitFencedFailure(recordId, leaseToken, sanitized, mapping.status as any, row.attempts + 1).catch(() => {});
      throw new CompanyMemoryDatabaseError(`Archive memory failed: ${sanitized}`, "ARCHIVE_FAILED");
    } finally {
      await heartbeat.stop();
    }
  }

  async function unarchiveCompanyMemory(companyId: string): Promise<void> {
    const mapping = await db
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (!mapping || mapping.status !== "archived") return;

    const claim = await claimLease(companyId, "unarchive");
    if (claim.kind === "already_ready") return;
    const { recordId, leaseToken, row } = claim;
    const heartbeat = startLeaseHeartbeat(db, recordId, leaseToken, row.leaseExpiresAt ?? undefined);

    try {
      // 1. Re-enable login on role
      await ddlExecutor.executeMaintenance(
        `ALTER ROLE ${quoteIdentifier(mapping.databaseRole)} LOGIN;`,
      );
      heartbeat.assertActive();

      // 2. Under withRole: re-enable connections
      await ddlExecutor.withRole(mapping.databaseRole, async (roleClient) => {
        const exec = (q: string) => (roleClient ? roleClient.unsafe(q) : ddlExecutor.executeMaintenance(q));
        await exec(
          `ALTER DATABASE ${quoteIdentifier(mapping.databaseName)} ALLOW_CONNECTIONS true;`,
        );
      });
      heartbeat.assertActive();

      // 3. Resolve active current secret and verify complete preflight
      if (!mapping.secretId || !mapping.secretVersion) {
        throw new CompanyMemoryDatabaseError("Missing secret pointer for unarchive", "SECRET_NOT_FOUND");
      }

      const secretRow = await db
        .select()
        .from(companySecrets)
        .where(and(eq(companySecrets.id, mapping.secretId), isNull(companySecrets.deletedAt), eq(companySecrets.status, "active")))
        .then((rows) => rows[0] ?? null);

      if (!secretRow) {
        throw new CompanyMemoryDatabaseError("Company secret is inactive or deleted", "SECRET_INACTIVE");
      }

      const secretVersionRow = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, mapping.secretId),
            eq(companySecretVersions.version, mapping.secretVersion),
            isNull(companySecretVersions.revokedAt),
            eq(companySecretVersions.status, "current"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!secretVersionRow) {
        throw new CompanyMemoryDatabaseError("Current secret version is not active", "SECRET_NOT_FOUND");
      }

      const pass = await secretProvider.resolveVersion({ material: secretVersionRow.material, externalRef: null });
      const preflight = await ddlExecutor.verifyRoleAccess({
        databaseName: mapping.databaseName,
        databaseRole: mapping.databaseRole,
        password: pass,
        host: mapping.host,
        port: mapping.port,
        sslmode: mapping.sslmode,
      });

      assertPreflightInvariants(preflight, mapping.databaseRole, mapping.databaseName);
      heartbeat.assertActive();

      await commitFencedSuccess(recordId, leaseToken, { status: "ready" });
    } catch (err) {
      // Re-lockdown on failure
      await ddlExecutor
        .withRole(mapping.databaseRole, async (roleClient) => {
          const exec = (q: string) => (roleClient ? roleClient.unsafe(q) : ddlExecutor.executeMaintenance(q));
          await exec(
            `ALTER DATABASE ${quoteIdentifier(mapping.databaseName)} ALLOW_CONNECTIONS false;`,
          );
        })
        .catch(() => {});
      await ddlExecutor
        .executeMaintenance(
          `ALTER ROLE ${quoteIdentifier(mapping.databaseRole)} NOLOGIN;`,
        )
        .catch(() => {});
      const sanitized = sanitizeDbError(err);
      await commitFencedFailure(recordId, leaseToken, sanitized, "archived", row.attempts + 1).catch(() => {});
      throw new CompanyMemoryDatabaseError(`Unarchive memory failed: ${sanitized}`, "UNARCHIVE_FAILED");
    } finally {
      await heartbeat.stop();
    }
  }

  async function deleteCompanyMemory(companyId: string): Promise<void> {
    const mapping = await db
      .select()
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    if (!mapping) return;
    if (mapping.status === "deprovisioned") return;

    const claim = await claimLease(companyId, "deprovision");
    if (claim.kind === "already_ready") return;
    const { recordId, leaseToken, row } = claim;
    const heartbeat = startLeaseHeartbeat(db, recordId, leaseToken, row.leaseExpiresAt ?? undefined);
    let dropCompleted = false;

    try {
      // 1. Terminate sessions
      await ddlExecutor.executeMaintenance(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1;",
        [mapping.databaseName],
      );
      heartbeat.assertActive();

      // 2. Drop database as tenant under withRole
      await ddlExecutor.withRole(mapping.databaseRole, async (roleClient) => {
        const exec = (q: string) => (roleClient ? roleClient.unsafe(q) : ddlExecutor.executeMaintenance(q));
        await exec(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(mapping.databaseName)} WITH (FORCE);`,
        );
      });
      dropCompleted = true;
      heartbeat.assertActive();

      // 3. Revoke membership and drop role
      await ddlExecutor.executeMaintenance(
        `REVOKE ${quoteIdentifier(mapping.databaseRole)} FROM CURRENT_USER;`,
      );
      await ddlExecutor.executeMaintenance(
        `DROP ROLE IF EXISTS ${quoteIdentifier(mapping.databaseRole)};`,
      );
      heartbeat.assertActive();

      // 4. Verify absence in system catalogs
      const remainingDb = await ddlExecutor.executeMaintenance("SELECT 1 FROM pg_database WHERE datname = $1", [mapping.databaseName]);
      const remainingRole = await ddlExecutor.executeMaintenance("SELECT 1 FROM pg_roles WHERE rolname = $1", [mapping.databaseRole]);
      if (remainingDb.length > 0 || remainingRole.length > 0) {
        throw new CompanyMemoryDatabaseError("Failed to verify absence of database/role after drop", "DROP_VERIFY_FAILED");
      }
      heartbeat.assertActive();

      // 5. Soft-delete secret and commit deprovisioned tombstone in SAME control-plane tx
      await db.transaction(async (tx) => {
        if (mapping.secretId) {
          await tx
            .update(companySecrets)
            .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(companySecrets.id, mapping.secretId));
        }

        await commitFencedSuccess(recordId, leaseToken, { status: "deprovisioned" }, tx);
      });
    } catch (err) {
      const sanitized = sanitizeDbError(err);
      const failureStatus = dropCompleted ? "failed" : (mapping.status as any);
      await commitFencedFailure(recordId, leaseToken, sanitized, failureStatus, row.attempts + 1).catch(() => {});
      throw new CompanyMemoryDatabaseError(`Deprovision memory failed: ${sanitized}`, "DEPROVISION_FAILED");
    } finally {
      await heartbeat.stop();
    }
  }

  async function reconcileStaleLeases(): Promise<number> {
    const now = new Date();
    const staleRows = await db
      .select()
      .from(companyMemoryDatabases)
      .where(and(lt(companyMemoryDatabases.leaseExpiresAt, now), sql`${companyMemoryDatabases.operation} != 'idle'`));

    let reconciled = 0;
    for (const r of staleRows) {
      let recoveryStatus = r.status;
      if (r.operation === "provision") {
        recoveryStatus = "failed";
      } else if (r.operation === "rotate") {
        recoveryStatus = r.pendingSecretVersion ? "failed" : "ready";
      } else if (r.operation === "archive") {
        recoveryStatus = "ready";
      } else if (r.operation === "unarchive") {
        recoveryStatus = "archived";
      } else if (r.operation === "deprovision") {
        recoveryStatus = "failed";
      }

      try {
        await db
          .update(companyMemoryDatabases)
          .set({
            status: recoveryStatus,
            operation: "idle",
            leaseToken: null,
            leaseOwner: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
            attempts: sql`${companyMemoryDatabases.attempts} + 1`,
            lastError: "Reconciled stale unacknowledged lease",
            updatedAt: now,
          })
          .where(
            and(
              eq(companyMemoryDatabases.id, r.id),
              eq(companyMemoryDatabases.leaseToken, r.leaseToken!),
              lt(companyMemoryDatabases.leaseExpiresAt, now),
            ),
          );
        reconciled++;
      } catch (err) {
        logger.warn(
          { err: sanitizeDbError(err), rowId: r.id, companyId: r.companyId },
          "[company-memory] Failed to reconcile stale lease for row",
        );
      }
    }
    return reconciled;
  }

  return {
    isSupported: () => true,
    isEligibleCompany,
    ensureProvisioned,
    resolveRuntimeConfig,
    rotateCredential,
    archiveCompanyMemory,
    unarchiveCompanyMemory,
    deleteCompanyMemory,
    reconcileStaleLeases,
  };
}

let defaultServiceInstance: CompanyMemoryDatabaseService | null = null;

/**
 * Global singleton factory for CompanyMemoryDatabaseService.
 *
 * Contract: First caller wins. The `db` instance passed to the first call initializes
 * the singleton used for all subsequent calls across the server (e.g. index.ts boots first,
 * binding the server db for companies.ts and heartbeat.ts). For isolated instances in tests
 * or custom options, call `createPostgresCompanyMemoryDatabaseService(db, options)` directly.
 * Use `resetCompanyMemoryDatabaseServiceForTests()` to clear the singleton between tests.
 */
export function companyMemoryDatabaseService(db: Db): CompanyMemoryDatabaseService {
  if (!defaultServiceInstance) {
    defaultServiceInstance = createPostgresCompanyMemoryDatabaseService(db, {});
  }
  return defaultServiceInstance;
}

export function resetCompanyMemoryDatabaseServiceForTests(): void {
  defaultServiceInstance = null;
}
