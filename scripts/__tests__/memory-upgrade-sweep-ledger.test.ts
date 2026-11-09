/**
 * Ledger and tenant table operations test for company memory upgrade sweep (TECH-8191).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  commitSourceOutcome,
  ensureUpgradeTables,
  KNOWN_SENSITIVE_FAMILY_NAMES,
  loadLedgerForSources,
  openTenantClient,
  reconcileChangedContent,
  reconcileTombstones,
  VALID_NOISE_REASONS,
  VALID_UNROUTABLE_REASONS,
  validateOutcomeReason,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import {
  isValidVectorType,
  quoteVectorType,
} from "../../server/src/services/company-memory-upgrade/tenant-tables.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";
import { CompanyMemoryUpgradeError, UPGRADE_LEDGER_OUTCOMES } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  setupTenantMem0Table,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("sweep-tenant ledger operations", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sweep-ledger-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");

  await t.test("ensureUpgradeTables creates tables and indexes idempotently", async () => {
    // First run creates tables
    await ensureUpgradeTables(sql, "text");

    // Second run is a clean no-op
    await ensureUpgradeTables(sql, "text");

    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'paperclip_memory_upgrade_staging',
          'paperclip_memory_upgrade_ledger',
          'paperclip_memory_upgrade_dedupe'
        )
      ORDER BY table_name;
    `;
    assert.deepEqual(
      tables.map((t) => t.table_name),
      [
        "paperclip_memory_upgrade_dedupe",
        "paperclip_memory_upgrade_ledger",
        "paperclip_memory_upgrade_staging",
      ],
    );
  });

  await t.test("commitSourceOutcome upserts ledger records correctly", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const initialHash = computeSourceContentSha256("Initial text");

    // Initial insert
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: initialHash,
      agentId,
      outcome: "unroutable",
      reasonCode: "missing_agent_id",
    });

    let ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.size, 1);
    const row1 = ledgerMap.get(sourceId)!;
    assert.equal(row1.outcome, "unroutable");
    assert.equal(row1.reasonCode, "missing_agent_id");
    assert.equal(row1.sourceContentSha256, initialHash);

    // Update via conflict
    const updatedHash = computeSourceContentSha256("Updated text");
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: updatedHash,
      agentId,
      outcome: "dropped_noise",
      reasonCode: "exact_placeholder_or_greeting",
    });

    ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    assert.equal(ledgerMap.size, 1);
    const row2 = ledgerMap.get(sourceId)!;
    assert.equal(row2.outcome, "dropped_noise");
    assert.equal(row2.reasonCode, "exact_placeholder_or_greeting");
    assert.equal(row2.sourceContentSha256, updatedHash);
  });

  await t.test("outcome CHECK constraint rejects junk outcome", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();

    await assert.rejects(
      async () => {
        await sql`
          INSERT INTO paperclip_memory_upgrade_ledger (
            upgrade_id, source_id, source_content_sha256, outcome
          ) VALUES (
            ${upgradeId}::uuid, ${sourceId}::uuid, 'hash123', 'junk_outcome'
          );
        `;
      },
      (err: any) => {
        assert.equal(err.code, "23514"); // check_violation
        return true;
      },
    );

    // Conforms to UPGRADE_LEDGER_OUTCOMES vocabulary
    for (const validOutcome of UPGRADE_LEDGER_OUTCOMES) {
      const srcId = randomUUID();
      await sql`
        INSERT INTO paperclip_memory_upgrade_ledger (
          upgrade_id, source_id, source_content_sha256, outcome
        ) VALUES (
          ${upgradeId}::uuid, ${srcId}::uuid, 'hash123', ${validOutcome}
        );
      `;
    }
  });

  await t.test("tombstone -> source_deleted with unpublished staging removed and published staging retained", async () => {
    const upgradeId = randomUUID();
    const liveSourceId = randomUUID();
    const tombstoneSourceId = randomUUID();
    const agentId = randomUUID();

    const outputPublished = randomUUID();
    const outputUnpublished = randomUUID();

    // 1. Seed live source in mem0_memories
    await sql`
      INSERT INTO mem0_memories (id, payload, vector)
      VALUES (${liveSourceId}::uuid, '{"data": "still here"}'::jsonb, 'v1');
    `;

    // 2. Seed ledger rows for both
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: liveSourceId,
      sourceContentSha256: "hash-live",
      agentId,
      outcome: "published",
    });

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: tombstoneSourceId,
      sourceContentSha256: "hash-tombstone",
      agentId,
      outcome: "published",
    });

    // 3. Seed staging and dedupe rows for tombstone source: one published, one unpublished
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
      ) VALUES
        (${upgradeId}::uuid, ${tombstoneSourceId}::uuid, ${outputPublished}::uuid, ${agentId}::uuid, '{"data": "pub"}'::jsonb, 'vec', 'h1', now()),
        (${upgradeId}::uuid, ${tombstoneSourceId}::uuid, ${outputUnpublished}::uuid, ${agentId}::uuid, '{"data": "unpub"}'::jsonb, 'vec', 'h2', null);
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES
        (${upgradeId}::uuid, ${agentId}::uuid, 'data-hash-pub', ${outputPublished}::uuid),
        (${upgradeId}::uuid, ${agentId}::uuid, 'data-hash-unpub', ${outputUnpublished}::uuid);
    `;

    // 4. Reconcile tombstones
    const result = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "mem0_memories",
    });

    assert.equal(result.tombstonesCount, 1);
    assert.deepEqual(result.tombstoneSourceIds, [tombstoneSourceId]);
    assert.equal(result.deletedStagingCount, 1);
    assert.equal(result.deletedDedupeCount, 1);

    // Ledger for tombstone source is now source_deleted
    const [tombstoneLedger] = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${tombstoneSourceId}::uuid;
    `;
    assert.equal(tombstoneLedger.outcome, "source_deleted");

    // Published staging row is retained!
    const stagingRows = await sql`
      SELECT output_id, published_at FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${tombstoneSourceId}::uuid;
    `;
    assert.equal(stagingRows.length, 1);
    assert.equal(stagingRows[0].output_id, outputPublished);
    assert.ok(stagingRows[0].published_at !== null);

    // Dedupe row for published output is retained, unpublished was deleted
    const dedupeRows = await sql`
      SELECT output_id FROM paperclip_memory_upgrade_dedupe
      WHERE upgrade_id = ${upgradeId}::uuid;
    `;
    assert.equal(dedupeRows.length, 1);
    assert.equal(dedupeRows[0].output_id, outputPublished);

    // Second reconcile call skips already source_deleted row
    const secondResult = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "mem0_memories",
    });
    assert.equal(secondResult.tombstonesCount, 0);
  });

  await t.test("content change -> superseded and clears unpublished staging and dedupe", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();
    const outputId = randomUUID();

    // Seed ledger row
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: "old-hash",
      agentId,
      outcome: "published",
    });

    // Seed unpublished staging and dedupe
    await sql`
      INSERT INTO paperclip_memory_upgrade_staging (
        upgrade_id, source_id, output_id, agent_id, payload, embedding, content_sha256, published_at
      ) VALUES
        (${upgradeId}::uuid, ${sourceId}::uuid, ${outputId}::uuid, ${agentId}::uuid, '{"data": "content"}'::jsonb, 'vec', 'old-hash', null);
    `;

    await sql`
      INSERT INTO paperclip_memory_upgrade_dedupe (
        upgrade_id, agent_id, data_sha256, output_id
      ) VALUES
        (${upgradeId}::uuid, ${agentId}::uuid, 'old-data-hash', ${outputId}::uuid);
    `;

    // Reconcile changed content
    const res = await reconcileChangedContent(sql, upgradeId, sourceId);
    assert.equal(res.deletedStagingCount, 1);
    assert.equal(res.deletedDedupeCount, 1);

    const [ledgerRow] = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(ledgerRow, undefined, "Stale ledger row is deleted to allow clean reclassification");

    const stagingCount = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_staging
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(stagingCount[0].count, 0);

    const dedupeCount = await sql`
      SELECT count(*)::int AS count FROM paperclip_memory_upgrade_dedupe
      WHERE upgrade_id = ${upgradeId}::uuid AND output_id = ${outputId}::uuid;
    `;
    assert.equal(dedupeCount[0].count, 0);
  });

  await t.test("loadLedgerForSources identifies matching hashes for resume skip", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const hash = computeSourceContentSha256("Unchanged text");

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: hash,
      agentId: null,
      outcome: "dropped_noise",
      reasonCode: "empty",
    });

    const ledgerMap = await loadLedgerForSources(sql, upgradeId, [sourceId]);
    const row = ledgerMap.get(sourceId);
    assert.ok(row);
    assert.equal(row.sourceContentSha256, hash);
  });

  await t.test("runtime validation rejects direct unsafe casts and arbitrary strings in reasonCode", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const hash = computeSourceContentSha256("Test text");

    // 1. Invalid unroutable reason code
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "unroutable",
          reasonCode: "arbitrary_unroutable_reason" as any,
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 2. Invalid noise reason code
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "dropped_noise",
          reasonCode: "random_noise_tag" as any,
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 3. Unsorted sensitive family tokens
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "dropped_sensitive",
          reasonCode: "ssn,apiKey", // not sorted alphabetically
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 4. Unknown sensitive family token
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "dropped_sensitive",
          reasonCode: "apiKey,secretPassportNumber",
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 5. Reason code supplied on outcome that forbids reason code (superseded)
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "superseded",
          reasonCode: "arbitrary_reason" as any,
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 6. Memory-derived text rejected
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "dropped_noise",
          reasonCode: "User prefers coffee with milk and two sugars in the morning" as any,
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );

    // 6b. Malicious sensitive family name is rejected without echoing token
    await assert.rejects(
      async () => {
        await commitSourceOutcome(sql, {
          upgradeId,
          sourceId,
          sourceContentSha256: hash,
          agentId: null,
          outcome: "dropped_sensitive",
          reasonCode: "apiKey,malicious_payload_token",
        });
      },
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(!err.message.includes("malicious_payload_token"));
        return true;
      },
    );

    // 7. Valid sorted sensitive family combination accepted
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: hash,
      agentId: null,
      outcome: "dropped_sensitive",
      reasonCode: "apiKey,passwordAssignment",
    });

    const [row] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(row.outcome, "dropped_sensitive");
    assert.equal(row.reason_code, "apiKey,passwordAssignment");
  });

  await t.test("tombstone reconciliation batches are lease-fenced and abort mid-batch on lease loss without further writes", async () => {
    const upgradeId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();

    for (const id of ids) {
      await commitSourceOutcome(sql, {
        upgradeId,
        sourceId: id,
        sourceContentSha256: "hash",
        agentId: null,
        outcome: "dropped_noise",
        reasonCode: "empty",
      });
    }

    let assertionCallCount = 0;
    const assertLeaseActive = () => {
      assertionCallCount++;
      // Throw on 3rd call (1st is initial preflight, 2nd is batch 1, 3rd is batch 2)
      if (assertionCallCount >= 3) {
        throw new CompanyMemoryUpgradeError("Lease lost mid-batch", "lease_fenced_out");
      }
    };

    await assert.rejects(
      async () => {
        await reconcileTombstones(sql, upgradeId, {
          tombstoneSourceIds: ids,
          batchSize: 2,
          assertLeaseActive,
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "lease_fenced_out",
    );

    // Batch 1 ([ids[0], ids[1]]) was committed before the loss
    const rowsBatch1 = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ANY(${[ids[0], ids[1]]}::uuid[]);
    `;
    assert.equal(rowsBatch1.length, 2);
    assert.ok(rowsBatch1.every((r) => r.outcome === "source_deleted"));

    // Batch 2 ([ids[2], ids[3]]) was fenced out and NEVER written
    const rowsBatch2 = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ANY(${[ids[2], ids[3]]}::uuid[]);
    `;
    assert.equal(rowsBatch2.length, 2);
    assert.ok(rowsBatch2.every((r) => r.outcome === "dropped_noise"));
  });

  await t.test("reconcileTombstones safely handles live tables with text ID column", async () => {
    const upgradeId = randomUUID();
    const idLive = randomUUID();
    const idDeleted = randomUUID();

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS text_id_memories (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        vector text
      );
    `);

    await sql.unsafe(
      `INSERT INTO text_id_memories (id, payload, vector) VALUES ($1, '{"data": "live"}'::jsonb, 'vec') ON CONFLICT DO NOTHING;`,
      [idLive],
    );

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: idLive,
      sourceContentSha256: "live-hash",
      agentId: null,
      outcome: "dropped_noise",
      reasonCode: "empty",
    });

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: idDeleted,
      sourceContentSha256: "del-hash",
      agentId: null,
      outcome: "dropped_noise",
      reasonCode: "empty",
    });

    // Reconcile with isUuidId: false against text_id_memories
    const res = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "text_id_memories",
      isUuidId: false,
    });

    assert.equal(res.tombstonesCount, 1);
    assert.deepEqual(res.tombstoneSourceIds, [idDeleted]);

    const [delRow] = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${idDeleted}::uuid;
    `;
    assert.equal(delRow.outcome, "source_deleted");

    const [liveRow] = await sql`
      SELECT outcome FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${idLive}::uuid;
    `;
    assert.equal(liveRow.outcome, "dropped_noise");
  });

  await t.test("loadLedgerForSources and reconcileTombstones refuse unsupported non-UUID IDs upfront", async () => {
    const upgradeId = randomUUID();

    await assert.rejects(
      async () => {
        await loadLedgerForSources(sql, upgradeId, ["not-a-valid-uuid"]);
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_SOURCE_ID",
    );

    await assert.rejects(
      async () => {
        await reconcileTombstones(sql, upgradeId, {
          tombstoneSourceIds: ["not-a-valid-uuid"],
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_SOURCE_ID",
    );

    // Interior invalid ID in liveSourceIds is rejected upfront before any mutation
    await assert.rejects(
      async () => {
        await reconcileTombstones(sql, upgradeId, {
          minSourceId: randomUUID(),
          maxSourceId: randomUUID(),
          liveSourceIds: [randomUUID(), "malicious-interior-non-uuid", randomUUID()],
        });
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_SOURCE_ID",
    );
  });

  await t.test("tombstone reconciliation is idempotent and sets reason_code to null", async () => {
    const upgradeId = randomUUID();
    const sourceId = randomUUID();
    const agentId = randomUUID();

    // 1. Commit initial outcome with reason_code
    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: "hash-tomb-test",
      agentId,
      outcome: "dropped_noise",
      reasonCode: "empty",
    });

    const [rowBefore] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(rowBefore.outcome, "dropped_noise");
    assert.equal(rowBefore.reason_code, "empty");

    // 2. Reconcile tombstone pass 1: transitions row and returns count 1
    const res1 = await reconcileTombstones(sql, upgradeId, {
      tombstoneSourceIds: [sourceId],
    });
    assert.equal(res1.tombstonesCount, 1);

    const [rowAfter1] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(rowAfter1.outcome, "source_deleted");
    assert.equal(rowAfter1.reason_code, null, "reason_code must be set to null");

    // 3. Reconcile tombstone pass 2 (idempotence): does NOT re-transition and returns count 0
    const res2 = await reconcileTombstones(sql, upgradeId, {
      tombstoneSourceIds: [sourceId],
    });
    assert.equal(res2.tombstonesCount, 0, "Repeated tombstone pass counts zero transitions");
  });

  await t.test("schema-qualified and quoted vector types are safely validated and quoted", async () => {
    assert.ok(isValidVectorType("text"));
    assert.ok(isValidVectorType("vector(1536)"));
    assert.ok(isValidVectorType("ext.vector(1536)"));
    assert.ok(isValidVectorType('"extensions".vector(768)'));
    assert.ok(isValidVectorType('"public"."vector"(1536)'));

    assert.equal(quoteVectorType("text"), "text");
    assert.equal(quoteVectorType("vector(1536)"), "vector(1536)");
    assert.equal(quoteVectorType("ext.vector(1536)"), '"ext"."vector"(1536)');
    assert.equal(quoteVectorType('"extensions".vector(768)'), '"extensions"."vector"(768)');

    // Invalids rejected
    assert.ok(!isValidVectorType("vector(0)"));
    assert.ok(!isValidVectorType("vector(16001)"));
    assert.ok(!isValidVectorType("bad-ident;drop.vector(1536)"));
    assert.ok(!isValidVectorType(""));
    assert.ok(!isValidVectorType("int"));
  });

  await t.test("validateOutcomeReason direct tests: all KNOWN_SENSITIVE_FAMILY_NAMES camelCase pass", async () => {
    // 1. Confirm each individual sensitive family in camelCase passes validation
    for (const family of KNOWN_SENSITIVE_FAMILY_NAMES) {
      const validated = validateOutcomeReason("dropped_sensitive", family);
      assert.equal(validated, family, `Sensitive family ${family} must pass validation`);
    }

    // 2. Confirm sorted, deduplicated multi-token combinations pass
    const allSorted = [...KNOWN_SENSITIVE_FAMILY_NAMES].sort().join(",");
    const validatedAll = validateOutcomeReason("dropped_sensitive", allSorted);
    assert.equal(validatedAll, allSorted);

    const twoFamilies = [KNOWN_SENSITIVE_FAMILY_NAMES[0], KNOWN_SENSITIVE_FAMILY_NAMES[1]].sort().join(",");
    assert.equal(validateOutcomeReason("dropped_sensitive", twoFamilies), twoFamilies);

    // 3. Confirm unroutable and dropped_noise valid reasons pass
    for (const r of VALID_UNROUTABLE_REASONS) {
      assert.equal(validateOutcomeReason("unroutable", r), r);
    }
    for (const r of VALID_NOISE_REASONS) {
      assert.equal(validateOutcomeReason("dropped_noise", r), r);
    }

    // 4. Invalids throw INVALID_ARGUMENT
    assert.throws(
      () => validateOutcomeReason("dropped_sensitive", "unknown_family"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => validateOutcomeReason("dropped_sensitive", "apiKey,apiKey"), // duplicate
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => validateOutcomeReason("dropped_sensitive", "ssn,apiKey"), // unsorted
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => validateOutcomeReason("unroutable", "bogus_unroutable"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => validateOutcomeReason("dropped_noise", "bogus_noise"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  });
});
