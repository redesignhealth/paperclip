import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});

import { reconcileAbandonedExecutionControl } from "./execution-control-reconciliation.js";
import { waitForPendingRunFailureReports } from "./run-failure-report.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileAbandonedExecutionControl reports a genuine failed transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    // The reconciler fires its Sentry report without awaiting it. Drain before
    // the embedded database closes, so no report's agents lookup survives the
    // pool and leaks into another test file.
    await waitForPendingRunFailureReports();
    await tempDb?.cleanup();
  });

  async function seedAbandonedRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const pastDeadline = new Date(Date.now() - 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Control Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stuck worker",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      executionControlDeadlineAt: pastDeadline,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Abandoned execution control fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      checkoutRunId: runId,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("reports exactly one Sentry event for a genuine finalization-deadline failure", async () => {
    const { runId } = await seedAbandonedRunFixture();
    // A report from an earlier sweep can still be in flight. Drain it first so
    // the baseline below counts only this test's report.
    await waitForPendingRunFailureReports();
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    const result = await reconcileAbandonedExecutionControl(db);
    // The reconciler fires the report without awaiting it, so wait for the
    // report module's own in-flight set instead of a database round trip.
    await waitForPendingRunFailureReports();

    expect(result.surfaced).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("execution_finalization_deadline_exceeded");

    const newCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBefore);
    expect(newCaptures).toHaveLength(1);
    expect(newCaptures[0]?.[0]).toMatchObject({
      runId,
      runStatus: "failed",
      errorCode: "execution_finalization_deadline_exceeded",
    });
  });

  it("reports zero events for a repeated sweep over the same already-failed run", async () => {
    const { runId } = await seedAbandonedRunFixture();
    // The first sweep's report is fire-and-forget. Drain it before the baseline,
    // otherwise it lands inside the second sweep's window and is miscounted as a
    // duplicate.
    await waitForPendingRunFailureReports();
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    await reconcileAbandonedExecutionControl(db);
    await waitForPendingRunFailureReports();

    // Assert the first sweep really reported this run, so a bounded drain
    // timeout cannot make the zero-additional-event check below pass for the
    // wrong reason.
    const firstSweepCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBefore);
    expect(firstSweepCaptures).toHaveLength(1);
    expect(firstSweepCaptures[0]?.[0]).toMatchObject({ runId, runStatus: "failed" });

    // The first sweep already cleared executionControlDeadlineAt and moved the
    // run to "failed". Restore the deadline to simulate a second sweep still
    // observing the same run as a candidate.
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));

    const secondSweepBaseline = mockCaptureRunFailure.mock.calls.length;
    const result = await reconcileAbandonedExecutionControl(db);
    // Even though the run is already terminal, drain whatever the second sweep
    // started so nothing escapes into the next test's window.
    await waitForPendingRunFailureReports();

    // The run is already terminal ("failed"), so the early terminal-status
    // guard applies and no second "failed" write happens.
    expect(result.surfaced).toBe(1);
    expect(mockCaptureRunFailure.mock.calls.slice(secondSweepBaseline)).toHaveLength(0);
  });
});
