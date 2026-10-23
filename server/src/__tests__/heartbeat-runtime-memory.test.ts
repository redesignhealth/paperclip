import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  adapterSupportsRuntimeMemory,
  resolveHeartbeatRuntimeMemory,
  HERMES_ADAPTER_TYPE,
} from "../services/heartbeat.js";
import * as memoryModule from "../services/company-memory-databases.js";
import { CompanyMemoryNotReadyError } from "../services/company-memory-databases.js";
import * as redactionModule from "../services/run-secret-redaction.js";

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
});
