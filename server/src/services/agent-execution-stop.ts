import os from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, asc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { HEARTBEAT_RUN_TERMINAL_STATUSES } from "./heartbeat/recovery.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

/** Written by the legacy executor when it settles a cancelled run without
 * ever entering the adapter, so no process was spawned to prove against. */
export const LEGACY_ADAPTER_NOT_ENTERED_RECEIPT = "legacyAdapterNotEnteredAt";

// No local process outlives a host reboot. The margin absorbs clock skew
// between the wall clock and the uptime reading.
const HOST_BOOT_MARGIN_MS = 60_000;

function beforeHostBoot(at: Date | null) {
  return Boolean(at && at.getTime() < Date.now() - os.uptime() * 1000 - HOST_BOOT_MARGIN_MS);
}

/** Upper bound on run rows any one query loads while proving a stop. */
export const STOP_PROOF_PAGE_SIZE = 50;

/** Cancellation changes admission. Process and lease evidence controls cleanup.
 * An agent can own hundreds of runs, so this never loads them all: blockers
 * are found with existence queries, and only runs that can still carry process
 * or cancellation evidence are read, in bounded pages without jsonb columns. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const now = new Date();
  const agentRuns = inArray(heartbeatRuns.agentId, agentIds);
  const [blockingRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(agentRuns, or(notInArray(heartbeatRuns.status, [...HEARTBEAT_RUN_TERMINAL_STATUSES]),
      gt(heartbeatRuns.controllerLeaseExpiresAt, now)))).limit(1);
  if (blockingRun) return false;
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(agentRuns);
  const [blockingLease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ), or(
    and(isNull(environmentLeases.releasedAt),
      sql`not (${environmentLeases.status} = 'retained' and coalesce(${environmentLeases.cleanupStatus} = 'success', false))`),
    eq(environmentLeases.status, "pending_cleanup"),
    eq(environmentLeases.cleanupStatus, "failed"),
  ))).limit(1);
  if (blockingLease) return false;
  const abandoned = await db.select().from(nativeRunFinalizations)
    .where(and(inArray(nativeRunFinalizations.runId, runIds), isNotNull(nativeRunFinalizations.leaseOwner)));
  if (abandoned.length) {
    const statuses = new Map((await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, abandoned.map(row => row.runId)))).map(row => [row.id, row.status]));
    if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
        statuses.get(row.runId) !== "cancelled")) return false;
  }
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  // Every other terminal run, without a recorded process and not cancelled,
  // has no evidence left to check.
  const suspect = and(agentRuns, or(eq(heartbeatRuns.status, "cancelled"),
    isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId)));
  for (let after: string | undefined; ;) {
    const page = await db.select({
      id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt, processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
      runtimeMode: heartbeatRuns.runtimeMode,
    }).from(heartbeatRuns).where(after ? and(suspect, gt(heartbeatRuns.id, after)) : suspect)
      .orderBy(asc(heartbeatRuns.id)).limit(STOP_PROOF_PAGE_SIZE);
    if (!page.length) break;
    after = page[page.length - 1]!.id;
    const pageIds = page.map(run => run.id);
    const leases = await db.select().from(environmentLeases).where(inArray(environmentLeases.heartbeatRunId, pageIds));
    const needsRecord = (run: typeof page[number]) => run.status === "cancelled" && run.startedAt &&
      !run.processPid && !run.processGroupId && (run.runtimeMode === "native" || run.runtimeMode === "legacy");
    const needing = page.filter(needsRecord).map(run => run.id);
    const full = new Map<string, typeof heartbeatRuns.$inferSelect>();
    const coordinators = new Map<string, typeof nativeRunFinalizations.$inferSelect>();
    if (needing.length) {
      for (const row of await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, needing))) full.set(row.id, row);
      for (const row of await db.select().from(nativeRunFinalizations).where(inArray(nativeRunFinalizations.runId, needing))) {
        coordinators.set(row.runId, row);
      }
    }
    for (const run of page) {
      const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
      if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
        if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return false;
        continue;
      }
      // A process identity recorded before this host booted cannot be live;
      // whatever holds that PID or group now is unrelated.
      const startedBeforeBoot = beforeHostBoot(run.processStartedAt ?? run.finishedAt);
      if (!startedBeforeBoot) {
        let processAlive = Boolean(run.processPid && !absent(run.processPid));
        let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
        if (processAlive && run.processStartedAt) {
          const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
          if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
            processAlive = false;
            if (run.processGroupId === run.processPid) groupAlive = false;
          }
        }
        // A dead leader's group stays live: the run's own descendants can be
        // younger than the run, so member start times cannot prove reuse.
        if (processAlive || groupAlive) return false;
      }
      const record = full.get(run.id);
      if (!record) continue;
      if (run.runtimeMode === "native" &&
          !await hasNativeLocalProcessStop(db, record.companyId, record.id) &&
          !await isCancelledNativeStartup(db, record, coordinators.get(run.id))) return false;
      if (run.runtimeMode === "legacy" &&
          (record.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
          !(record.executionStage === "settled" && typeof record.resultJson?.[LEGACY_ADAPTER_NOT_ENTERED_RECEIPT] === "string") &&
          !(record.executionStage === "settled" && !await runUsedConversationAdapter(db, record)) &&
          // Conversation adapters run local CLI processes, which a reboot ends.
          !(startedBeforeBoot && await runUsedConversationAdapter(db, record)) &&
          !await isCancelledNativeStartup(db, record, coordinators.get(run.id))) return false;
    }
    if (page.length < STOP_PROOF_PAGE_SIZE) break;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
