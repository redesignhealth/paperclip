import { logger } from "../middleware/logger.js";
import type { Db } from "@paperclipai/db";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { deleteAgentDependencies } from "./agent-deletion.js";
import { prepareAgentConfiguration, completeAgentConfiguration } from "./agent-configuration.js";
import { prepareAgentHire, initializeAgentHire, prepareAgentHireApproval, completeAgentHireApproval } from "./agent-hiring.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { fenceActiveCompanyAgentStopsInTransaction as fenceActiveCompanyStops } from "../modules/agent-lifecycle/index.js";
import { applyAgentPolicyHoldsInTransaction } from "../modules/agent-lifecycle/index.js";
import { trackIdleWork } from "./task-admission.js";
import { isDefaultMcpSpecEnabled } from "./default-mcp-spec.js";
import { scheduleDefaultMcpSetup } from "./default-mcp-setup.js";
import { createDefaultKbIngestRoutineForNewAgent } from "./default-kb-ingest-routine.js";

export { scheduleAgentLifecycle, processAgentLifecycle } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function createAgentLifecycleEffects(_hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    notifyWork: tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle),
    reportFailure(context, error) {
      const code = lifecycle.lifecycleFailureCode(error);
      logger.warn({ ...context, failureCode: code ?? "unclassified" }, "Agent lifecycle operation failed");
    },
    transaction: withAccountingTransaction,
    deleteDependencies: deleteAgentDependencies,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId, isActive) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive, windowKind: "calendar_month_utc",
      }, userId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    prepareConfiguration: prepareAgentConfiguration,
    completeConfiguration: completeAgentConfiguration,
    prepareHire: prepareAgentHire,
    initializeHire: initializeAgentHire,
    prepareHireApproval: prepareAgentHireApproval,
    completeHireApproval: completeAgentHireApproval,
    afterHireCommitted: async (db, agent) => {
      afterHireCommitted(db, agent);
      await createDefaultKbIngestRoutineForNewAgent(db, { companyId: agent.companyId, agentId: agent.id }, {});
    },
  };
}

/**
 * Default-MCP setup and the default kb-ingest routine run strictly after the hire transaction commits, and are
 * never awaited by the hire itself (setup makes external calls; the durable sweep is the backstop).
 */
function afterHireCommitted(db: Db, agent: { id: string; companyId: string; status: string }) {
  if (isDefaultMcpSpecEnabled() && agent.status !== "pending_approval") {
    scheduleDefaultMcpSetup(db, { companyId: agent.companyId, agentId: agent.id });
  }
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}) {
  const base = lifecycle.createAgentLifecycle(db, createAgentLifecycleEffects(hooks));
  return {
    ...base,
    async requestHire(...args: Parameters<typeof base.requestHire>) {
      const agent = await base.requestHire(...args);
      afterHireCommitted(db, agent);
      return agent;
    },
    async approveHire(...args: Parameters<typeof base.approveHire>) {
      const result = await base.approveHire(...args);
      const [target, approverUserId] = args;
      if (result?.applied && result.hireApprovedAgentId && result.agent) {
        afterHireCommitted(db, result.agent);
        // The activation path (a pending agent row approved in place) also gets the default kb-ingest routine;
        // an agent created from the approval payload gets it from the creating route.
        const payload = result.approval?.payload as Record<string, unknown> | undefined;
        if (typeof target === "string" || typeof payload?.agentId === "string") {
          await createDefaultKbIngestRoutineForNewAgent(
            db,
            { companyId: result.agent.companyId, agentId: result.agent.id },
            { userId: approverUserId && approverUserId !== "board" ? approverUserId : null },
          );
        }
      }
      return result;
    },
  };
}

function trackedDriver(driver: lifecycle.LifecycleDriver): lifecycle.LifecycleDriver {
  return { ...driver, runHost: agent => trackIdleWork(driver.runHost(agent)),
    runPlugin: (agent, pluginId) => trackIdleWork(driver.runPlugin(agent, pluginId)) };
}

export function configureAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun = () => true) {
  return lifecycle.configureAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

export function startAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun: () => boolean) {
  return lifecycle.startAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

/** Budget evaluation owns the transaction and supplies the aggregate agent decision. */
export function applyAgentBudgetHoldInTransaction(tx: Db, companyId: string, agentId: string, blocked: boolean) {
  return applyAgentPolicyHoldsInTransaction(tx, createAgentLifecycleEffects(), companyId, agentId, { budget: blocked });
}

export function fenceActiveCompanyAgentStopsInTransaction(tx: Db, companyId: string, status: "paused" | "archived") {
  return fenceActiveCompanyStops(tx, createAgentLifecycleEffects(), companyId, status);
}
