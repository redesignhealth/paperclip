import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { agentObservabilityService } from "./agent-observability.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import type { Db } from "@paperclipai/db";
import { eq, inArray, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  acquireCompanyMemoryAdmissionLock,
  findActiveUpgrade,
  lockCompanyForMemoryAdmission,
} from "./company-memory-upgrade/admission.js";
import { companyMemoryDatabaseService } from "./company-memory-databases.js";
import { createAgentLifecycle, processAgentLifecycle } from "./agent-lifecycle.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import {
  companies,
  agents,
  companyLogos,
  assets,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  runIdentityContexts,
  heartbeatRunEvents,
  costEvents,
  decisionInvocations,
  financeEvents,
  budgetPolicies,
  budgetIncidents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  cases,
  documents,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
  companyMemoryDatabases,
  companyMemoryUpgrades,
} from "@paperclipai/db";

/**
 * The company row is referenced by company_memory_databases with ON DELETE
 * RESTRICT so a company can never be removed while its isolated memory
 * database still exists. Deprovision it first (or refuse) before any other
 * destructive step, so a failed deprovision leaves the company fully intact.
 */
async function deprovisionCompanyMemoryBeforeDelete(db: Db, id: string) {
  const memoryService = companyMemoryDatabaseService(db);
  if (memoryService.isSupported()) {
    await memoryService.deleteCompanyMemory(id);
    const tombstone = await db
      .select({ status: companyMemoryDatabases.status })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, id))
      .then((rows) => rows[0] ?? null);

    if (tombstone && tombstone.status !== "deprovisioned") {
      throw new Error("Cannot delete company: memory database deprovisioning failed to establish tombstone");
    }
    return;
  }
  const existingMemoryDb = await db
    .select({ status: companyMemoryDatabases.status, databaseName: companyMemoryDatabases.databaseName })
    .from(companyMemoryDatabases)
    .where(eq(companyMemoryDatabases.companyId, id))
    .then((rows) => rows[0] ?? null);

  if (existingMemoryDb && existingMemoryDb.status !== "deprovisioned") {
    throw new Error(
      `Cannot delete company: tenant memory database "${existingMemoryDb.databaseName}" exists in status "${existingMemoryDb.status}" while tenant isolation is disabled. Re-enable PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED to deprovision before removing.`,
    );
  }
}

export type CompanyDeletionAdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: "company_not_found" };

export async function admitCompanyDeletion(
  db: Db,
  id: string,
): Promise<CompanyDeletionAdmissionResult> {
  return await db.transaction(async (tx) => {
    await acquireCompanyMemoryAdmissionLock(tx, id);
    const company = await lockCompanyForMemoryAdmission(tx, id);
    if (!company) {
      return { admitted: false, reason: "company_not_found" };
    }

    const activeUpgrade = await findActiveUpgrade(tx, id);
    if (activeUpgrade) {
      throw conflict(
        `Cannot delete company: memory upgrade "${activeUpgrade.id}" is active in state "${activeUpgrade.state}". Non-terminal upgrades must complete, roll back, or abort before company deletion.`,
        {
          code: "company_memory_upgrade_active",
          upgradeId: activeUpgrade.id,
          state: activeUpgrade.state,
        },
      );
    }

    const priorDeletionStartedAt = company.deletionStartedAt;
    const resumed = priorDeletionStartedAt !== null && priorDeletionStartedAt !== undefined;
    if (resumed) {
      const ageMs = Date.now() - new Date(priorDeletionStartedAt).getTime();
      logger.warn(
        { companyId: id, ageMs, deletionStartedAt: priorDeletionStartedAt },
        `Resuming company deletion with existing deletion intent (age ${ageMs}ms)`,
      );
    }

    await tx
      .update(companies)
      .set({
        deletionStartedAt: sql`coalesce(${companies.deletionStartedAt}, now())`,
      })
      .where(eq(companies.id, id));

    return { admitted: true };
  });
}

