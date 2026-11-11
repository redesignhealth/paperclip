/**
 * Shared test helpers for company memory upgrade publish tests (TECH-8191).
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export interface SeedStagedMemoryParams {
  upgradeId: string;
  sourceId: string;
  outputId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
  publishedAt?: Date | null;
  contentSha256?: string;
  vector?: string;
}

export async function seedStagedMemory(
  sql: postgres.Sql,
  params: SeedStagedMemoryParams,
): Promise<{ outputId: string; payload: Record<string, unknown> }> {
  const outputId = params.outputId ?? randomUUID();
  const agentId = params.agentId ?? randomUUID();
  const payload = params.payload ?? {
    data: "test staged memory payload",
    agent_id: agentId,
    migration_id: params.upgradeId,
    migrated_from: params.sourceId,
  };
  const contentSha256 = params.contentSha256 ?? "test-sha256";
  const vector = params.vector ?? JSON.stringify(new Array(1536).fill(0.01));
  const publishedAtSql = params.publishedAt ? sql`${params.publishedAt}` : null;

  await sql`
    INSERT INTO paperclip_memory_upgrade_staging (
      upgrade_id,
      source_id,
      output_id,
      agent_id,
      payload,
      embedding,
      content_sha256,
      published_at,
      created_at
    ) VALUES (
      ${params.upgradeId}::uuid,
      ${params.sourceId}::uuid,
      ${outputId}::uuid,
      ${agentId}::uuid,
      ${JSON.stringify(payload)}::jsonb,
      ${vector},
      ${contentSha256},
      ${publishedAtSql},
      now()
    );
  `;

  return { outputId, payload };
}

export async function seedLedgerRow(
  sql: postgres.Sql,
  params: {
    upgradeId: string;
    sourceId: string;
    agentId?: string;
    outcome?: string;
    outputIds?: string[];
    sourceContentSha256?: string;
  },
): Promise<void> {
  const agentId = params.agentId ?? randomUUID();
  const outcome = params.outcome ?? "published";
  const outputIds = params.outputIds ?? [];
  const sha = params.sourceContentSha256 ?? "source-content-sha";

  await sql`
    INSERT INTO paperclip_memory_upgrade_ledger (
      upgrade_id,
      source_id,
      source_content_sha256,
      agent_id,
      outcome,
      output_ids,
      created_at,
      updated_at
    ) VALUES (
      ${params.upgradeId}::uuid,
      ${params.sourceId}::uuid,
      ${sha},
      ${agentId}::uuid,
      ${outcome},
      ${outputIds}::uuid[],
      now(),
      now()
    )
    ON CONFLICT (upgrade_id, source_id) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      output_ids = EXCLUDED.output_ids,
      updated_at = now();
  `;
}
