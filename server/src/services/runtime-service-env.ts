import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";

// Explicit, reviewed, NON-SECRET variables runtime services may inherit beyond the strict
// agent base env. Add here only values that are not credentials.
const RUNTIME_SERVICE_PASSTHROUGH_ENV = ["HOST"] as const;

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // TECH-7076: runtime services run commands configured per workspace/agent, so start
  // from the strict allowlisted base instead of the server env minus a denylist (which
  // let BETTER_AUTH_SECRET, AWS credentials, etc. through). Explicit service env is
  // merged back by callers after sanitizing.
  const env: NodeJS.ProcessEnv = buildAgentChildBaseEnv(baseEnv);
  // Non-secret network binding setting that dev-server style services rely on.
  for (const key of RUNTIME_SERVICE_PASSTHROUGH_ENV) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  // These origin settings belong to the parent instance. Letting them leak into a
  // managed worktree runtime can send auth cookies and OAuth callbacks to the wrong
  // Paperclip instance. Runtime/service overrides are merged back after sanitizing.
  delete env.BETTER_AUTH_URL;
  delete env.BETTER_AUTH_BASE_URL;
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}