export async function deleteCompany(db: Db, id: string) {
  const admission = await admitCompanyDeletion(db, id);
  if (!admission.admitted) {
    return null;
  }

  try {
    await deprovisionCompanyMemoryBeforeDelete(db, id);
    const lifecycle = createAgentLifecycle(db);
    const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, id));
    for (const agent of companyAgents) {
      await lifecycle.terminateAgent(agent.id);
      await processAgentLifecycle(db, agent.id);
    }
    return await withAccountHomeSecretMutationLock(undefined, id, () => db.transaction(async (tx) => {
      // Advisory lock must be acquired as first statement of participating transaction.
      await acquireCompanyMemoryAdmissionLock(tx, id);

      // Exclude accounting writers before taking child locks. KEY SHARE must
      // remain compatible: native writers can already hold a child row while
      // saving a company-scoped result. FOR UPDATE would deadlock that save.
      const [existing] = await tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, id)).for("no key update");
      if (!existing) return null;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillSourceSync);
      await tx.delete(companyMemoryDatabases).where(eq(companyMemoryDatabases.companyId, id));

      // Check for in-progress memory upgrades under row lock (defence-in-depth).
      const activeUpgrade = await findActiveUpgrade(tx, id);
      if (activeUpgrade) {
        logger.error(
          { companyId: id, upgradeId: activeUpgrade.id, state: activeUpgrade.state },
          "Invariant violation: active memory upgrade found during final company deletion transaction",
        );
        throw conflict(
          `Cannot delete company: memory upgrade "${activeUpgrade.id}" is active in state "${activeUpgrade.state}". Non-terminal upgrades must complete, roll back, or abort before company deletion.`,
          {
            code: "company_memory_upgrade_active",
            upgradeId: activeUpgrade.id,
            state: activeUpgrade.state,
          },
        );
      }

      // Terminal upgrade rows are audit/ledger records and are only deleted as part
      // of final company deletion once verified that no active upgrade is running.
      await tx.delete(companyMemoryUpgrades).where(eq(companyMemoryUpgrades.companyId, id));
      await agentObservabilityService(tx as unknown as Db).removeForCompanyDeletion(id);
      // Finance can reference costs and both can reference runs. Incidents
      // reference policies and approvals; delete these dependents first.
      await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
      await tx.delete(decisionInvocations).where(eq(decisionInvocations.companyId, id));
      await tx.delete(costEvents).where(eq(costEvents.companyId, id));
      await tx.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
      await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
      // Cases retain task and agent references. Their dependent handoffs and
      // access sources cascade here before those task/agent records are removed.
      await tx.delete(cases).where(eq(cases.companyId, id));
      // Delete from child tables in dependency order
      const companyRunIds = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, id));

      await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
      if (companyRunIds.length > 0) {
        await tx
          .delete(heartbeatRunEvents)
          .where(inArray(heartbeatRunEvents.runId, companyRunIds.map((run) => run.id)));
      }
      await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
      await tx.delete(activityLog).where(eq(activityLog.companyId, id));
      await tx.delete(runIdentityContexts).where(eq(runIdentityContexts.companyId, id));
      await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
      await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
      await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
      await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
      await tx.delete(issueComments).where(eq(issueComments.companyId, id));
      await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
      await tx.delete(approvals).where(eq(approvals.companyId, id));
      await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
      await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
      await tx.delete(invites).where(eq(invites.companyId, id));
      await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
      await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
      await tx.delete(companySkills).where(eq(companySkills.companyId, id));
      await tx.delete(routineRuns).where(eq(routineRuns.companyId, id));
      await tx.delete(routineTriggers).where(eq(routineTriggers.companyId, id));
      await tx.delete(routineRevisions).where(eq(routineRevisions.companyId, id));
      await tx.delete(routines).where(eq(routines.companyId, id));
      await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
      await tx.delete(documents).where(eq(documents.companyId, id));
      await tx.delete(issues).where(eq(issues.companyId, id));
      await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
      await tx.delete(assets).where(eq(assets.companyId, id));
      await tx.delete(goals).where(eq(goals.companyId, id));
      await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, id));
      await tx.delete(projects).where(eq(projects.companyId, id));
      await agentLifecycleCompanyDeletion.deleteCompanyData(tx, id);
      const rows = await tx
        .delete(companies)
        .where(eq(companies.id, id))
        .returning();
      return rows[0] ?? null;
    }));
  } catch (err: any) {
    const errorCode = err?.code ?? err?.name ?? "UNKNOWN_ERROR";
    logger.error(
      { companyId: id, errorCode },
      "Company deletion failed; deletion intent retained (fail-closed)",
    );
    throw err;
  }
}
