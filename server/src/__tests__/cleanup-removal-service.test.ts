import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemoryDatabases,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companyMemoryDatabases);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });

  it("blocks company deletion when isolation is disabled but an active tenant DB exists", async () => {
    const { companyId } = await seedFixture();

    await db.insert(companyMemoryDatabases).values({
      companyId,
      databaseName: "pcmem_orphan_test_12345",
      databaseRole: "pcmem_r_orphan_test_12345",
      host: "localhost",
      status: "ready",
    });

    await expect(companyService(db).remove(companyId)).rejects.toThrow(
      /Cannot delete company: tenant memory database "pcmem_orphan_test_12345" exists in status "ready" while tenant isolation is disabled/i,
    );

    // Verify company is NOT deleted
    const remaining = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(remaining).toHaveLength(1);
  });

  it("allows company deletion when company memory database is deprovisioned tombstone", async () => {
    const { companyId } = await seedFixture();

    await db.insert(companyMemoryDatabases).values({
      companyId,
      databaseName: "pcmem_tombstone_test_12345",
      databaseRole: "pcmem_r_tombstone_test_12345",
      host: "localhost",
      status: "deprovisioned",
    });

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);

    // Verify both company and memory database mapping are deleted
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(companyMemoryDatabases).where(eq(companyMemoryDatabases.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("enforces ON DELETE RESTRICT on database-level company deletion when memory database exists", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Restrict Probe Co",
      issuePrefix: "RPRB",
    });

    await db.insert(companyMemoryDatabases).values({
      companyId,
      databaseName: "pcmem_restrict_test_12345",
      databaseRole: "pcmem_r_restrict_test_12345",
      host: "localhost",
      status: "ready",
    });

    // Direct database-level deletion of the company must fail closed (RESTRICT)
    let deleteError: any = null;
    try {
      await db.delete(companies).where(eq(companies.id, companyId));
    } catch (err) {
      deleteError = err;
    }
    expect(deleteError).toBeDefined();
    const causeMessage = deleteError?.cause?.message ?? deleteError?.message ?? "";
    expect(causeMessage).toMatch(/foreign key|violates foreign key constraint/i);
    expect(causeMessage).toContain("company_memory_databases");
    expect(["23001", "23503"]).toContain(deleteError?.cause?.code);

    // Verify company and memory database mapping both still exist
    const companyRows = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(companyRows).toHaveLength(1);
    const memDbRows = await db.select().from(companyMemoryDatabases).where(eq(companyMemoryDatabases.companyId, companyId));
    expect(memDbRows).toHaveLength(1);
  });

  it("fails company deletion if memory deprovisioning does not establish a deprovisioned tombstone", async () => {
    const { companyId } = await seedFixture();

    await db.insert(companyMemoryDatabases).values({
      companyId,
      databaseName: "pcmem_failed_tombstone_12345",
      databaseRole: "pcmem_r_failed_tombstone_12345",
      host: "localhost",
      status: "ready",
    });

    const memoryModule = await import("../services/company-memory-databases.js");
    const spy = vi.spyOn(memoryModule, "companyMemoryDatabaseService").mockReturnValue({
      isSupported: () => true,
      deleteCompanyMemory: vi.fn(async (cId: string) => {
        // Simulates deprovisioning failure leaving status as 'failed' instead of 'deprovisioned'
        await db
          .update(companyMemoryDatabases)
          .set({ status: "failed" })
          .where(eq(companyMemoryDatabases.companyId, cId));
      }),
      ensureProvisioned: vi.fn(),
      resolveRuntimeConfig: vi.fn(),
      rotateCredential: vi.fn(),
      archiveCompanyMemory: vi.fn(),
      unarchiveCompanyMemory: vi.fn(),
      reconcileStaleLeases: vi.fn(async () => 0),
      isEligibleCompany: vi.fn(() => true),
    });

    try {
      await expect(companyService(db).remove(companyId)).rejects.toThrow(
        "Cannot delete company: memory database deprovisioning failed to establish tombstone",
      );

      // Verify company was NOT deleted
      const remaining = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(remaining).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
