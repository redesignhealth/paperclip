import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  ensureUpgradeTables,
  isValidVectorType,
  UPGRADE_LEDGER_OUTCOMES,
  VECTOR_TYPE_ALLOWLIST_REGEX,
} from "./tenant-tables.js";
import { CompanyMemoryUpgradeError } from "./state-machine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("tenant-tables upgrade machinery", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sql!: ReturnType<typeof postgres>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("tenant-upgrade-tables-");
    sql = postgres(tempDb.connectionString, { max: 1, onnotice: () => {} });
  }, 20_000);

  afterEach(async () => {
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_staging CASCADE`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_ledger CASCADE`;
    await sql`DROP TABLE IF EXISTS paperclip_memory_upgrade_dedupe CASCADE`;
  });

  afterAll(async () => {
    await sql?.end();
    await tempDb?.cleanup();
  });

  it("validates vectorType with dimension bounds 1..16000 and literal text", () => {
    expect(isValidVectorType("text")).toBe(true);
    expect(isValidVectorType("vector(1)")).toBe(true);
    expect(isValidVectorType("vector(1536)")).toBe(true);
    expect(isValidVectorType("vector(384)")).toBe(true);
    expect(isValidVectorType("vector(3072)")).toBe(true);
    expect(isValidVectorType("vector(16000)")).toBe(true);

    // Dimension out of bounds (1..16000)
    expect(isValidVectorType("vector(0)")).toBe(false);
    expect(isValidVectorType("vector(16001)")).toBe(false);
    expect(isValidVectorType("vector(99999)")).toBe(false);

    // Invalid types rejected
    expect(isValidVectorType("varchar")).toBe(false);
    expect(isValidVectorType("jsonb")).toBe(false);
    expect(isValidVectorType("text; DROP TABLE users;")).toBe(false);
    expect(isValidVectorType("vector(1536); DROP TABLE users;")).toBe(false);
    expect(isValidVectorType("vector(notanumber)")).toBe(false);
  });

  it("rejects invalid vectorType without echoing input in error message", async () => {
    const maliciousInput = "vector(1536); DROP TABLE secret_tokens; -- s3cret";

    let caughtErr: Error | undefined;
    try {
      await ensureUpgradeTables(sql, maliciousInput);
    } catch (e: any) {
      caughtErr = e;
    }

    expect(caughtErr).toBeDefined();
    expect(caughtErr).toBeInstanceOf(CompanyMemoryUpgradeError);
    expect((caughtErr as CompanyMemoryUpgradeError).code).toBe("INVALID_ARGUMENT");
    expect(caughtErr!.message).not.toContain("s3cret");
    expect(caughtErr!.message).not.toContain("secret_tokens");
    expect(caughtErr!.message).not.toContain(maliciousInput);

    await expect(ensureUpgradeTables(sql, "vector(0)")).rejects.toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "INVALID_ARGUMENT",
      }),
    );
    await expect(ensureUpgradeTables(sql, "vector(16001)")).rejects.toThrowError(
      expect.objectContaining({
        name: "CompanyMemoryUpgradeError",
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("idempotently creates staging, ledger, and dedupe tables with expected columns and indexes", async () => {
    // First run creates tables
    await ensureUpgradeTables(sql, "text");

    // Second run is a no-op and does not fail
    await expect(ensureUpgradeTables(sql, "text")).resolves.toBeUndefined();

    // Verify all 3 tables exist
    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'paperclip_memory_upgrade_staging',
          'paperclip_memory_upgrade_ledger',
          'paperclip_memory_upgrade_dedupe'
        )
      ORDER BY table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      "paperclip_memory_upgrade_dedupe",
      "paperclip_memory_upgrade_ledger",
      "paperclip_memory_upgrade_staging",
    ]);

    // Verify indexes exist
    const indexes = await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN (
          'paperclip_memory_upgrade_staging',
          'paperclip_memory_upgrade_ledger',
          'paperclip_memory_upgrade_dedupe'
        )
      ORDER BY indexname
    `;
    const indexNames = indexes.map((i) => i.indexname);
    expect(indexNames).toContain("pmu_staging_src_idx");
    expect(indexNames).toContain("pmu_ledger_outcome_idx");
    expect(indexNames).toContain("pmu_dedupe_uq");
  });

  it("enforces unique constraint on (upgrade_id, agent_id, data_sha256) in paperclip_memory_upgrade_dedupe", async () => {
    await ensureUpgradeTables(sql, "text");

    const upgradeId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const dataHash1 = "hash-11111111111111111111111111111111";
    const dataHash2 = "hash-22222222222222222222222222222222";
    const out1 = randomUUID();
    const out2 = randomUUID();
    const out3 = randomUUID();

    // Insert for agentA + hash1 within upgradeId
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id)
      VALUES (${upgradeId}, ${agentA}, ${dataHash1}, ${out1})
    `;

    // Duplicate insert for agentA + hash1 within same upgradeId fails
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id)
        VALUES (${upgradeId}, ${agentA}, ${dataHash1}, ${out2})
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // Same data hash for different agent (agentB) in same upgradeId succeeds
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id)
        VALUES (${upgradeId}, ${agentB}, ${dataHash1}, ${out2})
      `,
    ).resolves.toBeDefined();

    // Different data hash for same agent (agentA) in same upgradeId succeeds
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (upgrade_id, agent_id, data_sha256, output_id)
        VALUES (${upgradeId}, ${agentA}, ${dataHash2}, ${out3})
      `,
    ).resolves.toBeDefined();
  });

  it("stores and queries upgrade staging and ledger rows with vocabulary outcomes", async () => {
    await ensureUpgradeTables(sql, "text");

    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const outputId = randomUUID();
    const agentId = randomUUID();

    // Staging table
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256
      ) VALUES (
        ${upgradeId}, ${sourceId}, ${outputId}, ${agentId},
        ${JSON.stringify({ text: "Hello memory", user_id: agentId })},
        'mock-embedding-vector', 'content-sha-abc'
      )
    `;

    const [staged] = await sql`
      SELECT * FROM paperclip_memory_upgrade_staging WHERE output_id = ${outputId}
    `;
    expect(staged.upgrade_id).toBe(upgradeId);
    expect(staged.embedding).toBe("mock-embedding-vector");

    // Ledger table with published outcome
    expect(UPGRADE_LEDGER_OUTCOMES).toContain("published");
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids
      ) VALUES (
        ${upgradeId}, ${sourceId}, 'content-sha-abc', ${agentId},
        'published', 'converted_ok', ${[outputId]}
      )
    `;

    const [ledger] = await sql`
      SELECT * FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId} AND source_id = ${sourceId}
    `;
    expect(ledger.outcome).toBe("published");
    expect(ledger.output_ids).toEqual([outputId]);
  });

  it("records same source across two upgrade ids after sequential upgrades (rollback/abort)", async () => {
    await ensureUpgradeTables(sql, "text");

    const upgradeId1 = randomUUID();
    const upgradeId2 = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const dataHash = "hash-shared-content-1234567890abcdef";
    const out1 = randomUUID();
    const out2 = randomUUID();

    // 1. Upgrade 1 processes sourceId and records in ledger and dedupe
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids
      ) VALUES (
        ${upgradeId1}, ${sourceId}, ${dataHash}, ${agentId},
        'published', 'converted_ok', ${[out1]}
      )
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES (
        ${upgradeId1}, ${agentId}, ${dataHash}, ${out1}
      )
    `;

    // 2. Upgrade 2 (e.g. after rollback/abort of Upgrade 1) processes same sourceId and records
    await sql`
      INSERT INTO paperclip_memory_upgrade_ledger (
        upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids
      ) VALUES (
        ${upgradeId2}, ${sourceId}, ${dataHash}, ${agentId},
        'published', 'converted_ok', ${[out2]}
      )
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES (
        ${upgradeId2}, ${agentId}, ${dataHash}, ${out2}
      )
    `;

    // Verify both ledger records exist for the same sourceId under distinct upgrade_ids
    const ledgerRows = await sql`
      SELECT upgrade_id, source_id, outcome, output_ids
      FROM paperclip_memory_upgrade_ledger
      WHERE source_id = ${sourceId}
      ORDER BY upgrade_id
    `;
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows.map((r) => r.upgrade_id).sort()).toEqual([upgradeId1, upgradeId2].sort());

    // Duplicate insert for same (upgrade_id, source_id) is rejected by composite PK
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id, source_id, source_content_sha256, agent_id, outcome, reason_code, output_ids
        ) VALUES (
          ${upgradeId1}, ${sourceId}, ${dataHash}, ${agentId},
          'superseded', 'duplicate_run', '{}'
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // Verify dedupe allows same (agent_id, data_sha256) across upgrades, but rejects duplicate in same upgrade
    const dedupeRows = await sql`
      SELECT upgrade_id, agent_id, data_sha256
      FROM paperclip_memory_upgrade_dedupe
      WHERE agent_id = ${agentId} AND data_sha256 = ${dataHash}
    `;
    expect(dedupeRows).toHaveLength(2);

    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (
          upgrade_id, agent_id, data_sha256, output_id
        ) VALUES (
          ${upgradeId1}, ${agentId}, ${dataHash}, ${randomUUID()}
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces database CHECK constraint on ledger outcome", async () => {
    await ensureUpgradeTables(sql, "text");

    const upgradeId = randomUUID();
    const sourceId = randomUUID();

    // Valid outcome from UPGRADE_LEDGER_OUTCOMES succeeds
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id, source_id, source_content_sha256, outcome, output_ids
        ) VALUES (
          ${upgradeId}, ${sourceId}, 'hash-valid', 'published', '{}'
        )
      `,
    ).resolves.toBeDefined();

    // Invalid outcome fails with CHECK constraint violation (23514)
    const invalidSourceId = randomUUID();
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id, source_id, source_content_sha256, outcome, output_ids
        ) VALUES (
          ${upgradeId}, ${invalidSourceId}, 'hash-invalid', 'invented_opaque_outcome', '{}'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
