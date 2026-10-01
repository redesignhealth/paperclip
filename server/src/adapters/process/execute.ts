import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";
import {
  AgentAuthPolicyError,
  currentAgentAuthPolicy,
  isManagedOnlyEnforced,
  isManagedOnlyPolicy,
} from "@paperclipai/adapter-utils/agent-auth-policy";
import { isRegisteredRunHome } from "@paperclipai/adapter-utils/run-home";
import { findForbiddenProcessAdapterCredentialKeys } from "../../services/agent-auth-policy-guards.js";
import { logger } from "../../middleware/logger.js";

/**
 * TECH-7095. A `process` agent cannot hold a managed AI connection, so under managed_only an
 * AI-provider or GitHub credential in its env is an unmanaged credential path: refuse it
 * (names only), and require the isolated run home the heartbeat applies last.
 */
function assertProcessAdapterAuthPolicy(envConfig: Record<string, unknown>, agentId: string) {
  const policy = currentAgentAuthPolicy();
  if (!isManagedOnlyPolicy(policy)) return;
  const keys = findForbiddenProcessAdapterCredentialKeys(envConfig);
  const home = typeof envConfig.HOME === "string" ? envConfig.HOME : null;
  const homeIsolated = isRegisteredRunHome(home);
  if (isManagedOnlyEnforced(policy)) {
    if (keys.length > 0) {
      throw new AgentAuthPolicyError("agent_env_override_forbidden", { adapterType: "process", keys });
    }
    if (!homeIsolated) {
      throw new AgentAuthPolicyError("agent_home_isolation_required", { adapterType: "process" });
    }
    return;
  }
  if (keys.length > 0 || !homeIsolated) {
    logger.warn(
      { agentId, adapterType: "process", keys, homeIsolated, policy },
      "agent auth policy (report-only): process adapter run would be refused under managed_only",
    );
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  assertProcessAdapterAuthPolicy(envConfig, agent.id);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from the strict allowlisted base
  // (buildAgentChildBaseEnv) + env, so no server-only secret on the server process
  // (PAPERCLIP_API_KEY, BETTER_AUTH_SECRET, DATABASE_URL, ...) ever reaches the child.
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn: ctx.onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
