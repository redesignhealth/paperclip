import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  adapterSupportsRuntimeMemory,
  resolveHeartbeatRuntimeMemory,
  HERMES_ADAPTER_TYPE,
} from "../services/heartbeat.js";
import * as memoryModule from "../services/company-memory-databases.js";
import { CompanyMemoryNotReadyError } from "../services/company-memory-databases.js";
import * as redactionModule from "../services/run-secret-redaction.js";
import { recordAgentScopedMemoryUse } from "../services/memory-scope-observations.js";

describe("heartbeat runtime memory integration (W5-c / Argus 14, 33)", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const nonPilotCompanyId = "22222222-2222-4222-8222-222222222222";
  const agentId = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const runId = "rrrr1111-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
  const mockDb = {} as any;

  const mockDescriptor: memoryModule.CompanyMemoryDatabaseRuntimeDescriptor = {
    host: "db.example.test",
    port: 5432,
    user: "pcmem_r_12345",
    password: "secret_mem_password_abc",
    dbname: "pcmem_12345",
    sslmode: "require",
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  };

  let registeredSecrets: Array<{ companyId: string; runId: string; value: string }>;

  beforeEach(() => {
    registeredSecrets = [];
    vi.spyOn(redactionModule, "createRunSecretRedactionRegistry").mockReturnValue({
      register: vi.fn(async (cId: string, rId: string, value: string) => {
        registeredSecrets.push({ companyId: cId, runId: rId, value });
      }),
      redactForIssue: vi.fn(),
      redactForRun: vi.fn(),
      findMatchingSecrets: vi.fn(async () => []),
    } as any);
  });

  it("adapterSupportsRuntimeMemory returns true only for hermes_local and false for hermes_gateway or other adapters", () => {
    expect(adapterSupportsRuntimeMemory(HERMES_ADAPTER_TYPE)).toBe(true);
    expect(adapterSupportsRuntimeMemory("hermes_local")).toBe(true);
    expect(adapterSupportsRuntimeMemory("hermes_gateway")).toBe(false);
    expect(adapterSupportsRuntimeMemory("claude_local")).toBe(false);
    expect(adapterSupportsRuntimeMemory("codex_local")).toBe(false);
    expect(adapterSupportsRuntimeMemory(null)).toBe(false);
    expect(adapterSupportsRuntimeMemory(undefined)).toBe(false);
  });

  it("eligible hermes_local builds runtimeMemory with approved model (gpt-5.4-mini), embedding_dims, and registers secret", async () => {
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "allowlist",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(async (cId: string) => (cId === companyId ? mockDescriptor : null)),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn((cId: string) => cId === companyId),
    });

    const runtimeMemory = await resolveHeartbeatRuntimeMemory({
      db: mockDb,
      agent: { id: agentId, adapterType: "hermes_local", companyId },
      runId,
    });

    expect(runtimeMemory).toBeDefined();
    const config = runtimeMemory!.getConfig();

    expect(config.provider).toBe("mem0");
    expect(config.mode).toBe("oss");
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.config.model).toBe("gpt-5.4-mini");

    expect(config.embedder.provider).toBe("openai");
    expect(config.embedder.config.model).toBe("text-embedding-3-small");
    expect((config.embedder.config as any).embedding_dims).toBe(1536);

    expect(config.vectorStore.provider).toBe("pgvector");
    expect(config.vectorStore.config.host).toBe(mockDescriptor.host);
    expect(config.vectorStore.config.port).toBe(mockDescriptor.port);
    expect(config.vectorStore.config.user).toBe(mockDescriptor.user);
    expect(config.vectorStore.config.password).toBe(mockDescriptor.password);
    expect(config.vectorStore.config.dbname).toBe(mockDescriptor.dbname);
    expect(config.vectorStore.config.sslmode).toBe("require");
    expect(config.vectorStore.config.collectionName).toBe("mem0_memories");

    // Verifies secret redaction registration
    expect(registeredSecrets).toEqual([
      { companyId, runId, value: mockDescriptor.password },
    ]);
  });

  it("hermes_gateway omits runtimeMemory and skips resolveRuntimeConfig", async () => {
    const resolveSpy = vi.fn();
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "allowlist",
      isSupported: () => true,
      resolveRuntimeConfig: resolveSpy,
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    const runtimeMemory = await resolveHeartbeatRuntimeMemory({
      db: mockDb,
      agent: { id: agentId, adapterType: "hermes_gateway", companyId },
      runId,
    });

    expect(runtimeMemory).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(registeredSecrets).toHaveLength(0);
  });

  it("non-pilot company omits runtimeMemory when resolveRuntimeConfig returns null", async () => {
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "allowlist",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(async () => null),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => false),
    });

    const runtimeMemory = await resolveHeartbeatRuntimeMemory({
      db: mockDb,
      agent: { id: agentId, adapterType: "hermes_local", companyId: nonPilotCompanyId },
      runId,
    });

    expect(runtimeMemory).toBeUndefined();
    expect(registeredSecrets).toHaveLength(0);
  });

  it("propagates CompanyMemoryNotReadyError fail-closed when memory is not ready", async () => {
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "allowlist",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(async () => {
        throw new CompanyMemoryNotReadyError("Company memory database is not ready (status: unprovisioned)");
      }),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    await expect(
      resolveHeartbeatRuntimeMemory({
        db: mockDb,
        agent: { id: agentId, adapterType: "hermes_local", companyId },
        runId,
      }),
    ).rejects.toThrow(CompanyMemoryNotReadyError);

    expect(registeredSecrets).toHaveLength(0);
  });

  it("in 'all' mode: hermes_local gets runtime memory for previously unlisted company when ready", async () => {
    const unlistedCompanyId = "33333333-3333-4333-8333-333333333333";
    vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      companyScope: "all",
      isSupported: () => true,
      resolveRuntimeConfig: vi.fn(async (cId: string) => (cId === unlistedCompanyId ? mockDescriptor : null)),
      ensureProvisioned: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      deleteCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    const runtimeMemory = await resolveHeartbeatRuntimeMemory({
      db: mockDb,
      agent: { id: agentId, adapterType: "hermes_local", companyId: unlistedCompanyId },
      runId,
    });

    expect(runtimeMemory).toBeDefined();
    expect(runtimeMemory!.getConfig().provider).toBe("mem0");
    expect(registeredSecrets).toEqual([
      { companyId: unlistedCompanyId, runId, value: mockDescriptor.password },
    ]);
  });

  describe("agent-scoped mem0 scope decision (TECH-8191)", () => {
    it("flag off => userId is 'company'", async () => {
      vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
        companyScope: "allowlist",
        isSupported: () => true,
        resolveRuntimeConfig: vi.fn(async () => ({
          ...mockDescriptor,
          scopeMigrationCompletedAt: new Date(),
          scopeMigrationMode: "copy",
        })),
        ensureProvisioned: vi.fn(),
        rotateCredential: vi.fn(),
        archiveCompanyMemory: vi.fn(),
        unarchiveCompanyMemory: vi.fn(),
        deleteCompanyMemory: vi.fn(),
        reconcileStaleLeases: vi.fn(async () => 0),
        isEligibleCompany: vi.fn(() => true),
      });

      const runtimeMemory = await resolveHeartbeatRuntimeMemory({
        db: mockDb,
        agent: { id: agentId, adapterType: "hermes_local", companyId },
        runId,
        flags: {
          hermesMemoryConfig: false,
          hermesPromptSplit: false,
          agentScopedMem0: false,
          capabilityMemoryGuidance: false,
        },
      });

      expect(runtimeMemory).toBeDefined();
      expect(runtimeMemory!.getConfig().userId).toBe("company");
    });

    it("flag on + no marker => userId is 'company' and logs ONE warn line with companyId only", async () => {
      const { logger } = await import("../middleware/logger.js");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
        companyScope: "allowlist",
        isSupported: () => true,
        resolveRuntimeConfig: vi.fn(async () => ({
          ...mockDescriptor,
          scopeMigrationCompletedAt: null,
          scopeMigrationMode: null,
        })),
        ensureProvisioned: vi.fn(),
        rotateCredential: vi.fn(),
        archiveCompanyMemory: vi.fn(),
        unarchiveCompanyMemory: vi.fn(),
        deleteCompanyMemory: vi.fn(),
        reconcileStaleLeases: vi.fn(async () => 0),
        isEligibleCompany: vi.fn(() => true),
      });

      const runtimeMemory = await resolveHeartbeatRuntimeMemory({
        db: mockDb,
        agent: { id: agentId, adapterType: "hermes_local", companyId },
        runId,
        flags: {
          hermesMemoryConfig: false,
          hermesPromptSplit: false,
          agentScopedMem0: true,
          capabilityMemoryGuidance: false,
        },
      });

      expect(runtimeMemory).toBeDefined();
      expect(runtimeMemory!.getConfig().userId).toBe("company");

      expect(warnSpy).toHaveBeenCalledWith(
        { companyId },
        expect.stringContaining("has not completed agent scope migration"),
      );

      // Verify no secrets or agent IDs leaked in the warning object
      const warnCalls = warnSpy.mock.calls;
      const relevantCall = warnCalls.find(
        ([obj]) => typeof obj === "object" && obj !== null && "companyId" in obj && (obj as any).companyId === companyId,
      );
      expect(relevantCall).toBeDefined();
      expect(Object.keys(relevantCall![0] as object)).toEqual(["companyId"]);

      warnSpy.mockRestore();
    });

    it("flag on + marker => userId is agent.id", async () => {
      vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
        companyScope: "allowlist",
        isSupported: () => true,
        resolveRuntimeConfig: vi.fn(async () => ({
          ...mockDescriptor,
          scopeMigrationCompletedAt: new Date("2026-11-05T00:00:00Z"),
          scopeMigrationMode: "copy",
        })),
        ensureProvisioned: vi.fn(),
        rotateCredential: vi.fn(),
        archiveCompanyMemory: vi.fn(),
        unarchiveCompanyMemory: vi.fn(),
        deleteCompanyMemory: vi.fn(),
        reconcileStaleLeases: vi.fn(async () => 0),
        isEligibleCompany: vi.fn(() => true),
      });

      const runtimeMemory = await resolveHeartbeatRuntimeMemory({
        db: mockDb,
        agent: { id: agentId, adapterType: "hermes_local", companyId },
        runId,
        flags: {
          hermesMemoryConfig: false,
          hermesPromptSplit: false,
          agentScopedMem0: true,
          capabilityMemoryGuidance: false,
        },
      });

      expect(runtimeMemory).toBeDefined();
      expect(runtimeMemory!.getConfig().userId).toBe(agentId);
      expect(runtimeMemory!.getConfig().agentId).toBe(agentId);
    });

    it("the recorder updates at most once per hour (mock db)", async () => {
      let observedAt: Date | null = null;
      const throttledMockDb = {
        update: vi.fn(() => ({
          set: vi.fn((values: { scopeMigrationAgentScopeObservedAt?: Date }) => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                const now = values.scopeMigrationAgentScopeObservedAt ?? new Date();
                if (
                  observedAt === null ||
                  observedAt.getTime() <= now.getTime() - 60 * 60 * 1000
                ) {
                  observedAt = now;
                  return [{ id: "mem-db-1" }];
                }
                return [];
              }),
            })),
          })),
        })),
      };

      const baseTime = new Date("2026-11-05T12:00:00Z");

      // 1. Initial observation with null observedAt -> updates
      const updated1 = await recordAgentScopedMemoryUse(throttledMockDb as any, companyId, baseTime);
      expect(updated1).toBe(true);
      expect(observedAt).toEqual(baseTime);

      // 2. Second observation 30 minutes later -> throttled (no update)
      const timePlus30Min = new Date(baseTime.getTime() + 30 * 60 * 1000);
      const updated2 = await recordAgentScopedMemoryUse(throttledMockDb as any, companyId, timePlus30Min);
      expect(updated2).toBe(false);
      expect(observedAt).toEqual(baseTime);

      // 3. Observation 59 minutes later -> throttled (no update)
      const timePlus59Min = new Date(baseTime.getTime() + 59 * 60 * 1000);
      const updated3 = await recordAgentScopedMemoryUse(throttledMockDb as any, companyId, timePlus59Min);
      expect(updated3).toBe(false);

      // 4. Observation 61 minutes later -> updates
      const timePlus61Min = new Date(baseTime.getTime() + 61 * 60 * 1000);
      const updated4 = await recordAgentScopedMemoryUse(throttledMockDb as any, companyId, timePlus61Min);
      expect(updated4).toBe(true);
      expect(observedAt).toEqual(timePlus61Min);
    });

    it("the recorder never throws into the run", async () => {
      const { logger } = await import("../middleware/logger.js");
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

      const failingDb = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => {
                throw new Error("simulated database outage");
              }),
            })),
          })),
        })),
      };

      let result: boolean | undefined;
      await expect(
        (async () => {
          result = await recordAgentScopedMemoryUse(failingDb as any, companyId);
        })(),
      ).resolves.not.toThrow();

      expect(result).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(
        { companyId },
        expect.stringContaining("failed to record"),
      );
      const debugCalls = debugSpy.mock.calls;
      const relevantCall = debugCalls.find(
        ([obj]) => typeof obj === "object" && obj !== null && "companyId" in obj && (obj as any).companyId === companyId,
      );
      expect(relevantCall).toBeDefined();
      expect(Object.keys(relevantCall![0] as object)).toEqual(["companyId"]);

      debugSpy.mockRestore();
    });

    it("an agent-scoped run still resolves when the recorder rejects", async () => {
      const observationsModule = await import("../services/memory-scope-observations.js");
      const recordSpy = vi
        .spyOn(observationsModule, "recordAgentScopedMemoryUse")
        .mockRejectedValue(new Error("unhandled recorder rejection"));

      vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
        companyScope: "allowlist",
        isSupported: () => true,
        resolveRuntimeConfig: vi.fn(async () => ({
          ...mockDescriptor,
          scopeMigrationCompletedAt: new Date("2026-11-05T00:00:00Z"),
          scopeMigrationMode: "copy",
        })),
        ensureProvisioned: vi.fn(),
        rotateCredential: vi.fn(),
        archiveCompanyMemory: vi.fn(),
        unarchiveCompanyMemory: vi.fn(),
        deleteCompanyMemory: vi.fn(),
        reconcileStaleLeases: vi.fn(async () => 0),
        isEligibleCompany: vi.fn(() => true),
      });

      const runtimeMemory = await resolveHeartbeatRuntimeMemory({
        db: mockDb,
        agent: { id: agentId, adapterType: "hermes_local", companyId },
        runId,
        flags: {
          hermesMemoryConfig: false,
          hermesPromptSplit: false,
          agentScopedMem0: true,
          capabilityMemoryGuidance: false,
        },
      });

      expect(runtimeMemory).toBeDefined();
      expect(runtimeMemory!.getConfig().userId).toBe(agentId);
      expect(recordSpy).toHaveBeenCalledWith(mockDb, companyId);

      recordSpy.mockRestore();
    });
  });
});
