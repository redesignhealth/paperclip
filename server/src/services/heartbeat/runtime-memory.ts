import type { AdapterRuntimeMemoryAccess } from "@paperclipai/adapter-utils";
import { resolveMemoryHardeningFlags, type MemoryHardeningFlags } from "@paperclipai/adapter-utils/server-utils";
import { companyMemoryDatabaseService } from "../company-memory-databases.js";
import {
  isSupportedCompanyMemoryEmbedding,
  UnsupportedMemoryEmbeddingError,
  UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE,
  isUnsupportedMemoryEmbeddingError,
  HERMES_ADAPTER_TYPE,
  adapterSupportsRuntimeMemory,
} from "../company-memory-constants.js";
import { recordAgentScopedMemoryUse } from "../memory-scope-observations.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { logger } from "../../middleware/logger.js";

export {
  HERMES_ADAPTER_TYPE,
  adapterSupportsRuntimeMemory,
  UnsupportedMemoryEmbeddingError,
  UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE,
  isUnsupportedMemoryEmbeddingError,
};

/**
 * `adapterConfig.runtimeMemory === false` is the only opt-out value. Anything else (absent, null,
 * true, strings such as "false") keeps the company-level behavior.
 */
export function isRuntimeMemoryDisabledForAgent(adapterConfig: unknown): boolean {
  return (
    typeof adapterConfig === "object" &&
    adapterConfig !== null &&
    (adapterConfig as Record<string, unknown>).runtimeMemory === false
  );
}

/**
 * Resolve the isolated company memory database for a run and wrap it in the
 * adapter-facing runtime memory accessor. The password is registered with the
 * run secret redaction registry before it is handed to the adapter so that it
 * cannot leak through run logs or transcripts.
 *
 * When agent-scoped Mem0 hardening is active and the company has recorded a
 * completed scope migration, userId is scoped to the agent's ID; otherwise,
 * it defaults to "company".
 */
export async function resolveHeartbeatRuntimeMemory(input: {
  db: any;
  agent: {
    id: string;
    adapterType: string | null | undefined;
    companyId: string;
    adapterConfig?: unknown;
  };
  runId: string;
  flags?: MemoryHardeningFlags;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<AdapterRuntimeMemoryAccess | undefined> {
  const { db, agent, runId } = input;
  if (!adapterSupportsRuntimeMemory(agent.adapterType)) {
    return undefined;
  }
  if (isRuntimeMemoryDisabledForAgent(agent.adapterConfig)) {
    // Per-agent opt-out (`adapterConfig.runtimeMemory === false`): this agent uses another memory
    // route, so no company memory database is resolved, no secret is registered, and no config is built.
    return undefined;
  }
  const memorySvc = companyMemoryDatabaseService(db);
  if (!memorySvc.isSupported()) {
    return undefined;
  }
  const descriptor = await memorySvc.resolveRuntimeConfig(agent.companyId, runId);
  if (!descriptor) {
    return undefined;
  }
  if (
    !isSupportedCompanyMemoryEmbedding({
      model: descriptor.embeddingModel,
      dimensions: descriptor.embeddingDimensions,
    })
  ) {
    throw new UnsupportedMemoryEmbeddingError(
      agent.companyId,
      descriptor.embeddingModel,
      descriptor.embeddingDimensions,
    );
  }
  await createRunSecretRedactionRegistry(db).register(agent.companyId, runId, descriptor.password);

  const flags = input.flags ?? resolveMemoryHardeningFlags(input.env ?? process.env);
  const effectiveUserId =
    flags.agentScopedMem0 && descriptor.scopeMigrationCompletedAt != null
      ? agent.id
      : "company";

  if (effectiveUserId === agent.id) {
    void recordAgentScopedMemoryUse(db, agent.companyId).catch(() => {});
  }

  if (flags.agentScopedMem0 && descriptor.scopeMigrationCompletedAt == null) {
    logger.warn(
      { companyId: agent.companyId },
      "Company memory has not completed agent scope migration; falling back to company user_id",
    );
  }

  return {
    getConfig: () => ({
      provider: "mem0",
      mode: "oss",
      userId: effectiveUserId,
      agentId: agent.id,
      llm: {
        provider: "openai",
        config: { model: "gpt-5.4-mini" },
      },
      embedder: {
        provider: "openai",
        config: {
          model: descriptor.embeddingModel,
          embedding_dims: descriptor.embeddingDimensions,
        },
      },
      vectorStore: {
        provider: "pgvector",
        config: {
          host: descriptor.host,
          port: descriptor.port,
          user: descriptor.user,
          password: descriptor.password,
          dbname: descriptor.dbname,
          sslmode: descriptor.sslmode,
          collectionName: descriptor.collectionName,
        },
      },
    }),
  };
}
