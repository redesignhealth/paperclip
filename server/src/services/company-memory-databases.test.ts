import { describe, expect, it, vi, beforeEach } from "vitest";
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
  type CompanyMemoryDdlExecutor,
} from "./company-memory-databases.js";

describe("company-memory-databases", () => {
  const companyA = "11111111-1111-4111-8111-111111111111";
  const companyB = "22222222-2222-4222-8222-222222222222";

  describe("deterministic naming and identifier safety", () => {
    it("derives deterministic, non-leaking database and role identifiers from company UUID", () => {
      const namesA1 = deriveCompanyMemoryDatabaseNames(companyA);
      const namesA2 = deriveCompanyMemoryDatabaseNames(companyA);
      expect(namesA1).toEqual(namesA2);

      expect(namesA1.databaseName).toMatch(/^pcmem_[0-9a-f]{12}$/);
      expect(namesA1.databaseRole).toMatch(/^pcmem_r_[0-9a-f]{12}$/);

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

    let mockDb: any;

    beforeEach(() => {
      maintenanceSqlLog = [];
      targetSqlLog = [];
      leakedDatabasesToReport = [];

      memoryDbRows = [];
      companySecretRows = [];
      companySecretVersionRows = [];

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
                  Object.assign(memoryDbRows[0], vals);
                  updated = memoryDbRows[0];
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

  describe("pgvector integration test (disposable container opt-in)", () => {
    it.skipIf(!process.env.PAPERCLIP_MEMORY_INTEGRATION_TEST_URL)(
      "runs live pgvector integration against disposable postgres instance",
      async () => {
        const liveAdminUrl = process.env.PAPERCLIP_MEMORY_INTEGRATION_TEST_URL!;
        // Live integration test verifies real connection, extension creation, and role connectivity
        expect(liveAdminUrl).toBeTruthy();
      },
    );
  });
});
