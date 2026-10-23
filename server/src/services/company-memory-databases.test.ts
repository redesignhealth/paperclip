import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  deriveCompanyMemoryDatabaseNames,
  quoteIdentifier,
  sanitizeDbError,
  createPostgresCompanyMemoryDatabaseService,
  createDisabledCompanyMemoryDatabaseService,
  startLeaseHeartbeat,
  CompanyMemorySecurityIsolationError,
  CompanyMemoryDatabaseError,
  CompanyMemoryNotReadyError,
  CompanyMemoryConfigurationError,
  type CompanyMemoryDdlExecutor,
} from "./company-memory-databases.js";

const pgDialect = new PgDialect();

describe("company-memory-databases", () => {
  const companyA = "11111111-1111-4111-8111-111111111111";
  const companyB = "22222222-2222-4222-8222-222222222222";

  describe("deterministic naming and identifier safety", () => {
    it("derives deterministic, non-leaking database and role identifiers from company UUID", () => {
      const namesA1 = deriveCompanyMemoryDatabaseNames(companyA);
      const namesA2 = deriveCompanyMemoryDatabaseNames(companyA);
      expect(namesA1).toEqual(namesA2);

      expect(namesA1.databaseName).toMatch(/^pcmem_[0-9a-f]{32}$/);
      expect(namesA1.databaseRole).toMatch(/^pcmem_r_[0-9a-f]{32}$/);

      // Verify no company name or UUID leakage in derived identifiers
      expect(namesA1.databaseName).not.toContain(companyA);
      expect(namesA1.databaseRole).not.toContain(companyA);
    });

    it("produces distinct database names for different companies", () => {
      const namesA = deriveCompanyMemoryDatabaseNames(companyA);
      const namesB = deriveCompanyMemoryDatabaseNames(companyB);

      expect(namesA.databaseName).not.toBe(namesB.databaseName);
      expect(namesA.databaseRole).not.toBe(namesB.databaseRole);
    });

    it("rejects invalid or malicious companyId strings", () => {
      expect(() => deriveCompanyMemoryDatabaseNames("not-a-uuid")).toThrow(CompanyMemoryDatabaseError);
      expect(() => deriveCompanyMemoryDatabaseNames("company; DROP TABLE users;--")).toThrow(CompanyMemoryDatabaseError);
      expect(() => deriveCompanyMemoryDatabaseNames("")).toThrow(CompanyMemoryDatabaseError);
    });

    it("quotes identifiers safely and rejects unallowed characters", () => {
      expect(quoteIdentifier("pcmem_abc123")).toBe('"pcmem_abc123"');
      expect(() => quoteIdentifier('bad"ident')).toThrow(CompanyMemoryDatabaseError);
      expect(() => quoteIdentifier("bad-ident")).toThrow(CompanyMemoryDatabaseError);
      expect(() => quoteIdentifier("bad ident")).toThrow(CompanyMemoryDatabaseError);
    });

    it("sanitizes error messages to remove credentials, DSNs, and SCRAM verifiers", () => {
      const sensitivePassword = "SecretPassword123!";
      const err = new Error(
        `Connection failed to postgresql://user:${sensitivePassword}@db.internal.net:5432/mydb with SCRAM-SHA-256$4096:salt$stored:server`,
      );
      const cleaned = sanitizeDbError(err, [sensitivePassword]);
      expect(cleaned).not.toContain(sensitivePassword);
      expect(cleaned).toContain("postgresql://[REDACTED]");
      expect(cleaned).toContain("SCRAM-SHA-256$[REDACTED]");

      // Pathless DSN regression tests (W2-k / Argus 36)
      const pathlessPg = sanitizeDbError("connect failed postgresql://admin:S3cr3tPw@rds.host:5432");
      expect(pathlessPg).toBe("connect failed postgresql://[REDACTED]");
      expect(pathlessPg).not.toContain("S3cr3tPw");

      const pathlessPostgres = sanitizeDbError("ECONNREFUSED postgres://admin:S3cr3tPw@rds.host:5432 end");
      expect(pathlessPostgres).toBe("ECONNREFUSED postgres://[REDACTED] end");
      expect(pathlessPostgres).not.toContain("S3cr3tPw");
    });
  });

  describe("provisioning, security preflight, and lifecycle state machine", () => {
    let mockDdl: CompanyMemoryDdlExecutor;
    let maintenanceSqlLog: string[];
    let targetSqlLog: Array<{ db: string; sql: string }>;
    let leakedDatabasesToReport: string[];

    // In-memory mock DB table states
    let memoryDbRows: any[];
    let companySecretRows: any[];
    let companySecretVersionRows: any[];
    let companyRows: any[];

    let mockDb: any;

    beforeEach(() => {
      maintenanceSqlLog = [];
      targetSqlLog = [];
      leakedDatabasesToReport = [];

      memoryDbRows = [];
      companySecretRows = [];
      companySecretVersionRows = [];
      companyRows = [];

      mockDdl = {
        executeMaintenance: vi.fn(async (sqlText: string, params: unknown[] = []) => {
          maintenanceSqlLog.push(sqlText);
          if (sqlText.includes("SELECT 1 FROM pg_roles")) {
            return []; // role does not exist initially
          }
          if (sqlText.includes("SELECT 1 FROM pg_database")) {
            return []; // database does not exist initially
          }
          return [];
        }),
        executeTarget: vi.fn(async (databaseName: string, sqlText: string) => {
          targetSqlLog.push({ db: databaseName, sql: sqlText });
          return [];
        }),
        withRole: vi.fn(async (role: string, fn: () => Promise<any>) => {
          maintenanceSqlLog.push(`SET ROLE ${quoteIdentifier(role)};`);
          try {
            return await fn();
          } finally {
            maintenanceSqlLog.push("RESET ROLE;");
          }
        }),
        verifyRoleAccess: vi.fn(async () => {
          return {
            connected: true,
            vectorInstalled: true,
            leakedDatabases: leakedDatabasesToReport,
            publicHasTargetConnect: false,
            provisionerHasTargetConnect: false,
            provisionerIsSuperuser: false,
          };
        }),
        close: vi.fn(async () => {}),
      };

      // Lightweight mock drizzle DB implementation for memory tables
      mockDb = {
        transaction: async (cb: any) => cb(mockDb),
        execute: async () => [],
        select: () => ({
          from: (table: any) => ({
            where: (condition: any) => ({
              then: (resolve: any) => {
                const tableName = (table as any)[Symbol.for("drizzle:Name")] || "";
                if (tableName === "company_memory_databases") {
                  return resolve(memoryDbRows);
                }
                if (tableName === "company_secrets") {
                  return resolve(companySecretRows);
                }
                if (tableName === "company_secret_versions") {
                  return resolve(companySecretVersionRows);
                }
                if (tableName === "companies") {
                  if (condition) {
                    try {
                      const { sql: sqlStr, params } = pgDialect.sqlToQuery(condition);
                      const idMatch = sqlStr.match(/"id"\s*=\s*\$(\d+)/);
                      if (idMatch) {
                        const idParam = params[parseInt(idMatch[1], 10) - 1];
                        return resolve(companyRows.filter((r) => r.id === idParam));
                      }
                    } catch {}
                  }
                  return resolve(companyRows);
                }
                return resolve([]);
              },
            }),
          }),
        }),
        insert: (table: any) => ({
          values: (vals: any) => {
            const id = vals.id ?? "mock-uuid-" + Math.random();
            const row = { id, ...vals };
            const tableName = (table as any)[Symbol.for("drizzle:Name")] || "";
            if (tableName === "company_memory_databases") {
              if (!memoryDbRows.some((r) => r.companyId === vals.companyId)) {
                memoryDbRows.push(row);
              }
            } else if (tableName === "company_secrets") {
              companySecretRows.push(row);
            } else if (tableName === "company_secret_versions") {
              companySecretVersionRows.push(row);
            }
            return {
              onConflictDoNothing: () => ({
                returning: () => [row],
              }),
              returning: () => [row],
            };
          },
        }),
        update: (table: any) => ({
          set: (vals: any) => ({
            where: (cond: any) => {
              const tableName = (table as any)[Symbol.for("drizzle:Name")] || "";
              let updated: any = null;
              if (tableName === "company_memory_databases") {
                if (memoryDbRows.length > 0) {
                  let targetRow = memoryDbRows[0];
                  let matches = true;
                  if (cond) {
                    try {
                      const { sql: sqlStr, params } = pgDialect.sqlToQuery(cond);
                      const idMatch = sqlStr.match(/"id"\s*=\s*\$(\d+)/);
                      if (idMatch) {
                        const idParam = params[parseInt(idMatch[1], 10) - 1];
                        const found = memoryDbRows.find((r) => r.id === idParam);
                        if (found) {
                          targetRow = found;
                        } else {
                          matches = false;
                        }
                      }
                      // Fenced commit check: lease_token = $N AND lease_expires_at > $N
                      if (sqlStr.includes('"lease_expires_at" >')) {
                        const tokenMatch = sqlStr.match(/"lease_token"\s*=\s*\$(\d+)/);
                        if (tokenMatch) {
                          const tokenParam = params[parseInt(tokenMatch[1], 10) - 1];
                          if (targetRow.leaseToken !== tokenParam) {
                            matches = false;
                          }
                        }
                        const expiresGtMatch = sqlStr.match(/"lease_expires_at"\s*>\s*\$(\d+)/);
                        if (expiresGtMatch) {
                          const expiresParam = params[parseInt(expiresGtMatch[1], 10) - 1] as Date;
                          if (!targetRow.leaseExpiresAt || targetRow.leaseExpiresAt <= expiresParam) {
                            matches = false;
                          }
                        }
                      }
                    } catch {
                      // ignore parse errors
                    }
                  }
                  if (matches) {
                    Object.assign(targetRow, vals);
                    updated = targetRow;
                  }
                }
              } else if (tableName === "company_secrets") {
                if (companySecretRows.length > 0) {
                  Object.assign(companySecretRows[0], vals);
                  updated = companySecretRows[0];
                }
              }
              return {
                returning: () => (updated ? [updated] : []),
              };
            },
          }),
        }),
        delete: (table: any) => ({
          where: (cond: any) => {
            const tableName = (table as any)[Symbol.for("drizzle:Name")] || "";
            if (tableName === "company_memory_databases") {
              memoryDbRows = [];
            } else if (tableName === "company_secrets") {
              companySecretRows = [];
            }
            return {
              catch: () => {},
            };
          },
        }),
      };
    });

    function createTestService(extraOptions: any = {}) {
      return createPostgresCompanyMemoryDatabaseService(mockDb, {
        enabled: true,
        adminDatabaseUrl: "postgres://admin:secret@rds-shared.internal:5432/postgres?sslmode=require",
        pilotCompanyIds: [companyA, companyB],
        ddlExecutor: mockDdl,
        ...extraOptions,
      });
    }

    it("provisions company memory database, role, privileges, and pgvector extension", async () => {
      const service = createTestService();

      const row = await service.ensureProvisioned(companyA);
      expect(row.status).toBe("ready");
      expect(row.companyId).toBe(companyA);
      expect(row.databaseName).toMatch(/^pcmem_/);
      expect(row.databaseRole).toMatch(/^pcmem_r_/);
      expect(row.sslmode).toBe("require");

      // Verify DDL steps occurred
      expect(maintenanceSqlLog.some((sql) => sql.includes("CREATE ROLE"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("SCRAM-SHA-256$"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("WITH SET TRUE, INHERIT FALSE"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("CREATE DATABASE"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("REVOKE CONNECT ON DATABASE") && sql.includes("FROM PUBLIC"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("GRANT CONNECT ON DATABASE"))).toBe(true);

      // Verify no CREATE EXTENSION target path (vector inherited from template1)
      expect(targetSqlLog.some((item) => item.sql.includes("CREATE EXTENSION"))).toBe(false);

      // Verify role access verification was called
      expect(mockDdl.verifyRoleAccess).toHaveBeenCalled();

      // Verify secret was created
      expect(companySecretRows.length).toBe(1);
      expect(companySecretRows[0].key).toBe("HERMES_MEMORY_POSTGRES_PASSWORD");
      expect(companySecretVersionRows.length).toBe(1);
    });

    it("fails closed if the newly created role has CONNECT on non-target databases due to cluster-wide PUBLIC CONNECT", async () => {
      // Simulate cluster where PUBLIC CONNECT on postgres and paperclip has not been revoked
      leakedDatabasesToReport = ["postgres", "paperclip_main", "pcmem_other_tenant"];

      const service = createTestService();

      await expect(service.ensureProvisioned(companyA)).rejects.toThrow(
        CompanyMemorySecurityIsolationError,
      );

      // Verify row state transitioned to failed
      expect(memoryDbRows.length).toBe(1);
      expect(memoryDbRows[0].status).toBe("failed");
      expect(memoryDbRows[0].lastError).toContain("Security preflight failed");
      expect(memoryDbRows[0].lastError).toContain("Revoke PUBLIC CONNECT cluster-wide");
    });

    it("succeeds when non-target databases with nominal CONNECT are non-connectable (e.g. template0 with datallowconn=false)", async () => {
      // When preflight excludes non-connectable databases (datallowconn=false), leakedDatabases is empty
      leakedDatabasesToReport = [];

      const service = createTestService();
      const row = await service.ensureProvisioned(companyA);

      expect(row.status).toBe("ready");
      expect(mockDdl.verifyRoleAccess).toHaveBeenCalled();
      expect(memoryDbRows.length).toBe(1);
      expect(memoryDbRows[0].status).toBe("ready");
      expect(memoryDbRows[0].lastError).toBeNull();
    });

    it("resolves runtime config for provisioned ready company memory", async () => {
      const service = createTestService();

      await service.ensureProvisioned(companyA);
      const runtimeConfig = await service.resolveRuntimeConfig(companyA);

      expect(runtimeConfig).not.toBeNull();
      expect(runtimeConfig!.host).toBe("rds-shared.internal");
      expect(runtimeConfig!.port).toBe(5432);
      expect(runtimeConfig!.sslmode).toBe("require");
      expect(runtimeConfig!.user).toMatch(/^pcmem_r_/);
      expect(runtimeConfig!.dbname).toMatch(/^pcmem_/);
      expect(runtimeConfig!.password).toBeTruthy();
    });

    it("rotates credentials, updates secret version and role password", async () => {
      const service = createTestService();

      await service.ensureProvisioned(companyA);
      const initialSecretVersion = memoryDbRows[0].secretVersion;

      const rotated = await service.rotateCredential(companyA);
      expect(rotated.secretVersion).toBe(initialSecretVersion + 1);

      expect(maintenanceSqlLog.some((sql) => sql.includes("ALTER ROLE") && sql.includes("PASSWORD"))).toBe(true);
      expect(companySecretVersionRows.length).toBe(2);
    });

    it("deactivates role on company archive and restores on unarchive", async () => {
      const service = createTestService();

      await service.ensureProvisioned(companyA);
      expect(memoryDbRows[0].status).toBe("ready");

      // Archive
      await service.archiveCompanyMemory(companyA);
      expect(memoryDbRows[0].status).toBe("archived");
      expect(maintenanceSqlLog.some((sql) => sql.includes("NOLOGIN"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("ALLOW_CONNECTIONS false"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("pg_terminate_backend"))).toBe(true);

      // Unarchive
      await service.unarchiveCompanyMemory(companyA);
      expect(memoryDbRows[0].status).toBe("ready");
      expect(maintenanceSqlLog.some((sql) => sql.includes("LOGIN"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("ALLOW_CONNECTIONS true"))).toBe(true);
    });

    it("fails closed on security preflight if PUBLIC has CONNECT on target DB or vector is missing", async () => {
      // 1. PUBLIC has target connect
      mockDdl.verifyRoleAccess = vi.fn(async () => ({
        connected: true,
        vectorInstalled: true,
        leakedDatabases: [],
        publicHasTargetConnect: true, // violation!
        provisionerHasTargetConnect: false,
        provisionerIsSuperuser: false,
      }));

      const service = createTestService();

      await expect(service.ensureProvisioned(companyA)).rejects.toThrow(
        CompanyMemorySecurityIsolationError,
      );

      // Reset mock rows for part 2 so backoff from part 1 does not interfere
      memoryDbRows = [];

      // 2. vector extension missing
      mockDdl.verifyRoleAccess = vi.fn(async () => ({
        connected: true,
        vectorInstalled: false, // violation!
        leakedDatabases: [],
        publicHasTargetConnect: false,
        provisionerHasTargetConnect: false,
        provisionerIsSuperuser: false,
      }));

      await expect(service.ensureProvisioned(companyA)).rejects.toThrow(
        CompanyMemorySecurityIsolationError,
      );
    });

    it("reconciles stale expired leases safely", async () => {
      const now = new Date();
      memoryDbRows.push({
        id: "stale-record-1",
        companyId: companyA,
        status: "pending",
        operation: "provision",
        leaseToken: "stale-token",
        leaseExpiresAt: new Date(now.getTime() - 60_000), // expired 1m ago
        attempts: 1,
      });

      const service = createTestService();

      const count = await service.reconcileStaleLeases();
      expect(count).toBe(1);
      expect(memoryDbRows[0].operation).toBe("idle");
      expect(memoryDbRows[0].leaseToken).toBeNull();
      expect(memoryDbRows[0].status).toBe("failed");
    });

    it("drops database, role, and cleans up records on delete", async () => {
      const service = createTestService();

      await service.ensureProvisioned(companyA);
      await service.deleteCompanyMemory(companyA);

      expect(maintenanceSqlLog.some((sql) => sql.includes("DROP DATABASE IF EXISTS"))).toBe(true);
      expect(maintenanceSqlLog.some((sql) => sql.includes("DROP ROLE IF EXISTS"))).toBe(true);
      // Retains tombstone row in mapping table with status deprovisioned until company hard delete
      expect(memoryDbRows[0].status).toBe("deprovisioned");
      expect(companySecretRows[0].status).toBe("deleted");
    });

    it("propagates errors on archive and unarchive failure without advancing status", async () => {
      const failingDdl: CompanyMemoryDdlExecutor = {
        executeMaintenance: vi.fn(async () => {
          throw new Error("Simulated maintenance DDL failure");
        }),
        executeTarget: vi.fn(async () => []),
        withRole: vi.fn(async () => {
          throw new Error("Simulated withRole DDL failure");
        }),
        verifyRoleAccess: vi.fn(async () => ({
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        })),
        close: vi.fn(async () => {}),
      };

      const service = createTestService();
      await service.ensureProvisioned(companyA);
      expect(memoryDbRows[0].status).toBe("ready");

      const failingService = createTestService({ ddlExecutor: failingDdl });

      // Archive failure must throw and leave status ready (or failed)
      await expect(failingService.archiveCompanyMemory(companyA)).rejects.toThrow("Archive memory failed");
      expect(memoryDbRows[0].status).not.toBe("archived");

      // Mark row archived and clear backoff to test unarchive failure
      memoryDbRows[0].status = "archived";
      memoryDbRows[0].backoffUntil = null;
      await expect(failingService.unarchiveCompanyMemory(companyA)).rejects.toThrow("Unarchive memory failed");
      expect(memoryDbRows[0].status).toBe("archived");
    });

    it("propagates errors on delete failure without setting deprovisioned or dropping secret", async () => {
      const failingDeleteDdl: CompanyMemoryDdlExecutor = {
        executeMaintenance: vi.fn(async (sql: string) => {
          if (sql.includes("DROP DATABASE")) {
            throw new Error("Simulated DROP DATABASE failure: database in use");
          }
          return [];
        }),
        executeTarget: vi.fn(async () => []),
        withRole: vi.fn(async (_role, fn) => fn()),
        verifyRoleAccess: vi.fn(async () => ({
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        })),
        close: vi.fn(async () => {}),
      };

      const service = createTestService();
      await service.ensureProvisioned(companyA);
      expect(memoryDbRows[0].status).toBe("ready");

      const failingService = createTestService({ ddlExecutor: failingDeleteDdl });

      await expect(failingService.deleteCompanyMemory(companyA)).rejects.toThrow("Deprovision memory failed");
      // Mapping status is NOT deprovisioned, and secret is NOT deleted
      expect(memoryDbRows[0].status).not.toBe("deprovisioned");
      expect(companySecretRows[0].status).toBe("active");
    });

    it("handles provisioner CONNECT invariant: superuser succeeds with warning, non-superuser fails closed", async () => {
      // 1. Non-superuser with CONNECT on target DB -> fails closed
      mockDdl.verifyRoleAccess = vi.fn(async () => ({
        connected: true,
        vectorInstalled: true,
        leakedDatabases: [],
        publicHasTargetConnect: false,
        provisionerHasTargetConnect: true,
        provisionerIsSuperuser: false,
      }));

      const service = createTestService();
      await expect(service.ensureProvisioned(companyA)).rejects.toThrow(
        CompanyMemorySecurityIsolationError,
      );

      // Reset mock rows for part 2
      memoryDbRows = [];

      // 2. Superuser with CONNECT on target DB -> succeeds (CONNECT is unrevocable for superuser)
      mockDdl.verifyRoleAccess = vi.fn(async () => ({
        connected: true,
        vectorInstalled: true,
        leakedDatabases: [],
        publicHasTargetConnect: false,
        provisionerHasTargetConnect: true,
        provisionerIsSuperuser: true,
      }));

      const row = await service.ensureProvisioned(companyA);
      expect(row.status).toBe("ready");
    });

    it("sets status to failed instead of ready if error occurs after DROP DATABASE has completed", async () => {
      const failingPostDropDdl: CompanyMemoryDdlExecutor = {
        executeMaintenance: vi.fn(async (sql: string) => {
          if (sql.includes("DROP ROLE")) {
            throw new Error("Simulated DROP ROLE failure after DROP DATABASE completed");
          }
          return [];
        }),
        executeTarget: vi.fn(async () => []),
        withRole: vi.fn(async (_role, fn) => fn()),
        verifyRoleAccess: vi.fn(async () => ({
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        })),
        close: vi.fn(async () => {}),
      };

      const service = createTestService();
      await service.ensureProvisioned(companyA);
      expect(memoryDbRows[0].status).toBe("ready");

      const failingService = createTestService({ ddlExecutor: failingPostDropDdl });

      await expect(failingService.deleteCompanyMemory(companyA)).rejects.toThrow("Deprovision memory failed");
      // Status must be failed, NOT restored to ready, because physical DB was already dropped
      expect(memoryDbRows[0].status).toBe("failed");
    });

    it("preserves ready status when rotation fails prior to staging verifier", async () => {
      const service = createTestService();
      await service.ensureProvisioned(companyA);
      expect(memoryDbRows[0].status).toBe("ready");

      // Inject a mock secretProvider that fails on createSecret
      const { getSecretProvider } = await import("../secrets/provider-registry.js");
      const realProvider = getSecretProvider("local_encrypted");
      const origCreateSecret = realProvider.createSecret;
      realProvider.createSecret = vi.fn(async () => {
        throw new Error("Simulated secret encryption failure before staging");
      });

      try {
        await expect(service.rotateCredential(companyA)).rejects.toThrow("Rotation failed");
        // Status must NOT be failed; it must remain ready because ALTER ROLE never ran
        expect(memoryDbRows[0].status).toBe("ready");
      } finally {
        realProvider.createSecret = origCreateSecret;
      }
    });

    it("fails with LEASE_FENCED_OUT when lease token is modified concurrently before commit", async () => {
      const service = createTestService();
      // Hook verifyRoleAccess to simulate another process stealing the lease during external DDL/verification
      mockDdl.verifyRoleAccess = vi.fn(async () => {
        if (memoryDbRows.length > 0) {
          memoryDbRows[0].leaseToken = "stolen-by-other-worker";
        }
        return {
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        };
      });

      let thrown: any = null;
      try {
        await service.ensureProvisioned(companyA);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.code).toBe("LEASE_FENCED_OUT");
      expect(thrown.message).toContain("Fenced commit failed");
    });

    describe("universal company scope ('all' mode)", () => {
      it("exposes companyScope property on disabled and active services", () => {
        const disabled = createDisabledCompanyMemoryDatabaseService();
        expect(disabled.companyScope).toBe("allowlist");

        const allowlistSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "allowlist",
          pilotCompanyIds: [companyA],
          ddlExecutor: mockDdl,
        });
        expect(allowlistSvc.companyScope).toBe("allowlist");

        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });
        expect(allSvc.companyScope).toBe("all");
      });

      it("evaluates isEligibleCompany synchronously in 'all' mode: valid UUIDs eligible, invalid rejected", () => {
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });

        // Any valid UUID is eligible in 'all' mode
        expect(allSvc.isEligibleCompany(companyA)).toBe(true);
        expect(allSvc.isEligibleCompany(companyB)).toBe(true);
        expect(allSvc.isEligibleCompany("33333333-3333-4333-8333-333333333333")).toBe(true);

        // Non-UUID strings are rejected synchronously
        expect(allSvc.isEligibleCompany("not-a-uuid")).toBe(false);
        expect(allSvc.isEligibleCompany("*")).toBe(false);
        expect(allSvc.isEligibleCompany("")).toBe(false);
        expect(allSvc.isEligibleCompany("   ")).toBe(false);
      });

      it("rejects non-existent company before creating any mapping row or executing DDL", async () => {
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });

        // companyA does not exist in companyRows
        expect(companyRows.length).toBe(0);

        let thrown: any = null;
        try {
          await allSvc.ensureProvisioned(companyA);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).not.toBeNull();
        expect(thrown).toBeInstanceOf(CompanyMemoryDatabaseError);
        expect(thrown.code).toBe("COMPANY_NOT_FOUND");
        expect(thrown.message).toContain("does not exist");

        // Assert NO mapping row was inserted and NO DDL executed
        expect(memoryDbRows.length).toBe(0);
        expect(maintenanceSqlLog.length).toBe(0);
      });

      it("rejects archived company before creating any mapping row or executing DDL", async () => {
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });

        companyRows.push({
          id: companyA,
          name: "Archived Company",
          status: "archived",
        });

        let thrown: any = null;
        try {
          await allSvc.ensureProvisioned(companyA);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).not.toBeNull();
        expect(thrown).toBeInstanceOf(CompanyMemoryDatabaseError);
        expect(thrown.code).toBe("COMPANY_ARCHIVED");
        expect(thrown.message).toContain("is archived");

        // Assert NO mapping row was inserted and NO DDL executed
        expect(memoryDbRows.length).toBe(0);
        expect(maintenanceSqlLog.length).toBe(0);
      });

      it("provisions active existing company in 'all' mode, then fast-path returns ready mapping idempotently", async () => {
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });

        companyRows.push({
          id: companyA,
          name: "Active Test Company",
          status: "active",
        });

        const row = await allSvc.ensureProvisioned(companyA);
        expect(row.status).toBe("ready");
        expect(row.companyId).toBe(companyA);
        expect(memoryDbRows.length).toBe(1);

        const ddlCountBeforeFastPath = maintenanceSqlLog.length;
        expect(ddlCountBeforeFastPath).toBeGreaterThan(0);

        // Fast-path read returns existing ready row without executing additional DDL
        const fastRow = await allSvc.ensureProvisioned(companyA);
        expect(fastRow.status).toBe("ready");
        expect(fastRow.id).toBe(row.id);
        expect(maintenanceSqlLog.length).toBe(ddlCountBeforeFastPath);
      });

      it("narrowing from 'all' to 'allowlist' does not strand lifecycle operations (archive, unarchive, delete)", async () => {
        // Step 1: Provision companyA under 'all' mode
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });
        companyRows.push({ id: companyA, name: "Company A", status: "active" });
        await allSvc.ensureProvisioned(companyA);
        expect(memoryDbRows[0].status).toBe("ready");

        // Step 2: Service is narrowed to 'allowlist' with only companyB in pilotCompanyIds (companyA is unlisted)
        const narrowedSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "allowlist",
          pilotCompanyIds: [companyB],
          ddlExecutor: mockDdl,
        });

        // companyA is not eligible for new provisioning
        expect(narrowedSvc.isEligibleCompany(companyA)).toBe(false);

        // Lifecycle archive still succeeds (isSupported-only)
        await narrowedSvc.archiveCompanyMemory(companyA);
        expect(memoryDbRows[0].status).toBe("archived");

        // Lifecycle unarchive still succeeds
        await narrowedSvc.unarchiveCompanyMemory(companyA);
        expect(memoryDbRows[0].status).toBe("ready");

        // Lifecycle delete still succeeds
        await narrowedSvc.deleteCompanyMemory(companyA);
        expect(memoryDbRows[0].status).toBe("deprovisioned");
      });

      it("rejects malformed pilot UUID entries passed via service options in 'all' mode (not just 'allowlist' mode)", () => {
        expect(() =>
          createPostgresCompanyMemoryDatabaseService(mockDb, {
            enabled: true,
            adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
            companyScope: "all",
            pilotCompanyIds: ["not-a-uuid"],
            ddlExecutor: mockDdl,
          }),
        ).toThrow(CompanyMemoryConfigurationError);

        // Wildcard is forbidden via the service options path in 'all' mode too
        expect(() =>
          createPostgresCompanyMemoryDatabaseService(mockDb, {
            enabled: true,
            adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
            companyScope: "all",
            pilotCompanyIds: [companyA, "*"],
            ddlExecutor: mockDdl,
          }),
        ).toThrow(CompanyMemoryConfigurationError);
      });

      it("DEFECT (fail-open scope): an invalid companyScope string injected via service options must be rejected, not silently treated as 'all'", () => {
        // The env parser rejects any scope other than 'allowlist'/'all', but the
        // service-options path bypasses env parsing entirely (it is the path the
        // probe and programmatic callers use). Contract: an out-of-enum scope
        // value must fail closed here too. Current implementation: anything
        // !== 'allowlist' (including typos like 'ANY'/'universal') falls into
        // the 'all' else-branch and provisions universally.
        expect(() =>
          createPostgresCompanyMemoryDatabaseService(mockDb, {
            enabled: true,
            adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
            companyScope: "ANY" as any,
            ddlExecutor: mockDdl,
          }),
        ).toThrow(CompanyMemoryConfigurationError);
      });

      it("DEFECT (fast-path ordering): an archived company with an existing ready mapping must be rejected with COMPANY_ARCHIVED, not fast-path-returned", async () => {
        // The 'all'-mode guard ("company exists and is not archived before any
        // new mapping/DDL") must apply BEFORE the ready fast-path return. Probe:
        // a company archived out-of-band (direct status change, or the
        // best-effort co-archive in companies.ts failed) while its mapping row
        // stayed 'ready' must NOT keep receiving provisioned memory state.
        const allSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });

        companyRows.push({ id: companyA, name: "Archived Out Of Band", status: "archived" });
        memoryDbRows.push({
          id: "mapping-ready-1",
          companyId: companyA,
          status: "ready",
          operation: "idle",
          secretId: "secret-1",
          secretVersion: 1,
          pendingSecretVersion: null,
          databaseName: "pcmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          databaseRole: "pcmem_r_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          host: "host",
          port: 5432,
          leaseToken: null,
          leaseExpiresAt: null,
          attempts: 0,
        });

        let thrown: any = null;
        try {
          await allSvc.ensureProvisioned(companyA);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).not.toBeNull();
        expect(thrown).toBeInstanceOf(CompanyMemoryDatabaseError);
        expect(thrown.code).toBe("COMPANY_ARCHIVED");
      });

      // ---- all-scope rotation guard regressions (guard-first rotateCredential) ----
      // rotateCredential must await assertCompanyActiveForMemory BEFORE
      // claimLease: an archived/nonexistent company with an existing mapping
      // row must be rejected with NO lease/mapping writes, NO secret resolve,
      // NO provider create, and NO DDL. (Guard is all-only: the allowlist
      // rotation path is covered by the legacy test above.)
      function makeAllScopeService() {
        return createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "all",
          ddlExecutor: mockDdl,
        });
      }

      function seedReadyMappingRow(companyId: string, overrides: Record<string, unknown> = {}) {
        memoryDbRows.push({
          id: "mapping-ready-" + companyId,
          companyId,
          status: "ready",
          operation: "idle",
          secretId: "secret-" + companyId,
          secretVersion: 1,
          pendingSecretVersion: null,
          databaseName: "pcmem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          databaseRole: "pcmem_r_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          host: "host",
          port: 5432,
          leaseToken: null,
          leaseExpiresAt: null,
          attempts: 0,
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          ...overrides,
        });
        companySecretRows.push({
          id: "secret-" + companyId,
          companyId,
          key: "HERMES_MEMORY_POSTGRES_PASSWORD",
          name: "hermes memory postgres password",
          status: "active",
          latestVersion: 1,
        });
        companySecretVersionRows.push({
          id: "version-" + companyId,
          secretId: "secret-" + companyId,
          version: 1,
          status: "current",
          material: { alg: "mock", ciphertext: "mock-material" },
          valueSha256: "mock-sha",
          fingerprintSha256: "mock-sha",
        });
      }

      async function spySecretProvider() {
        const { getSecretProvider } = await import("../secrets/provider-registry.js");
        const provider = getSecretProvider("local_encrypted");
        const origCreate = provider.createSecret;
        const origResolve = provider.resolveVersion;
        const createSpy = vi.fn(origCreate.bind(provider));
        const resolveSpy = vi.fn(origResolve.bind(provider));
        provider.createSecret = createSpy as any;
        provider.resolveVersion = resolveSpy as any;
        return {
          spies: { createSpy, resolveSpy },
          restore: () => {
            provider.createSecret = origCreate;
            provider.resolveVersion = origResolve;
          },
        };
      }

      async function expectRotationGuardRefused(service: any, companyId: string, expectedCode: string) {
        const rowsBefore = JSON.parse(JSON.stringify(memoryDbRows));
        const secretsBefore = companySecretRows.length;
        const versionsBefore = companySecretVersionRows.length;
        const ddlBefore = maintenanceSqlLog.length;
        const { spies, restore } = await spySecretProvider();
        try {
          let thrown: any = null;
          try {
            await service.rotateCredential(companyId);
          } catch (err) {
            thrown = err;
          }
          expect(thrown).not.toBeNull();
          expect(thrown).toBeInstanceOf(CompanyMemoryNotReadyError);
          expect(thrown.code).toBe(expectedCode);

          // NO lease/mapping writes: the mapping row set is byte-identical
          // (no lease claim, no status/pendingSecretVersion/updatedAt change).
          expect(JSON.parse(JSON.stringify(memoryDbRows))).toEqual(rowsBefore);
          // NO secret rows created or mutated.
          expect(companySecretRows.length).toBe(secretsBefore);
          expect(companySecretVersionRows.length).toBe(versionsBefore);
          // NO secret resolved and NO provider create.
          expect(spies.resolveSpy).not.toHaveBeenCalled();
          expect(spies.createSpy).not.toHaveBeenCalled();
          // NO DDL executed (no ALTER ROLE, nothing at all).
          expect(maintenanceSqlLog.length).toBe(ddlBefore);
          expect(maintenanceSqlLog.some((sql) => sql.includes("ALTER ROLE"))).toBe(false);
        } finally {
          restore();
        }
      }

      it("all-scope rotation: archived company with an existing ready mapping row is refused before any lease, write, resolve, or DDL", async () => {
        const allSvc = makeAllScopeService();
        companyRows.push({ id: companyA, name: "Archived Rotation Co", status: "archived" });
        seedReadyMappingRow(companyA);

        await expectRotationGuardRefused(allSvc, companyA, "COMPANY_ARCHIVED");
      });

      it("all-scope rotation: nonexistent company with an existing ready mapping row is refused before any lease, write, resolve, or DDL", async () => {
        const allSvc = makeAllScopeService();
        // No company row for companyA at all; a ready mapping row exists, so
        // any code path that skips the guard would claim the lease and rotate.
        seedReadyMappingRow(companyA);

        await expectRotationGuardRefused(allSvc, companyA, "COMPANY_NOT_FOUND");
      });

      it("all-scope rotation: archived company with a pending-rotation row is refused before lease convergence", async () => {
        // A row mid-rotation (pendingSecretVersion set) is the case where
        // rotation would normally converge the pending rotation; the guard
        // must refuse it for an archived company before any lease claim.
        const allSvc = makeAllScopeService();
        companyRows.push({ id: companyA, name: "Archived Pending Rotation Co", status: "archived" });
        seedReadyMappingRow(companyA, {
          status: "ready",
          operation: "rotate",
          pendingSecretVersion: 2,
          pendingSecretId: "secret-" + companyA,
        });

        await expectRotationGuardRefused(allSvc, companyA, "COMPANY_ARCHIVED");
      });

      it("all-scope rotation: ACTIVE company with an existing ready mapping row still rotates (guard does not block active rotation)", async () => {
        const allSvc = makeAllScopeService();
        companyRows.push({ id: companyA, name: "Active Rotation Co", status: "active" });
        seedReadyMappingRow(companyA);

        const rotated = await allSvc.rotateCredential(companyA);
        expect(rotated.secretVersion).toBe(2);
        expect(maintenanceSqlLog.some((sql) => sql.includes("ALTER ROLE") && sql.includes("PASSWORD"))).toBe(true);
        // New secret version staged by the rotation.
        expect(companySecretVersionRows.length).toBe(2);
      });

      it("legacy allowlist rotation is unchanged: the guard is a no-op outside 'all' scope", async () => {
        // Allowlist scope with companyA piloted: even with NO company row in
        // the companies table (the legacy harness never seeded one), the
        // rotation must proceed exactly as before the guard existed.
        const allowlistSvc = createPostgresCompanyMemoryDatabaseService(mockDb, {
          enabled: true,
          adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
          companyScope: "allowlist",
          pilotCompanyIds: [companyA],
          ddlExecutor: mockDdl,
        });
        seedReadyMappingRow(companyA);

        const rotated = await allowlistSvc.rotateCredential(companyA);
        expect(rotated.secretVersion).toBe(2);
        expect(maintenanceSqlLog.some((sql) => sql.includes("ALTER ROLE") && sql.includes("PASSWORD"))).toBe(true);
      });
    });
  });

  describe("feature flag and pilot allowlist gating", () => {
    it("returns disabled service when feature flag is off", async () => {
      const disabledSvc = createPostgresCompanyMemoryDatabaseService({} as any, {
        enabled: false,
      });
      expect(disabledSvc.isSupported()).toBe(false);
      expect(await disabledSvc.resolveRuntimeConfig(companyA)).toBeNull();
      await expect(disabledSvc.ensureProvisioned(companyA)).rejects.toThrow("disabled");
    });

    it("enforces pilot company allowlist when specified", async () => {
      const service = createPostgresCompanyMemoryDatabaseService({} as any, {
        enabled: true,
        adminDatabaseUrl: "postgres://admin:pass@host:5432/postgres?sslmode=require",
        pilotCompanyIds: [companyA], // Only companyA is in pilot
        ddlExecutor: {
          executeMaintenance: vi.fn(async () => []),
          executeTarget: vi.fn(async () => []),
          withRole: vi.fn(async (_role, fn) => fn()),
        verifyRoleAccess: vi.fn(async () => ({
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        })),
          close: vi.fn(async () => {}),
        },
      });

      expect(await service.resolveRuntimeConfig(companyB)).toBeNull();
      await expect(service.ensureProvisioned(companyB)).rejects.toThrow("not eligible");
    });

    it("guarantees withRole resets role even when inner callback fails", async () => {
      let resetExecuted = false;
      const executor = {
        executeMaintenance: vi.fn(async (sql: string) => {
          if (sql.includes("RESET ROLE")) {
            resetExecuted = true;
          }
          return [];
        }),
        executeTarget: vi.fn(async () => []),
        withRole: async function <T>(role: string, fn: () => Promise<T>): Promise<T> {
          try {
            await this.executeMaintenance(`SET ROLE ${quoteIdentifier(role)};`);
            return await fn();
          } finally {
            await this.executeMaintenance("RESET ROLE;");
          }
        },
        verifyRoleAccess: vi.fn(async () => ({
          connected: true,
          vectorInstalled: true,
          leakedDatabases: [],
          publicHasTargetConnect: false,
          provisionerHasTargetConnect: false,
          provisionerIsSuperuser: false,
        })),
        close: vi.fn(async () => {}),
      };

      await expect(
        executor.withRole("test_role", async () => {
          throw new Error("Deliberate failure inside role session");
        }),
      ).rejects.toThrow("Deliberate failure inside role session");

      expect(resetExecuted).toBe(true);
    });
  });

  describe("startLeaseHeartbeat", () => {
    it("fails closed on renewal exception and marks lease lost", async () => {
      vi.useFakeTimers();
      try {
        const mockFailingDb: any = {
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => Promise.reject(new Error("Simulated network failure on lease renewal")),
              }),
            }),
          }),
        };

        const handle = startLeaseHeartbeat(mockFailingDb, "rec-1", "token-1", Date.now() + 120_000, 10_000);
        expect(handle.isLost()).toBe(false);
        expect(() => handle.assertActive()).not.toThrow();

        // Advance timer past renewal tick
        await vi.advanceTimersByTimeAsync(11_000);

        expect(handle.isLost()).toBe(true);
        expect(() => handle.assertActive()).toThrow(/Lease lost or expired/);

        await handle.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("detects stalled event loop past known expiry and throws LEASE_FENCED_OUT", async () => {
      vi.useFakeTimers();
      try {
        const mockSilentDb: any = {
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => Promise.resolve([]),
              }),
            }),
          }),
        };

        const initialExpires = Date.now() + 50_000;
        // Interval is 60s, but lease expires in 50s; simulate stall by advancing time 55s before next tick
        const handle = startLeaseHeartbeat(mockSilentDb, "rec-1", "token-1", initialExpires, 60_000);
        expect(handle.isLost()).toBe(false);

        vi.advanceTimersByTime(51_000);

        // Even before timer callback ran, assertActive checks Date.now() >= knownExpiresAtMs
        expect(handle.isLost()).toBe(true);
        expect(() => handle.assertActive()).toThrow(/Lease lost or expired/);

        await handle.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("prevents overlapping renewals and stops cleanly", async () => {
      vi.useFakeTimers();
      try {
        let updateCalls = 0;
        let resolveUpdate: (() => void) | null = null;

        const mockSlowDb: any = {
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () =>
                  new Promise((resolve) => {
                    updateCalls++;
                    resolveUpdate = () => resolve([{ id: "rec-1" }]);
                  }),
              }),
            }),
          }),
        };

        const handle = startLeaseHeartbeat(mockSlowDb, "rec-1", "token-1", Date.now() + 120_000, 5_000);

        // First interval tick triggers first renewal
        await vi.advanceTimersByTimeAsync(5_500);
        expect(updateCalls).toBe(1);

        // Second tick while first is still pending must NOT trigger second renewal
        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateCalls).toBe(1);

        // Resolve first renewal
        resolveUpdate!();
        await vi.advanceTimersByTimeAsync(100);

        // Third tick now triggers second renewal
        await vi.advanceTimersByTimeAsync(5_000);
        expect(updateCalls).toBe(2);
        resolveUpdate!();
        await vi.advanceTimersByTimeAsync(100);

        await handle.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Live pgvector integration coverage (real PG17+pgvector in a disposable
  // Docker container, real DDL, real cross-tenant connection denials) lives in
  // company-memory-databases.integration.test.ts in this directory, gated by
  // PAPERCLIP_RUN_DOCKER_PGVECTOR_TESTS === "true". There is deliberately no
  // second, env-var-gated trivial "live" assertion here: a placeholder that
  // passes on the mere presence of an env var would fake live verification
  // (and PAPERCLIP_MEMORY_INTEGRATION_TEST_URL is not the real opt-in -- the
  // real gate never reads a DSN from the environment, so it cannot be pointed
  // at a live database by mistake).
});
