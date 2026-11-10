/**
 * Ledger reason-code validation and tombstone-reconciliation edge-case tests for company
 * memory upgrade sweep (TECH-8191). Split from memory-upgrade-sweep-ledger.test.ts to keep
 * each test file under the 800-line budget.
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
  reconcileTombstones,
  VALID_NOISE_REASONS,
  VALID_UNROUTABLE_REASONS,
  validateOutcomeReason,
} from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";
import { claimTenantFenceForTestSetup } from "../../server/src/services/company-memory-upgrade/tenant-fence.testing.js";
import {
  MODEL_CLASSIFIED_NOISE_REASON_CODE,
  MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
} from "../../server/src/services/company-memory-upgrade/llm-converter.js";
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

test("sweep-tenant ledger reason-code validation and tombstone edge cases", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const fixture = await startEmbeddedPostgresTestDatabase("sweep-ledger-validation-");
  const sql = openTenantClient(fixture.connectionString);

  t.after(async () => {
    await sql.end();
    await fixture.cleanup();
  });

  await setupTenantMem0Table(sql, "mem0_memories");
  await ensureUpgradeTables(sql, "text");

  await t.test("runtime validation rejects direct unsafe casts and arbitrary strings in reasonCode", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
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
        }, fence);
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
        }, fence);
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
        }, fence);
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
        }, fence);
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
        }, fence);
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
        }, fence);
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
        }, fence);
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
    }, fence);

    const [row] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(row.outcome, "dropped_sensitive");
    assert.equal(row.reason_code, "apiKey,passwordAssignment");
  });

  await t.test("model-classified sensitive reason_code is a permitted exact literal, distinct from family CSV", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const sourceId = randomUUID();
    const hash = computeSourceContentSha256("Model classified test text");

    assert.equal(validateOutcomeReason("dropped_sensitive", "model_classified"), "model_classified");

    // Guard against drift: validateOutcomeReason must accept the exact producer constant
    // llm-converter.ts emits for model-decided drop_sensitive outcomes (TECH-8191 Argus
    // round 1 finding -- already fixed here, this assertion pins it).
    assert.equal(MODEL_CLASSIFIED_SENSITIVE_REASON_CODE, "model_classified");
    assert.equal(
      validateOutcomeReason("dropped_sensitive", MODEL_CLASSIFIED_SENSITIVE_REASON_CODE),
      MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
    );

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId,
      sourceContentSha256: hash,
      agentId: null,
      outcome: "dropped_sensitive",
      reasonCode: "model_classified",
    }, fence);

    const [row] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(row.outcome, "dropped_sensitive");
    assert.equal(row.reason_code, "model_classified");

    // Never combinable with a family token into a CSV
    assert.throws(
      () => validateOutcomeReason("dropped_sensitive", "model_classified,apiKey"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
    assert.throws(
      () => validateOutcomeReason("dropped_sensitive", "apiKey,model_classified"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  });

  await t.test("tombstone reconciliation batches are lease-fenced and abort mid-batch on lease loss without further writes", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();

    for (const id of ids) {
      await commitSourceOutcome(sql, {
        upgradeId,
        sourceId: id,
        sourceContentSha256: "hash",
        agentId: null,
        outcome: "dropped_noise",
        reasonCode: "empty",
      }, fence);
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
        }, fence);
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
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
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
    }, fence);

    await commitSourceOutcome(sql, {
      upgradeId,
      sourceId: idDeleted,
      sourceContentSha256: "del-hash",
      agentId: null,
      outcome: "dropped_noise",
      reasonCode: "empty",
    }, fence);

    // Reconcile with isUuidId: false against text_id_memories
    const res = await reconcileTombstones(sql, upgradeId, {
      liveTableName: "text_id_memories",
      isUuidId: false,
    }, fence);

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
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);

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
        }, fence);
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
        }, fence);
      },
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "UNSUPPORTED_SOURCE_ID",
    );
  });

  await t.test("tombstone reconciliation is idempotent and sets reason_code to null", async () => {
    const upgradeId = randomUUID();
    const fence = await claimTenantFenceForTestSetup(sql, upgradeId);
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
    }, fence);

    const [rowBefore] = await sql`
      SELECT outcome, reason_code FROM paperclip_memory_upgrade_ledger
      WHERE upgrade_id = ${upgradeId}::uuid AND source_id = ${sourceId}::uuid;
    `;
    assert.equal(rowBefore.outcome, "dropped_noise");
    assert.equal(rowBefore.reason_code, "empty");

    // 2. Reconcile tombstone pass 1: transitions row and returns count 1
    const res1 = await reconcileTombstones(sql, upgradeId, {
      tombstoneSourceIds: [sourceId],
    }, fence);
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
    }, fence);
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

  await t.test("validateOutcomeReason runtime outcome allowlist validation and reason rules", async () => {
    // 1. Runtime reject unknown/invalid outcome before branching
    const invalidOutcomes = ["", " ", "   ", "\t\n", "bogus_outcome", "DROPPED_NOISE", "published ", null, undefined];
    for (const invalid of invalidOutcomes) {
      assert.throws(
        () => validateOutcomeReason(invalid as any, null),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
        `Outcome '${invalid}' must be rejected with INVALID_ARGUMENT`,
      );
    }

    // Symbol and unbounded raw value rejection without TypeError and with marker absent
    const marker = "sensitive_marker_symbol_or_text";
    const symbolOutcome = Symbol(marker);
    assert.throws(
      () => validateOutcomeReason(symbolOutcome as any, null),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError, "Must be CompanyMemoryUpgradeError, not TypeError");
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(!err.message.includes(marker), "Symbol marker must not be echoed in error message");
        assert.ok(!err.message.includes("Symbol"), "Symbol string must not be echoed in error message");
        assert.ok(err.message.includes("must be one of"), "Allowed enum must be mentioned in error message");
        return true;
      },
    );

    const stringMarkerOutcome = `invalid_outcome_with_${marker}`;
    assert.throws(
      () => validateOutcomeReason(stringMarkerOutcome as any, null),
      (err: any) => {
        assert.ok(err instanceof CompanyMemoryUpgradeError);
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(!err.message.includes(marker), "Raw value marker must not be echoed in error message");
        assert.ok(!err.message.includes(stringMarkerOutcome), "Raw outcome value must not be echoed in error message");
        assert.ok(err.message.includes("must be one of"), "Allowed enum must be mentioned in error message");
        return true;
      },
    );

    // 2. Literal-positive sets pinned for all 8 valid ledger outcomes
    const expectedOutcomes = [
      "published",
      "dropped_noise",
      "deduplicated",
      "dropped_sensitive",
      "unroutable",
      "quarantined",
      "superseded",
      "source_deleted",
    ];
    assert.deepEqual([...UPGRADE_LEDGER_OUTCOMES], expectedOutcomes);

    // Literal-positive: dropped_noise
    for (const r of VALID_NOISE_REASONS) {
      assert.equal(validateOutcomeReason("dropped_noise", r), r);
    }
    // Guard against drift: VALID_NOISE_REASONS must include the exact producer constant
    // llm-converter.ts emits for model-decided drop_noise outcomes (TECH-8191 Argus round 1
    // finding: model_classified_noise), mirroring the dropped_sensitive precedent below.
    assert.equal(MODEL_CLASSIFIED_NOISE_REASON_CODE, "model_classified_noise");
    assert.ok((VALID_NOISE_REASONS as readonly string[]).includes(MODEL_CLASSIFIED_NOISE_REASON_CODE));
    assert.equal(
      validateOutcomeReason("dropped_noise", MODEL_CLASSIFIED_NOISE_REASON_CODE),
      MODEL_CLASSIFIED_NOISE_REASON_CODE,
    );
    // Literal-positive: unroutable
    for (const r of VALID_UNROUTABLE_REASONS) {
      assert.equal(validateOutcomeReason("unroutable", r), r);
    }
    // Literal-positive: dropped_sensitive (individual and sorted multi-token)
    for (const family of KNOWN_SENSITIVE_FAMILY_NAMES) {
      assert.equal(validateOutcomeReason("dropped_sensitive", family), family);
    }
    const allSensitiveSorted = [...KNOWN_SENSITIVE_FAMILY_NAMES].sort().join(",");
    assert.equal(validateOutcomeReason("dropped_sensitive", allSensitiveSorted), allSensitiveSorted);
    const twoSensitiveSorted = [KNOWN_SENSITIVE_FAMILY_NAMES[0], KNOWN_SENSITIVE_FAMILY_NAMES[1]].sort().join(",");
    assert.equal(validateOutcomeReason("dropped_sensitive", twoSensitiveSorted), twoSensitiveSorted);
    // Literal-positive: model-classified exact literal (not a family token, not combinable)
    assert.equal(validateOutcomeReason("dropped_sensitive", "model_classified"), "model_classified");

    // Literal-positive: published, deduplicated, quarantined permit null or valid string reason
    for (const o of ["published", "deduplicated", "quarantined"] as const) {
      assert.equal(validateOutcomeReason(o, null), null);
      assert.equal(validateOutcomeReason(o, undefined), null);
      assert.equal(validateOutcomeReason(o, "valid_reason_code"), "valid_reason_code");
    }

    // Literal-positive: superseded and source_deleted only permit null/undefined
    for (const o of ["superseded", "source_deleted"] as const) {
      assert.equal(validateOutcomeReason(o, null), null);
      assert.equal(validateOutcomeReason(o, undefined), null);
    }

    // 3. Cross-outcome negative tests
    const crossNegatives: Array<[any, any]> = [
      ["dropped_noise", "no_routable_text"], // unroutable reason given to dropped_noise
      ["unroutable", "empty"], // noise reason given to unroutable
      ["dropped_noise", "apiKey"], // sensitive family given to dropped_noise
      ["dropped_sensitive", "exact_placeholder_or_greeting"], // noise reason given to dropped_sensitive
      ["superseded", "some_reason"], // superseded forbids reason
      ["source_deleted", "some_reason"], // source_deleted forbids reason
    ];
    for (const [outcome, reason] of crossNegatives) {
      assert.throws(
        () => validateOutcomeReason(outcome, reason),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    }

    // 4. Empty, whitespace, unsorted, duplicate, and unknown reasonCode negatives
    const reasonNegatives: Array<[any, any]> = [
      ["unroutable", ""],
      ["unroutable", "  "],
      ["unroutable", "bogus_unroutable"],
      ["dropped_noise", ""],
      ["dropped_noise", " "],
      ["dropped_noise", "bogus_noise"],
      ["dropped_sensitive", ""],
      ["dropped_sensitive", "   "],
      ["dropped_sensitive", "unknown_family"],
      ["dropped_sensitive", "apiKey,apiKey"], // duplicate
      ["dropped_sensitive", "ssn,apiKey"], // unsorted
      ["dropped_sensitive", "model_classified,apiKey"], // model literal cannot combine into CSV
      ["published", ""], // empty reason string
      ["published", "   "], // whitespace reason string
      ["published", 12345], // non-string reason
    ];
    for (const [outcome, reason] of reasonNegatives) {
      assert.throws(
        () => validateOutcomeReason(outcome, reason),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    }
  });
});
