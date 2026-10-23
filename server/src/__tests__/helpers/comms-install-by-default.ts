import { DEFAULT_MCP_SPEC } from "../../services/default-mcp-spec.js";

/**
 * comms-board is `installByDefault`, so a created agent that reaches ready is installed automatically. Suites that
 * exercise the install gate's OFF contract use comms-board as their sample dedicated entry and need the pre-default
 * behaviour; they switch the spec flag off for their lifetime (the default install itself is covered by
 * `default-mcp-install-reconcile.test.ts`). Returns the restore function.
 */
export function withoutCommsInstallByDefault(): () => void {
  const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "comms-board")!;
  const previous = entry.installByDefault;
  entry.installByDefault = false;
  return () => {
    entry.installByDefault = previous;
  };
}
