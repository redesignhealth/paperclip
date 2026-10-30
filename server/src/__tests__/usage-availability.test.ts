import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { normalizeCents } from "@paperclipai/shared";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { usageAvailabilityReport } from "../services/usage-availability.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const at = new Date("2026-10-20T12:00:00Z");
const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };

// Synthetic metadata only: no prompts, transcripts or provider payload bodies.
describe("usage availability reporting projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-usage-availability-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Usage", issuePrefix: `U${companyId.slice(0, 6)}` });
    const agent = async (adapterType: string) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name: adapterType, role: "engineer", adapterType });
      return id;
    };
    return { companyId, hermes: await agent("hermes_local"), claude: await agent("claude_local"), codex: await agent("codex_local") };
  }
  type Owner = Awaited<ReturnType<typeof company>>;

  /** One heartbeat run plus, unless `receipt` is false, its settled ledger event. */
  async function receipted(owner: Owner, agentId: string, input: {
    run?: Partial<typeof heartbeatRuns.$inferInsert>; event?: Partial<typeof costEvents.$inferInsert> | false;
  } = {}) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: owner.companyId, agentId, status: "succeeded", createdAt: at, finishedAt: at,
      costAccountingPending: false, costAccountedAt: at, usageJson: {}, ...input.run }).returning();
    if (input.event === false) return { run };
    const [event] = await db.insert(costEvents).values({ companyId: owner.companyId, agentId, heartbeatRunId: run.id,
      idempotencyKey: `heartbeat:${run.id}:final`, receiptHash: "synthetic", provider: "anthropic", model: "synthetic-model",
      billingType: "metered_api", costStatus: "reported", costCents: 0, occurredAt: at, pricingProvenance: { source: "unknown" }, ...input.event }).returning();
    return { run, event };
  }
  const tokens = { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 };

  it("splits reported and estimated usage, flags unavailable usage, and reconciles to the ledger exactly", async () => {
    const owner = await company();
    // reported: 50 + 29.8111 (one from a failed run)
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 50, providerRequestId: "req_1", pricingProvenance: { source: "provider_reported" } } });
    await receipted(owner, owner.claude, { run: { status: "failed" }, event: { ...tokens, costCents: 29.8111, pricingProvenance: { source: "provider_reported" } } });
    // estimated: 3 + 2.39359, the second is a retry of a failed attempt
    const first = await receipted(owner, owner.codex, { run: { status: "failed" }, event: { ...tokens, provider: "openai", costStatus: "estimated", costCents: 3, pricingProvenance: { source: "rate_card", version: "v1" } } });
    await receipted(owner, owner.codex, { run: { retryOfRunId: first.run.id }, event: { ...tokens, provider: "openai", costStatus: "estimated", costCents: 2.39359, pricingProvenance: { source: "rate_card", version: "v1" } } });
    // unavailable: receipt present, 0/0, no request id, no usage payload
    for (let n = 0; n < 3; n++) await receipted(owner, owner.hermes, { event: { provider: "unknown", model: "unknown", costStatus: "unpriced" } });
    // measured zero: explicit evidence (request id, per-model payload)
    await receipted(owner, owner.claude, { event: { providerRequestId: "req_zero", costStatus: "reported" } });
    await receipted(owner, owner.claude, { run: { usageJson: { usageByModel: [{ model: "synthetic-model", costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } }] } }, event: {} });
    // subscription tokens are usage, kept distinct from metered; unknown billing 0/0 is unavailable
    await receipted(owner, owner.codex, { event: { ...tokens, provider: "openai", billingType: "subscription_included", costStatus: "unpriced" } });
    await receipted(owner, owner.codex, { event: { provider: "openai", billingType: "unknown", costStatus: "unpriced" } });

    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.availability.reported.costCentsExact).toBe(normalizeCents("79.8111"));
    expect(report.availability.estimated.costCentsExact).toBe(normalizeCents("5.39359"));
    expect(report.availability.unavailable.costCentsExact).toBe(normalizeCents("0"));
    expect(report.ledgerCostCentsExact).toBe(normalizeCents("85.20469"));
    expect(report.reconciled).toBe(true);
    const summary = await costService(db).summary(owner.companyId, range);
    expect(report.ledgerCostCentsExact).toBe(summary.spendCentsExact);
    expect(report.total.eventCount).toBe(summary.eventCount);

    expect(report.availability.reported.eventCount).toBe(3); // two priced + subscription tokens
    expect(report.availability.estimated.eventCount).toBe(2);
    expect(report.availability.unavailable.eventCount).toBe(4);
    expect(report.availability.measured_zero.eventCount).toBe(2);
    expect(report.pricingProvenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "rate_card", eventCount: 2, costCentsExact: normalizeCents("5.39359") }),
    ]));

    const byAdapter = Object.fromEntries(report.byAdapter.map(row => [row.adapterType, row]));
    expect(byAdapter.hermes_local.coverageRate).toBe(0);
    expect(byAdapter.hermes_local.availability.unavailable.eventCount).toBe(3);
    expect(byAdapter.claude_local.coverageRate).toBe(0.5); // 2 usage-bearing of 4; measured zero is not coverage
    expect(byAdapter.codex_local.billingKindEventCounts).toEqual({ metered: 2, subscription: 1, unknown: 1 });
    expect(byAdapter.codex_local.coverageRate).toBe(0.75);
  });

  it("counts cache tokens once: input includes cache writes, excludes cache reads", async () => {
    const owner = await company();
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1 } });
    // A pre-receipt Codex row stored cache reads inside input; the projection uses the same normalization as by-agent.
    await receipted(owner, owner.codex, { event: { ...tokens, provider: "openai", model: "gpt-synthetic", receiptHash: null, costCents: 1 } });
    const { total } = await usageAvailabilityReport(db, owner.companyId, range);
    expect(total.inputTokens).toBe(1000 + 600);
    expect(total.cachedInputTokens).toBe(800);
    expect(total.outputTokens).toBe(200);
    expect(total.totalTokens).toBe(total.inputTokens + total.cachedInputTokens + total.outputTokens);
    expect(total.totalTokens).toBe(1500 + 1100);
  });

  it("reports runs without a receipt separately and excludes them from coverage", async () => {
    const owner = await company();
    const v2 = { accountingProjectionVersion: "v2" };
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1 } });
    // Owed: v2 run that is terminal with nothing recorded.
    await receipted(owner, owner.hermes, { event: false, run: v2 });
    // Owed and late-settling: receipt has not been accounted yet, so it has no event now.
    await receipted(owner, owner.hermes, { event: false, run: { ...v2, costAccountingPending: true, costAccountedAt: null } });
    await receipted(owner, owner.codex, { event: false, run: { ...v2, status: "running", finishedAt: null } }); // active runs are not missing a receipt
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.total.eventCount).toBe(1);
    expect(report.coverageRate).toBe(1);
    expect(report.runsWithoutReceipt).toEqual({ total: 2, pendingAccounting: 1, byAdapter: [{ adapterType: "hermes_local", count: 2 }] });
    expect(report.runsNotOwedReceipt.total).toBe(0);
  });

  it("does not count runs that owe no receipt as missing receipts", async () => {
    const owner = await company();
    const v2 = { accountingProjectionVersion: "v2" };
    // Legacy: finished before receipts existed (no pending flag, no v2 projection).
    await receipted(owner, owner.hermes, { event: false });
    await receipted(owner, owner.hermes, { event: false });
    // Failed before any provider work, by either marker.
    await receipted(owner, owner.claude, { event: false, run: { ...v2, status: "failed", resultJson: { executionRecovery: { providerWorkStarted: false } } } });
    await receipted(owner, owner.codex, { event: false, run: { ...v2, status: "failed", usageJson: { accountingProviderWorkStarted: false } } });
    // Genuine debt: v2, provider work started (marker true), still no receipt.
    await receipted(owner, owner.claude, { event: false, run: { ...v2, resultJson: { executionRecovery: { providerWorkStarted: true } } } });
    // Another company's missing receipts never leak in.
    const other = await company();
    await receipted(other, other.hermes, { event: false, run: v2 });
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.runsWithoutReceipt).toEqual({ total: 1, pendingAccounting: 0, byAdapter: [{ adapterType: "claude_local", count: 1 }] });
    expect(report.runsNotOwedReceipt).toEqual({ total: 4, byAdapter: [
      { adapterType: "claude_local", count: 1 }, { adapterType: "codex_local", count: 1 }, { adapterType: "hermes_local", count: 2 }] });
    // Date range still applies to both cohorts.
    const empty = await usageAvailabilityReport(db, owner.companyId, { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z") });
    expect(empty.runsWithoutReceipt.total + empty.runsNotOwedReceipt.total).toBe(0);
  });

  it("classifies a late-settled receipt like any other once its event exists", async () => {
    const owner = await company();
    const late = new Date(at.getTime() + 20 * 60_000);
    await receipted(owner, owner.claude, { run: { costAccountedAt: late }, event: { ...tokens, costCents: 4, occurredAt: at } });
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.availability.reported.eventCount).toBe(1);
    expect(report.runsWithoutReceipt.total).toBe(0);
  });

  it("ignores manual, non-run ledger events and other companies, and never writes", async () => {
    const owner = await company(); const other = await company();
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 2 } });
    await receipted(other, other.claude, { event: { ...tokens, costCents: 9 } });
    await db.insert(costEvents).values({ companyId: owner.companyId, agentId: owner.claude, provider: "anthropic", model: "m", costCents: 7, occurredAt: at });
    const before = await db.execute(sql`select count(*)::int as n, md5(coalesce(string_agg(e::text, '|' order by e.id), '')) as digest, (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from heartbeat_runs r where r.company_id = ${owner.companyId}) as runs from cost_events e where e.company_id = ${owner.companyId}`);
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.ledgerCostCentsExact).toBe(normalizeCents("2"));
    expect(report.total.eventCount).toBe(1);
    const after = await db.execute(sql`select count(*)::int as n, md5(coalesce(string_agg(e::text, '|' order by e.id), '')) as digest, (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from heartbeat_runs r where r.company_id = ${owner.companyId}) as runs from cost_events e where e.company_id = ${owner.companyId}`);
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it("covers invoice provenance, subscription overage, non-succeeded terminal runs and date boundaries", async () => {
    const owner = await company();
    // provider_invoice with 0 tokens is measured evidence; subscription_overage is subscription billing kind.
    await receipted(owner, owner.claude, { event: { costStatus: "reported", pricingProvenance: { source: "provider_invoice" } } });
    await receipted(owner, owner.codex, { event: { ...tokens, provider: "openai", billingType: "subscription_overage", costStatus: "reported", costCents: 1 } });
    // No evidence at all on non-succeeded terminal runs: unavailable, and each status still has a receipt.
    for (const status of ["failed", "timed_out", "cancelled", "interrupted"]) {
      await receipted(owner, owner.hermes, { run: { status }, event: { provider: "unknown", model: "unknown", costStatus: "unpriced" } });
    }
    // Inclusive date bounds: events exactly on from/to count, one millisecond outside does not.
    const edge = (offset: number) => new Date(range.from.getTime() + offset);
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1, occurredAt: range.from } });
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1, occurredAt: range.to } });
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1, occurredAt: edge(-1) } });
    await receipted(owner, owner.claude, { event: { ...tokens, costCents: 1, occurredAt: new Date(range.to.getTime() + 1) } });
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.availability.measured_zero.eventCount).toBe(1);
    expect(report.availability.unavailable.eventCount).toBe(4);
    expect(report.availability.reported.eventCount).toBe(3); // overage + two boundary events
    expect(report.pricingProvenance).toEqual(expect.arrayContaining([expect.objectContaining({ source: "provider_invoice", eventCount: 1 })]));
    expect(report.byAdapter.find(row => row.adapterType === "codex_local")?.billingKindEventCounts.subscription).toBe(1);
    expect(report.total.eventCount).toBe(8);
    expect(report.reconciled).toBe(true);
  });

  it("classifies zero-token provider_reported and zero-token estimated receipts by evidence, not by cost status", async () => {
    const owner = await company();
    // provider_reported provenance with 0 tokens counts as evidence (documented overstate risk).
    await receipted(owner, owner.claude, { event: { costStatus: "reported", costCents: 2, pricingProvenance: { source: "provider_reported" } } });
    // estimated with 0 tokens and no evidence is unavailable, not estimated.
    await receipted(owner, owner.codex, { event: { provider: "openai", costStatus: "estimated", pricingProvenance: { source: "rate_card", version: "v1" } } });
    // estimated with 0 tokens but a provider request id is a measured zero.
    await receipted(owner, owner.codex, { event: { provider: "openai", costStatus: "estimated", providerRequestId: "req_est", pricingProvenance: { source: "rate_card", version: "v1" } } });
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.availability.measured_zero.eventCount).toBe(2);
    expect(report.availability.unavailable.eventCount).toBe(1);
    expect(report.availability.estimated.eventCount).toBe(0);
    expect(report.availability.reported.eventCount).toBe(0);
    expect(report.reconciled).toBe(true);
  });

  it("does not let a malformed usageByModel value break classification", async () => {
    const owner = await company();
    await receipted(owner, owner.claude, { run: { usageJson: { usageByModel: "not-an-array" } }, event: {} });
    await receipted(owner, owner.claude, { run: { usageJson: { usageByModel: [] } }, event: {} });
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.availability.unavailable.eventCount).toBe(2);
  });

  it("returns null coverage rather than zero when nothing is receipt-backed", async () => {
    const owner = await company();
    const report = await usageAvailabilityReport(db, owner.companyId, range);
    expect(report.coverageRate).toBeNull();
    expect(report.byAdapter).toEqual([]);
    expect(report.reconciled).toBe(true);
  });
});
