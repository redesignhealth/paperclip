/**
 * Agent authentication policy (TECH-7095).
 *
 * #31 (TECH-7076) stopped agent children from inheriting the server's environment, but a
 * hosted deployment also needs a PRODUCT rule: model/agent CLIs may only authenticate through
 * an explicit managed AI connection (or explicit secret-ref bindings), never through whatever
 * login, key file or token happens to exist on the server host.
 *
 *  - `managed_only`        hosted default. A managed-capable agent with no valid managed AI
 *                          connection fails BEFORE spawn; every run gets an isolated HOME; host
 *                          GitHub/SSH/GIT credential fallbacks are refused.
 *  - `managed_only_report` same decisions, but nothing is refused: callers log what WOULD fail.
 *                          Lets a first deploy find unbound agents before enforcing.
 *  - `host_fallback`       legacy local-development behaviour. Explicit opt-in only; never the
 *                          default for an authenticated deployment.
 */

export type AgentAuthPolicy = "managed_only" | "managed_only_report" | "host_fallback";

export const AGENT_AUTH_POLICY_ENV = "PAPERCLIP_AGENT_AUTH_POLICY";
export const AGENT_AUTH_POLICY_ALLOW_HOSTED_FALLBACK_ENV = "PAPERCLIP_AGENT_AUTH_POLICY_ALLOW_HOSTED_FALLBACK";

const POLICIES: readonly AgentAuthPolicy[] = ["managed_only", "managed_only_report", "host_fallback"];

export type AgentAuthPolicyErrorCode =
  | "ai_connection_required"
  | "agent_home_isolation_required"
  | "github_connection_required"
  | "agent_env_override_forbidden";

/** Static, value-free messages: an error from this policy must never carry a credential. */
const MESSAGES: Record<AgentAuthPolicyErrorCode, string> = {
  ai_connection_required:
    "This agent needs an explicit managed AI connection before it can run in this deployment.",
  agent_home_isolation_required:
    "This deployment requires every agent run to use an isolated per-run home directory.",
  github_connection_required:
    "This deployment does not allow host GitHub credentials; connect a managed GitHub credential for this agent.",
  agent_env_override_forbidden:
    "This deployment does not allow agent environment settings that redirect the home or credential locations.",
};

export class AgentAuthPolicyError extends Error {
  readonly code: AgentAuthPolicyErrorCode;
  /** Names only (adapter type, env key names). Never values. */
  readonly details: Record<string, string | string[]>;

  constructor(code: AgentAuthPolicyErrorCode, details: Record<string, string | string[]> = {}) {
    super(MESSAGES[code]);
    this.name = "AgentAuthPolicyError";
    this.code = code;
    this.details = details;
  }
}

export function isAgentAuthPolicyError(error: unknown): error is AgentAuthPolicyError {
  return error instanceof AgentAuthPolicyError;
}

function parsePolicy(raw: string | undefined): AgentAuthPolicy | null {
  const value = raw?.trim();
  if (!value) return null;
  if ((POLICIES as readonly string[]).includes(value)) return value as AgentAuthPolicy;
  throw new Error(`${AGENT_AUTH_POLICY_ENV} must be one of ${POLICIES.join(", ")} (received an unrecognized value)`);
}

/**
 * Resolve the policy. An explicit value wins; otherwise any `authenticated` deployment is
 * `managed_only` (the image and the ECS task both run authenticated) and local_trusted keeps
 * `host_fallback`. An unrecognized explicit value throws so a typo cannot silently weaken it.
 */
export function resolveAgentAuthPolicy(input: {
  env?: NodeJS.ProcessEnv;
  deploymentMode?: string | null;
} = {}): AgentAuthPolicy {
  const env = input.env ?? process.env;
  const explicit = parsePolicy(env[AGENT_AUTH_POLICY_ENV]);
  if (explicit) return explicit;
  const mode = input.deploymentMode ?? env.PAPERCLIP_DEPLOYMENT_MODE;
  return mode === "authenticated" ? "managed_only" : "host_fallback";
}

/** Policy in effect for this process. Re-derives from env so an unconfigured caller is still strict. */
export function currentAgentAuthPolicy(env: NodeJS.ProcessEnv = process.env): AgentAuthPolicy {
  return resolveAgentAuthPolicy({ env });
}

/**
 * Publish the resolved policy into `env` when the operator left it unset OR blank (e.g. `${VAR:-}`
 * templating). loadConfig treats a blank value as unset, so a blank value that stayed in the
 * environment would make `currentAgentAuthPolicy()` re-derive `host_fallback` at runtime.
 */
export function publishAgentAuthPolicy(env: NodeJS.ProcessEnv, policy: AgentAuthPolicy): void {
  if (!env[AGENT_AUTH_POLICY_ENV]?.trim()) env[AGENT_AUTH_POLICY_ENV] = policy;
}

/** True when decisions must be enforced (refused), not merely reported. */
export function isManagedOnlyEnforced(policy: AgentAuthPolicy = currentAgentAuthPolicy()): boolean {
  return policy === "managed_only";
}

/** True when the managed-only rules apply at all (enforced or report-only). */
export function isManagedOnlyPolicy(policy: AgentAuthPolicy = currentAgentAuthPolicy()): boolean {
  return policy === "managed_only" || policy === "managed_only_report";
}

/**
 * Boot guard. Refuses a public authenticated deployment that opted back into host credential
 * fallback unless an operator explicitly acknowledged it, and returns a warning for the
 * private-authenticated case.
 */
export function assertAgentAuthPolicyAllowedForDeployment(input: {
  policy: AgentAuthPolicy;
  deploymentMode: string;
  deploymentExposure: string;
  env?: NodeJS.ProcessEnv;
}): { warning: string | null } {
  if (input.policy !== "host_fallback" || input.deploymentMode !== "authenticated") return { warning: null };
  const env = input.env ?? process.env;
  const acknowledged = env[AGENT_AUTH_POLICY_ALLOW_HOSTED_FALLBACK_ENV]?.trim() === "1";
  if (input.deploymentExposure === "public" && !acknowledged) {
    throw new Error(
      `${AGENT_AUTH_POLICY_ENV}=host_fallback on a public authenticated deployment lets agents use host ` +
        `credentials; set ${AGENT_AUTH_POLICY_ALLOW_HOSTED_FALLBACK_ENV}=1 to acknowledge, or use managed_only`,
    );
  }
  return {
    warning:
      `${AGENT_AUTH_POLICY_ENV}=host_fallback on an authenticated deployment: agents may use host ` +
      "credentials and the server user's home. Use managed_only for hosted environments.",
  };
}
