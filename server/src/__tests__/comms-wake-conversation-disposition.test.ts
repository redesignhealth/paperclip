import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("comms-board conversation issues are closed, not repaired, after a successful run", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("comms-conversation-disposition-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function fixture(originKind: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Disposition fixture", issuePrefix: `D${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Comms board conversation abcd1234", status: "in_progress", originKind, assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", status: "succeeded", runtimeMode: "legacy", finishedAt: new Date(), contextSnapshot: { issueId }, resultJson: { summary: "Already answered." } });
    const enqueued: unknown[] = [];
    const recovery = recoveryService(db, {
      enqueueWakeup: async (_agentId, opts) => {
        enqueued.push(opts);
        return null;
      },
    });
    const status = () => db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status);
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    return { companyId, agentId, issueId, runId, recovery, enqueued, status, runs };
  }

  it("closes the issue and queues no repair run", async () => {
    const f = await fixture("comms_board_conversation");
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("covered");
    expect(await f.status()).toBe("done");
    expect(f.enqueued).toHaveLength(0);
    expect(await f.runs()).toHaveLength(1);
  });

  it("closes it from the stranded-work sweep too", async () => {
    const f = await fixture("comms_board_conversation");
    await f.recovery.reconcileStrandedAssignedIssues();
    expect(await f.status()).toBe("done");
    expect(f.enqueued).toHaveLength(0);
  });

  it("leaves the issue open while a follow-up wake is deferred", async () => {
    const f = await fixture("comms_board_conversation");
    await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, source: "automation", reason: "comms_board_message_received",
      status: "deferred_issue_execution", payload: { issueId: f.issueId },
    });
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.status()).toBe("in_progress");
    expect(f.enqueued).toHaveLength(0);
  });

  it("leaves the issue open when a message arrived after the run finished", async () => {
    const f = await fixture("comms_board_conversation");
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: "New comms-board message.", createdAt: new Date(Date.now() + 1000) });
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.status()).toBe("in_progress");
  });

  it("does not change disposition repair for other issue kinds", async () => {
    const f = await fixture("manual");
    await f.recovery.reconcileLegacyContinuation(f.runId);
    expect(await f.status()).toBe("in_progress");
    expect(f.enqueued).toHaveLength(1);
  });
});
