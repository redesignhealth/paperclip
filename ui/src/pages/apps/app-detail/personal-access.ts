import type { InstallState } from "@/lib/tool-installs";
import type { AccessDraft } from "./types";

/**
 * A personal sign-in connection (RH Google MCP, RH MCP) is installed per agent by its owner and the server refuses
 * "all agents" for it. A stale company-wide permission binding still makes the saved profile read as "all", and every
 * unrelated save (an action permission, a quarantine review) would then send all_agents and fail. For these
 * connections the draft is therefore always the specific agents that are actually installed.
 */
export function accessForConnection(draft: AccessDraft, install: InstallState, isPersonalSignIn: boolean): AccessDraft {
  if (!isPersonalSignIn || draft.mode !== "all") return draft;
  return { mode: "specific", agentIds: new Set(install.agentIds) };
}
