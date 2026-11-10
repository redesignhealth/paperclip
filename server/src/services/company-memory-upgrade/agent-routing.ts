import { INVOKABLE_AGENT_STATUSES } from "@paperclipai/shared";
import { adapterSupportsRuntimeMemory } from "../company-memory-constants.js";
import { isValidUuid, type UnroutableReason } from "./census.js";

export interface CpAgentRow {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  pausedAt: Date | string | null;
}

export function classifyAgentRouting(
  rawAgentId: string | null | undefined,
  cpAgentMap: Map<string, CpAgentRow>,
): { isRoutable: boolean; matchedAgentId: string | null; unroutableReason?: UnroutableReason } {
  if (!rawAgentId || rawAgentId.trim() === "" || rawAgentId.trim() === "(none)") {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "missing_agent_id" };
  }

  const trimmed = rawAgentId.trim().toLowerCase();
  if (!isValidUuid(trimmed)) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "malformed_agent_id" };
  }

  const cpAgent = cpAgentMap.get(trimmed);
  if (!cpAgent) {
    return { isRoutable: false, matchedAgentId: null, unroutableReason: "unknown_agent" };
  }

  const matchedAgentId = cpAgent.id;

  if (!adapterSupportsRuntimeMemory(cpAgent.adapterType)) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "non_memory_adapter" };
  }

  if (cpAgent.status === "terminated") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "terminated" };
  }

  if (cpAgent.status === "pending_approval") {
    return { isRoutable: false, matchedAgentId, unroutableReason: "pending_approval" };
  }

  const isInvokable = INVOKABLE_AGENT_STATUSES.has(cpAgent.status);
  const isPausedStatus = cpAgent.status === "paused";

  if (!isInvokable && !isPausedStatus) {
    return { isRoutable: false, matchedAgentId, unroutableReason: "unknown_status" };
  }

  return { isRoutable: true, matchedAgentId };
}
