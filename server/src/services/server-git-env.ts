import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";

// Non-secret LOCATION variables the worktree provisioning script and CLI read to find the
// instance config and worktree directories (scripts/provision-worktree.sh reads
// PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID and PAPERCLIP_CONFIG; the production image sets
// HOME=/paperclip, so without these it would look in the wrong place and fail).
export const WORKTREE_PROVISION_PASSTHROUGH_ENV = [
  "PAPERCLIP_WORKTREES_DIR",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_CONFIG",
] as const;

/**
 * Server-side git steps (worktree add/checkout, fetch, status scans, remote probes) run hooks
 * inside agent-writable repos. Give them the strict agent base env plus only the non-secret
 * instance/worktree LOCATIONS that repo-configured `worktree init` style hooks legitimately
 * need — never the full server env (DATABASE_URL, BETTER_AUTH_SECRET, provider keys, ...).
 *
 * Lives in its own module so workspace-runtime.ts, the git operation scheduler and
 * heartbeat.ts can share it without an import cycle (TECH-7076 / TECH-7095).
 */
export function buildServerGitBaseEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...buildAgentChildBaseEnv(source) };
  for (const key of WORKTREE_PROVISION_PASSTHROUGH_ENV) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
