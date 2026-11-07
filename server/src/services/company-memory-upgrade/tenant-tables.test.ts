import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  ensureUpgradeTables,
  UPGRADE_LEDGER_OUTCOMES,
  VECTOR_TYPE_ALLOWLIST_REGEX,
} from "./tenant-tables.js";

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

  it("validates vectorType with strict allowlist regex", () => {
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("text")).toBe(true);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("vector(1536)")).toBe(true);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("vector(384)")).toBe(true);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("vector(3072)")).toBe(true);

    // Invalid types rejected
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("varchar")).toBe(false);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("jsonb")).toBe(false);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("text; DROP TABLE users;")).toBe(false);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("vector(1536); DROP TABLE users;")).toBe(false);
    expect(VECTOR_TYPE_ALLOWLIST_REGEX.test("vector(notanumber)")).toBe(false);
  });

  it("rejects invalid vectorType when executing ensureUpgradeTables", async () => {
    await expect(ensureUpgradeTables(sql, "invalid_type")).rejects.toThrowError(
      /Invalid vectorType/,
    );
    await expect(ensureUpgradeTables(sql, "text; DROP TABLE users;")).rejects.toThrowError(
      /Invalid vectorType/,
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

  it("enforces unique constraint on (agent_id, data_sha256) in paperclip_memory_upgrade_dedupe", async () => {
    await ensureUpgradeTables(sql, "text");

    const agentA = randomUUID();
    const agentB = randomUUID();
    const dataHash1 = "hash-11111111111111111111111111111111";
    const dataHash2 = "hash-22222222222222222222222222222222";
    const out1 = randomUUID();
    const out2 = randomUUID();
    const out3 = randomUUID();

    // Insert for agentA + hash1
    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (agent_id, data_sha256, output_id)
      VALUES (${agentA}, ${dataHash1}, ${out1})
    `;

    // Duplicate insert for agentA + hash1 fails
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (agent_id, data_sha256, output_id)
        VALUES (${agentA}, ${dataHash1}, ${out2})
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // Same data hash for different agent (agentB) succeeds
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (agent_id, data_sha256, output_id)
        VALUES (${agentB}, ${dataHash1}, ${out2})
      `,
    ).resolves.toBeDefined();

    // Different data hash for same agent (agentA) succeeds
    await expect(
      sql`
        INSERT INTO paperclip_memory_upgrade_dedupe (agent_id, data_sha256, output_id)
        VALUES (${agentA}, ${dataHash2}, ${out3})
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
        source_id, upgrade_id, source_content_sha256, agent_id, outcome, reason_code, output_ids
      ) VALUES (
        ${sourceId}, ${upgradeId}, 'content-sha-abc', ${agentId},
        'published', 'converted_ok', ${[outputId]}
      )
    `;

    const [ledger] = await sql`
      SELECT * FROM paperclip_memory_upgrade_ledger WHERE source_id = ${sourceId}
    `;
    expect(ledger.outcome).toBe("published");
    expect(ledger.output_ids).toEqual([outputId]);
  });
});
