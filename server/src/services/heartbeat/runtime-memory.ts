import type { AdapterRuntimeMemoryAccess } from "@paperclipai/adapter-utils";
import { resolveMemoryHardeningFlags, type MemoryHardeningFlags } from "@paperclipai/adapter-utils/server-utils";
import { companyMemoryDatabaseService } from "../company-memory-databases.js";
import { recordAgentScopedMemoryUse } from "../memory-scope-observations.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { HERMES_ADAPTER_TYPE } from "./run-state.js";
import { logger } from "../../middleware/logger.js";

/**
 * Only the local Hermes adapter consumes the per-company Mem0/pgvector
 * descriptor. Gateway adapters run outside the host and must never receive
 * per-company database credentials.
 */
export function adapterSupportsRuntimeMemory(adapterType: string | null | undefined): boolean {
  return adapterType === HERMES_ADAPTER_TYPE;
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
  agent: { id: string; adapterType: string | null | undefined; companyId: string };
  runId: string;
  flags?: MemoryHardeningFlags;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<AdapterRuntimeMemoryAccess | undefined> {
  const { db, agent, runId } = input;
  if (!adapterSupportsRuntimeMemory(agent.adapterType)) {
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
  await createRunSecretRedactionRegistry(db).register(agent.companyId, runId, descriptor.password);

  const flags = input.flags ?? resolveMemoryHardeningFlags(input.env ?? process.env);
  const effectiveUserId =
    flags.agentScopedMem0 && descriptor.scopeMigrationCompletedAt != null
      ? agent.id
      : "company";

  if (effectiveUserId === agent.id) {
    void recordAgentScopedMemoryUse(db, agent.companyId).catch((err) => {
      logger.debug({ companyId: agent.companyId }, "Agent-scoped memory observation recording rejected");
    });
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
