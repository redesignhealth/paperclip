/**
 * Shared test helpers for recover command tests (TECH-8191 §Q6, PR5.11).
 */

import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import {
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";

export {
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupPublishTestEnvironment,
};

export const BASE_RECOVER_UPGRADE_VALUES = {
  converterId: "paperclip.memory-upgrade.atomic-converter",
  converterVersion: 1,
  collectionName: "mem0_memories",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
};

export async function insertRecoverUpgrade(
  cpDb: any,
  companyId: string,
  overrides: Record<string, unknown> = {},
) {
  const [row] = await cpDb
    .insert(companyMemoryUpgrades)
    .values({ ...BASE_RECOVER_UPGRADE_VALUES, companyId, ...overrides })
    .returning();
  return row;
}
