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

/**
 * The agent installs to save after the agent picker changes. An agent only gets a connection's tools with an
 * explicit install row (a permission binding does not turn a default-MCP agent on), so the picker is the install:
 * picked agents are installed and cleared agents are uninstalled. `null` means nothing needs saving.
 */
export function installsAfterPick(
  installedAgentIds: ReadonlySet<string>,
  pickedAgentIds: ReadonlySet<string>,
): string[] | null {
  const unchanged = pickedAgentIds.size === installedAgentIds.size && [...pickedAgentIds].every((id) => installedAgentIds.has(id));
  return unchanged ? null : [...pickedAgentIds];
}
