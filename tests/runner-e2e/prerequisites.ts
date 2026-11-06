import type { MatrixExecution } from "./types.js";
import { parseCompanyMemoryConfig } from "../../server/src/services/company-memory-config.js";
import {
  resolveMemoryHardeningFlags,
  type MemoryHardeningFlags,
} from "../../packages/shared/src/index.js";
import {
  MEMORY_HARDENING_CAPABILITIES,
  UNIMPLEMENTED_MEMORY_HARDENING_TICKETS,
} from "./memory-recall-cases.js";

/** Explicit-only profiles blocked until complete identity/auth/session/billing qualification. */
export const PENDING_PROFILE_PREREQUISITES = {
  "legacy-kimi-cli": "Kimi CLI identity/auth/skills/session/billing qualification is pending",
  "legacy-kimi-acp": "Kimi ACP identity/auth/skills/session/billing qualification is pending",
  "legacy-grok": "Grok identity/auth/skills/session/billing qualification is pending",
} as const;

/** Qualification fixtures use explicit models; there is no runtime model roster. */
export const UNQUALIFIED_PROFILE_GAPS = {
} as const;

/** Reject missing remote observer authority before creating a company or run. */
export function assertRemoteNativeEvidencePrerequisites(
  executions: readonly MatrixExecution[],
  environment: NodeJS.ProcessEnv,
): void {
  if (!executions.some(execution => execution.environment.id === "daytona"
    && ["cursor_native", "pi_native", "pi_controls", "copilot_protection", "native_active_stop", "native_provider_loss"].includes(execution.task.flow))) return;
  const names = ["PAPERCLIP_E2E_DAYTONA_NODE_SHA256", "PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256"];
  const invalid = names.filter(name => !/^sha256:[a-f0-9]{64}$/u.test(environment[name] ?? ""));
  if (invalid.length) throw new Error(`Native Daytona evidence requires exact image executable digests: ${invalid.join(", ")}`);
}

export function assertRunnerE2EPrerequisites(
  executions: readonly MatrixExecution[],
): void {
  const blocked = [...new Set(
    executions
      .map((execution) => execution.profile.id)
      .filter((profileId): profileId is keyof typeof PENDING_PROFILE_PREREQUISITES =>
        profileId in PENDING_PROFILE_PREREQUISITES,
      ),
  )];
  if (blocked.length === 0) return;
  throw new Error(
    `Selected runner E2E profile prerequisite(s) are pending: ${blocked
      .map((profileId) => `${profileId} (${PENDING_PROFILE_PREREQUISITES[profileId]})`)
      .join("; ")}. No provider credentials were loaded or sent.`,
  );
}

export function assertMemoryRecallPrerequisites(
  executions: readonly MatrixExecution[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    !executions.some(
      (execution) =>
        execution.suite.id === "memory-recall" ||
        execution.task.flow === "memory_recall",
    )
  ) {
    return;
  }
  if (env.PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED !== "true") {
    throw new Error(
      "Memory recall suite requires PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED='true'.",
    );
  }
  if (env.PAPERCLIP_MEMORY_COMPANY_SCOPE !== "all") {
    throw new Error(
      "Memory recall suite requires PAPERCLIP_MEMORY_COMPANY_SCOPE='all'.",
    );
  }
  const parsed = parseCompanyMemoryConfig(env);
  if (!parsed.enabled || parsed.companyScope !== "all" || !parsed.adminDatabaseUrl) {
    throw new Error(
      "Memory recall suite requires valid company memory configuration with enabled=true, companyScope='all', and adminDatabaseUrl.",
    );
  }
  if (!env.PAPERCLIP_E2E_MEMORY_HERMES_MODEL?.trim()) {
    throw new Error(
      "Memory recall suite requires PAPERCLIP_E2E_MEMORY_HERMES_MODEL to specify the Hermes runner model.",
    );
  }
  if (!env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("Memory recall suite requires OPENROUTER_API_KEY.");
  }
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error("Memory recall suite requires OPENAI_API_KEY.");
  }
  const flags = resolveMemoryHardeningFlags(env);
  for (const [flagKey, status] of Object.entries(
    MEMORY_HARDENING_CAPABILITIES,
  ) as [keyof MemoryHardeningFlags, "implemented" | "not-implemented"][]) {
    if (flags[flagKey] && status === "not-implemented") {
      const info =
        UNIMPLEMENTED_MEMORY_HARDENING_TICKETS[
          flagKey as keyof typeof UNIMPLEMENTED_MEMORY_HARDENING_TICKETS
        ];
      throw new Error(
        `Memory hardening token '${info.token}' is not implemented on this branch (blocked pending ${info.ticket}).`,
      );
    }
  }
}
