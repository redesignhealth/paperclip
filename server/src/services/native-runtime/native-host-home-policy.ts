import {
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  type AgentAuthPolicy,
} from "@paperclipai/adapter-utils/agent-auth-policy";

/**
 * TECH-7095: the server's home / provider-config locations. Provider CLIs read
 * host logins from these (`~/.codex/auth.json`, `~/.claude`, `~/.config/gh`).
 * Under the enforced `managed_only` policy a native runner/provider may only see
 * the values the caller placed in the run env (the managed AI connection's
 * per-run home), never the server's own.
 */
export const NATIVE_HOST_HOME_ENV_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
]);

/**
 * Remove host home/config keys from a host-derived env under the enforced
 * policy. Callers apply the run env (managed home) on top afterwards.
 */
export function withoutHostHomeUnderManagedOnly(
  hostDerived: NodeJS.ProcessEnv,
  policy: AgentAuthPolicy = currentAgentAuthPolicy(),
): NodeJS.ProcessEnv {
  // auth-policy: host_fallback (host HOME/CODEX_HOME/XDG_* kept unless enforced)
  if (!isManagedOnlyEnforced(policy)) return hostDerived;
  return Object.fromEntries(
    Object.entries(hostDerived).filter(
      ([key]) => !NATIVE_HOST_HOME_ENV_KEYS.has(key.toUpperCase()),
    ),
  );
}

/**
 * The Codex home a native runner may seed its isolated home from. Under the
 * enforced policy only an explicit CODEX_HOME in the caller-supplied run env
 * counts and `null` (never `undefined`) is returned otherwise, so the runner
 * transport cannot fall back to `$HOME/.codex`.
 */
export function nativeManagedSourceCodexHome(
  runnerEnvironment: NodeJS.ProcessEnv | undefined,
): string | null {
  return runnerEnvironment?.CODEX_HOME?.trim() || null;
}
