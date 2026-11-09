/**
 * Pure bigint nanodollar cost accounting tests (TECH-8191 finding COST).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  buildCostRatesNanodollars,
  ceilTokenCostNanodollars,
  createCostTracker,
  estimateWorstCaseSourceCostNanodollarsForText,
  MAX_USD_CAP,
  PREFLIGHT_MAX_EMBEDDING_CALLS,
  priceUsdPerMillionToNanodollars,
  usdToNanodollars,
  UTF8_MAX_BYTES_PER_CHAR,
  utf8ByteLength,
} from "../../server/src/services/company-memory-upgrade/cost.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
import {
  agents,
  companies,
  companyMemoryDatabases,
  companyMemoryUpgrades,
  createDb,
  eq,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertTenantMemoryRow,
  ManualClock,
  setupTenantMem0Table,
  sql,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";
import { runSweep } from "../../server/src/services/company-memory-upgrade/sweep.js";
import { openTenantClient } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";

test("usdToNanodollars validates and converts USD amounts", () => {
  assert.equal(usdToNanodollars(0), 0n);
  assert.equal(usdToNanodollars(1), 1_000_000_000n);
  assert.equal(usdToNanodollars(0.15), 150_000_000n);
  assert.equal(usdToNanodollars(MAX_USD_CAP), BigInt(MAX_USD_CAP) * 1_000_000_000n);

  for (const bad of [-1, Infinity, -Infinity, NaN, MAX_USD_CAP + 1]) {
    assert.throws(
      () => usdToNanodollars(bad, "testField"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  }

  // Non-numbers must also be rejected without throwing an unrelated TypeError.
  for (const bad of ["1", null, undefined, {}] as any[]) {
    assert.throws(
      () => usdToNanodollars(bad, "testField"),
      (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
    );
  }
});

test("priceUsdPerMillionToNanodollars enforces the same cap as usdToNanodollars", () => {
  assert.equal(priceUsdPerMillionToNanodollars(0.15, "chatInputUsdPerMillion"), 150_000_000n);
  assert.throws(
    () => priceUsdPerMillionToNanodollars(MAX_USD_CAP + 1, "chatInputUsdPerMillion"),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});

test("ceilTokenCostNanodollars: $0.15/M tokens is 150 nanodollars per token (NOT 1)", () => {
  // This is the canonical example cited by the finding: a naive "per-million-then-truncate"
  // calculation yields 1 nanodollar for a single token at $0.15/M tokens, which is wrong.
  // 1 token * 150_000_000 nanodollars-per-million / 1_000_000 = 150 nanodollars exactly.
  const ratePerMillion = priceUsdPerMillionToNanodollars(0.15, "chatInputUsdPerMillion");
  assert.equal(ratePerMillion, 150_000_000n);
  assert.equal(ceilTokenCostNanodollars(1, ratePerMillion), 150n);
  assert.equal(ceilTokenCostNanodollars(1_000_000, ratePerMillion), 150_000_000n);
  assert.equal(ceilTokenCostNanodollars(0, ratePerMillion), 0n);
});

test("ceilTokenCostNanodollars rounds UP (ceiling), never truncates a fractional nanodollar away", () => {
  // Use a sub-nanodollar-per-token rate so the division produces a genuine remainder:
  // rate = 1 nanodollar per million tokens -> 1 token costs 1/1_000_000 nanodollars, which
  // must ceiling-round UP to 1, never truncate down to 0.
  const subNanodollarRate = 1n; // 1 nanodollar per million tokens
  assert.equal(ceilTokenCostNanodollars(1, subNanodollarRate), 1n, "must round up, not truncate to 0");
  assert.equal(ceilTokenCostNanodollars(999_999, subNanodollarRate), 1n);
  assert.equal(ceilTokenCostNanodollars(1_000_000, subNanodollarRate), 1n, "exact division has no remainder to round up");
  assert.equal(ceilTokenCostNanodollars(1_000_001, subNanodollarRate), 2n);

  assert.throws(
    () => ceilTokenCostNanodollars(-1, 1n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
  );
});

test("utf8ByteLength is a conservative (>=) token-count proxy for multi-byte Unicode text", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength(null), 0);
  assert.equal(utf8ByteLength("abcd"), 4); // ASCII: 1 byte/char
  // A fixed "charactersPerToken: 4 ASCII heuristic" (as used for the provisional census
  // estimator) would badly UNDERCOUNT this CJK string -- each of these characters is 3
  // bytes in UTF-8, nowhere near "4 chars per token".
  const cjk = "田中太郎様";
  assert.equal(utf8ByteLength(cjk), cjk.length * 3);
  assert.ok(utf8ByteLength(cjk) > cjk.length, "multi-byte text must project MORE bytes than characters");
});

test("estimateWorstCaseSourceCostNanodollarsForText: embedding projection is conservative for 400-char Unicode, not a 100-token ASCII heuristic", () => {
  const rates = buildCostRatesNanodollars({
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.6,
    embeddingUsdPerMillion: 0.02,
  });

  const shortAscii = "short memory";
  const estimate = estimateWorstCaseSourceCostNanodollarsForText(shortAscii, "gpt-5.4-mini", rates);

  // The OLD flawed heuristic: 400 chars / 4 chars-per-token = 100 tokens per record. The
  // worst-case embedding projection here must be far larger: 400 chars * 4 bytes/char
  // (UTF8_MAX_BYTES_PER_CHAR, a conservative Unicode ceiling) per record, times up to
  // PREFLIGHT_MAX_EMBEDDING_CALLS records.
  const flawedAsciiHeuristicTokens = 100 * PREFLIGHT_MAX_EMBEDDING_CALLS;
  assert.ok(
    estimate.projectedEmbeddingTokens > flawedAsciiHeuristicTokens,
    `projected embedding tokens (${estimate.projectedEmbeddingTokens}) must exceed the flawed 100-token ASCII heuristic (${flawedAsciiHeuristicTokens})`,
  );
  assert.equal(estimate.projectedEmbeddingTokens, 400 * UTF8_MAX_BYTES_PER_CHAR * PREFLIGHT_MAX_EMBEDDING_CALLS);

  // Preflight must be computed BEFORE any key resolution or paid call; it is purely a
  // function of (sourceText, model, rates) -- call it twice and confirm determinism.
  const estimate2 = estimateWorstCaseSourceCostNanodollarsForText(shortAscii, "gpt-5.4-mini", rates);
  assert.deepEqual(estimate, estimate2);
  assert.ok(estimate.worstCaseNanodollars > 0n);
});

test("estimateWorstCaseSourceCostNanodollarsForText includes real serialized chat request overhead (prompt/wrapper/repair), not a guessed constant", () => {
  const rates = buildCostRatesNanodollars({
    chatInputUsdPerMillion: 0.15,
    chatOutputUsdPerMillion: 0.6,
    embeddingUsdPerMillion: 0.02,
  });

  const empty = estimateWorstCaseSourceCostNanodollarsForText("", "gpt-5.4-mini", rates);
  const longer = estimateWorstCaseSourceCostNanodollarsForText("x".repeat(2000), "gpt-5.4-mini", rates);

  // Even with EMPTY source text, the projected input tokens must reflect the real system
  // prompt + schema + wrapper tags + repair-turn overhead (not zero).
  assert.ok(empty.projectedChatInputTokens > 0);
  // Longer source text must increase the projection (wrapper overhead is additive, not
  // replacing the source text).
  assert.ok(longer.projectedChatInputTokens > empty.projectedChatInputTokens);
});

test("createCostTracker: budget cap blocks before any spend is recorded (preflight ceiling)", () => {
  const tracker = createCostTracker(0.000000001); // 1 nanodollar cap
  assert.throws(
    () => tracker.assertBudgetAllows(1_000_000n),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR",
  );
  // Nothing was ever recorded as spent.
  assert.equal(tracker.spentNanodollars, 0n);
  assert.equal(tracker.pageCostNanodollars, 0n);
});

test("createCostTracker: unbounded tracker (null maxCostUsd) never blocks", () => {
  const tracker = createCostTracker(null);
  tracker.assertBudgetAllows(1_000_000_000_000n);
  tracker.addActualCostNanodollars(500n);
  assert.equal(tracker.spentNanodollars, 500n);
});

test("createCostTracker: page delta is reset ONLY via resetPageDelta, and is independent of cumulative spend", () => {
  const tracker = createCostTracker(null);
  tracker.addActualCostNanodollars(100n);
  assert.equal(tracker.pageCostNanodollars, 100n);
  assert.equal(tracker.spentNanodollars, 100n);

  // Simulate a successful flush: read the delta, THEN reset.
  const flushed = tracker.pageCostNanodollars;
  assert.equal(flushed, 100n);
  tracker.resetPageDelta();
  assert.equal(tracker.pageCostNanodollars, 0n);
  // Cumulative total is untouched by resetting the page delta.
  assert.equal(tracker.spentNanodollars, 100n);

  // Second page's spend must be its OWN delta, never the cumulative total re-flushed.
  tracker.addActualCostNanodollars(40n);
  assert.equal(tracker.pageCostNanodollars, 40n, "page 2 delta must be 40, not 140 (cumulative)");
  assert.equal(tracker.spentNanodollars, 140n);
});

test("multi-page sweep: exact nontriangular per-page cost accounting (end-to-end)", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-cost-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  const tenantFixture = await startEmbeddedPostgresTestDatabase("sweep-cost-tenant-");
  const tenantSql = openTenantClient(tenantFixture.connectionString);

  await tenantSql.unsafe(`CREATE ROLE cost_tenant WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await tenantSql.unsafe(`GRANT ALL ON SCHEMA public TO cost_tenant;`);
  await tenantSql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cost_tenant;`);
  await tenantSql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cost_tenant;`);

  await cpDb.execute(sql`CREATE ROLE cost_cp WITH LOGIN PASSWORD 'pass123' NOSUPERUSER NOBYPASSRLS;`);
  await cpDb.execute(sql`GRANT ALL ON SCHEMA public TO cost_cp;`);
  await cpDb.execute(sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO cost_cp;`);
  await cpDb.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cost_cp;`);

  const tenantWorkerUrl = new URL(tenantFixture.connectionString);
  tenantWorkerUrl.username = "cost_tenant";
  tenantWorkerUrl.password = "pass123";

  const cpWorkerUrl = new URL(cpFixture.connectionString);
  cpWorkerUrl.username = "cost_cp";
  cpWorkerUrl.password = "pass123";

  const tenantWorkerSql = openTenantClient(tenantWorkerUrl.toString());
  const cpWorkerDb = createDb(cpWorkerUrl.toString());

  t.after(async () => {
    await tenantWorkerSql.end();
    await cpWorkerDb.$client?.end();
    await tenantSql.end();
    await cpDb.$client?.end();
    await tenantFixture.cleanup();
    await cpFixture.cleanup();
  });

  const [company] = await cpDb.insert(companies).values({
    name: "Cost Accounting Co",
    issuePrefix: "CA",
  }).returning();

  const [tenantInfo] = await tenantWorkerSql`
    SELECT current_database()::text AS db, current_user::text AS usr;
  `;

  await cpDb.insert(companyMemoryDatabases).values({
    companyId: company.id,
    databaseName: tenantInfo.db,
    databaseRole: tenantInfo.usr,
    host: "localhost",
    port: 5432,
    status: "ready",
  });

  const [agent] = await cpDb.insert(agents).values({
    companyId: company.id,
    name: "Cost Agent",
    adapterType: "hermes_local",
    status: "active",
  }).returning();

  await setupTenantMem0Table(tenantSql, "mem0_memories");

  // 3 sources, pageSize=1 -> 3 separate pages, each independently flushed.
  for (let i = 0; i < 3; i++) {
    await insertTenantMemoryRow(tenantSql, {
      agentId: agent.id,
      data: `Substantive durable fact number ${i} for cost accounting.`,
    });
  }

  // Fixed per-source token counts (deterministic regardless of input text) and round
  // USD/M prices (1 USD/M tokens => 1000 nanodollars/token exactly, no fractional ceiling
  // remainder) so the expected total is exact and trivially checkable.
  const FIXED_INPUT_TOKENS = 100;
  const FIXED_OUTPUT_TOKENS = 50;
  const FIXED_EMBEDDING_TOKENS = 10;
  const conversionClient = {
    async convert(text: string) {
      return {
        status: "convert" as const,
        records: [
          {
            data: `Converted: ${text}`.slice(0, 100),
            type: "fact" as const,
            subject: "cost accounting subject",
            confidence: 0.9,
          },
        ],
        inputTokens: FIXED_INPUT_TOKENS,
        outputTokens: FIXED_OUTPUT_TOKENS,
      };
    },
  };
  const embeddingClient = {
    async embed() {
      return { embedding: new Array(1536).fill(0.01), tokens: FIXED_EMBEDDING_TOKENS };
    },
  };

  const expectedPerSourceNano =
    FIXED_INPUT_TOKENS * 1000 + FIXED_OUTPUT_TOKENS * 1000 + FIXED_EMBEDDING_TOKENS * 1000;
  const expectedTotalNano = BigInt(expectedPerSourceNano * 3);

  const clock = new ManualClock();
  const report = await runSweep(
    {
      databaseUrl: tenantWorkerUrl.toString(),
      controlPlaneUrl: cpWorkerUrl.toString(),
      companyId: company.id,
      pageSize: 1,
      pauseWhenActiveRuns: 0,
      chatInputUsdPerMillion: 1,
      chatOutputUsdPerMillion: 1,
      embeddingUsdPerMillion: 1,
    },
    {
      controlPlaneDb: cpWorkerDb,
      tenantSql: tenantWorkerSql,
      clock,
      _internalSkipVectorIdentityCheck: true,
      conversionClient,
      embeddingClient,
    },
  );

  assert.equal(report.counts.estimatedCostNanodollars, Number(expectedTotalNano));

  const [upgrade] = await cpDb
    .select()
    .from(companyMemoryUpgrades)
    .where(eq(companyMemoryUpgrades.companyId, company.id));

  // THE regression this test exists to catch: if the control-plane flush ever wrote the
  // CUMULATIVE total as a per-page "delta" (double-counting already-flushed pages), this
  // stored total would be MUCH larger than expectedTotalNano (triangular growth across 3
  // pages: 1x + 2x + 3x = 6x instead of 3x). It must be EXACTLY the sum of 3 equal deltas.
  assert.equal(BigInt(upgrade.estimatedCostNanodollars), expectedTotalNano);
  assert.equal(upgrade.publishedCount, 0, "COUNTER finding: publishedCount must stay zero");
});
