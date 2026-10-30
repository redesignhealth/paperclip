import { and, eq, gte, lte, sql } from "drizzle-orm";
import { agents, costEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { addCents, normalizeCents } from "@paperclipai/shared";
import type {
  UsageAvailability, UsageAvailabilityByAdapter, UsageAvailabilityReport, UsageAvailabilityTotals, UsageBillingKind,
} from "@paperclipai/shared";
import { withAccountingReadSnapshot } from "./accounting-transaction.js";
import { resolveCostDateRange, type CostDateRange } from "./cost-date-range.js";
import { ordinaryInputTokens } from "./costs.js";

const AVAILABILITIES: readonly UsageAvailability[] = ["reported", "estimated", "unavailable", "measured_zero"];
const BILLING_KINDS: readonly UsageBillingKind[] = ["metered", "subscription", "unknown"];
const TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"];

export const TOKEN_SEMANTICS = "inputTokens includes cache-write tokens and excludes cache-read tokens; cachedInputTokens is cache reads only; "
  + "totalTokens = inputTokens + cachedInputTokens + outputTokens, so no token is counted twice. Cache writes are not stored separately in the ledger.";

const ZERO_CENTS = normalizeCents("0");
const emptyTotals = (): UsageAvailabilityTotals => ({
  eventCount: 0, unpricedEventCount: 0, costCentsExact: ZERO_CENTS, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
});
const emptyByAvailability = () => Object.fromEntries(AVAILABILITIES.map(key => [key, emptyTotals()])) as Record<UsageAvailability, UsageAvailabilityTotals>;
const rate = (covered: number, all: number) => all === 0 ? null : covered / all;

function addInto(target: UsageAvailabilityTotals, row: UsageAvailabilityTotals) {
  target.eventCount += row.eventCount; target.unpricedEventCount += row.unpricedEventCount;
  target.costCentsExact = addCents(target.costCentsExact, row.costCentsExact);
  target.inputTokens += row.inputTokens; target.cachedInputTokens += row.cachedInputTokens;
  target.outputTokens += row.outputTokens; target.totalTokens += row.totalTokens;
}

/** Zero tokens only count as measured when the receipt carries independent
 * usage evidence: a provider request id, a per-model usage payload, or a cost the
 * provider itself reported. Anything else is unavailable, never an invented zero. */
const tokenTotal = sql`(${ordinaryInputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens})`;
const hasUsageEvidence = sql`(${costEvents.providerRequestId} is not null
  or (case when jsonb_typeof(${heartbeatRuns.usageJson}->'usageByModel') = 'array'
       then jsonb_array_length(${heartbeatRuns.usageJson}->'usageByModel') > 0 else false end)
  or ${costEvents.pricingProvenance}->>'source' in ('provider_reported', 'provider_invoice'))`;
const availabilityExpr = sql<UsageAvailability>`case
  when ${tokenTotal} > 0 then (case when ${costEvents.costStatus} = 'estimated' then 'estimated' else 'reported' end)
  when ${hasUsageEvidence} then 'measured_zero' else 'unavailable' end`;
const billingKindExpr = sql<UsageBillingKind>`case
  when ${costEvents.billingType} = 'metered_api' then 'metered'
  when ${costEvents.billingType} in ('subscription_included', 'subscription_overage') then 'subscription'
  else 'unknown' end`;
const adapterExpr = sql<string>`coalesce(${agents.adapterType}, 'unknown')`;
const provenanceExpr = sql<string>`coalesce(${costEvents.pricingProvenance}->>'source', 'unknown')`;

/** Reporting-only projection over the immutable ledger. It reads receipt-backed
 * agent events (heartbeat run receipts) and never writes or reprices anything. */
export async function usageAvailabilityReport(db: Db, companyId: string, range?: CostDateRange): Promise<UsageAvailabilityReport> {
  return withAccountingReadSnapshot(db, companyId, async tx => {
    const period = resolveCostDateRange(range);
    const eventConditions = [
      eq(costEvents.companyId, companyId), eq(costEvents.usageKind, "agent"),
      sql`${costEvents.idempotencyKey} like 'heartbeat:%'`,
    ];
    if (period.from) eventConditions.push(gte(costEvents.occurredAt, period.from));
    if (period.to) eventConditions.push(lte(costEvents.occurredAt, period.to));

    const rows = await tx.select({
      adapterType: adapterExpr, availability: availabilityExpr, billingKind: billingKindExpr, source: provenanceExpr,
      eventCount: sql<number>`count(*)::int`,
      unpricedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`,
      costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
      inputTokens: sql<number>`coalesce(sum(${ordinaryInputTokens}), 0)::double precision`,
      cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
    }).from(costEvents)
      .leftJoin(agents, and(eq(agents.id, costEvents.agentId), eq(agents.companyId, costEvents.companyId)))
      .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, costEvents.heartbeatRunId), eq(heartbeatRuns.companyId, costEvents.companyId)))
      .where(and(...eventConditions))
      .groupBy(adapterExpr, availabilityExpr, billingKindExpr, provenanceExpr);

    const [ledger] = await tx.select({
      costCentsExact: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
      runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
    }).from(costEvents).where(and(...eventConditions));

    const availability = emptyByAvailability();
    const total = emptyTotals();
    const adapters = new Map<string, UsageAvailabilityByAdapter>();
    const provenance = new Map<string, { source: string; eventCount: number; costCentsExact: string }>();
    for (const row of rows) {
      const part: UsageAvailabilityTotals = {
        eventCount: row.eventCount, unpricedEventCount: row.unpricedEventCount, costCentsExact: normalizeCents(row.costCentsExact),
        inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens,
        totalTokens: row.inputTokens + row.cachedInputTokens + row.outputTokens,
      };
      let adapter = adapters.get(row.adapterType);
      if (!adapter) {
        adapter = { adapterType: row.adapterType, eventCount: 0, coverageRate: null, availability: emptyByAvailability(),
          billingKindEventCounts: Object.fromEntries(BILLING_KINDS.map(key => [key, 0])) as Record<UsageBillingKind, number> };
        adapters.set(row.adapterType, adapter);
      }
      addInto(total, part); addInto(availability[row.availability], part); addInto(adapter.availability[row.availability], part);
      adapter.eventCount += part.eventCount; adapter.billingKindEventCounts[row.billingKind] += part.eventCount;
      const source = provenance.get(row.source) ?? { source: row.source, eventCount: 0, costCentsExact: ZERO_CENTS };
      source.eventCount += part.eventCount; source.costCentsExact = addCents(source.costCentsExact, part.costCentsExact);
      provenance.set(row.source, source);
    }
    const covered = (set: Record<UsageAvailability, UsageAvailabilityTotals>) => set.reported.eventCount + set.estimated.eventCount;
    const byAdapter = [...adapters.values()].sort((a, b) => a.adapterType.localeCompare(b.adapterType));
    for (const adapter of byAdapter) adapter.coverageRate = rate(covered(adapter.availability), adapter.eventCount);

    const runFrom = period.from ? sql`and coalesce(r.finished_at, r.created_at) >= ${period.from.toISOString()}::timestamptz` : sql``;
    const runTo = period.to ? sql`and coalesce(r.finished_at, r.created_at) <= ${period.to.toISOString()}::timestamptz` : sql``;
    // A run owes a receipt only under the predicate the accounting integrity check uses:
    // pending or v2-projected, and provider work was not ruled out. Everything else without
    // an event (older runs from before receipts existed, runs that failed before the
    // provider was called) owes none and is counted apart so it cannot read as data loss.
    const owesReceipt = sql`((r.cost_accounting_pending or r.accounting_projection_version = 'v2')
      and r.result_json->'executionRecovery'->>'providerWorkStarted' is distinct from 'false'
      and r.usage_json->>'accountingProviderWorkStarted' is distinct from 'false')`;
    const missing = await tx.execute<{ adapterType: string; owed: boolean; count: number; pending: number }>(sql`
      select coalesce(a.adapter_type, 'unknown') as "adapterType", ${owesReceipt} as owed, count(*)::int as count,
        count(*) filter (where r.cost_accounting_pending)::int as pending
      from heartbeat_runs r left join agents a on a.id = r.agent_id and a.company_id = r.company_id
      where r.company_id = ${companyId} and r.status in (${sql.join(TERMINAL_STATUSES.map(value => sql`${value}`), sql`, `)}) ${runFrom} ${runTo}
        and not exists (select 1 from cost_events e where e.company_id = r.company_id and e.heartbeat_run_id = r.id
          and e.usage_kind = 'agent' and e.idempotency_key like 'heartbeat:%')
      group by 1, 2 order by 1, 2`);
    const missingRows = Array.from(missing);
    const owedRows = missingRows.filter(row => row.owed);
    const notOwedRows = missingRows.filter(row => !row.owed);
    const byAdapterCount = (rows: typeof missingRows) => rows.map(row => ({ adapterType: row.adapterType, count: Number(row.count) }));

    return {
      companyId, total, receiptRunCount: ledger.runCount,
      ledgerCostCentsExact: normalizeCents(ledger.costCentsExact),
      reconciled: addCents(...AVAILABILITIES.map(key => availability[key].costCentsExact)) === normalizeCents(ledger.costCentsExact),
      coverageRate: rate(covered(availability), total.eventCount),
      availability, byAdapter,
      pricingProvenance: [...provenance.values()].sort((a, b) => a.source.localeCompare(b.source)),
      runsWithoutReceipt: {
        total: owedRows.reduce((sum, row) => sum + Number(row.count), 0),
        pendingAccounting: owedRows.reduce((sum, row) => sum + Number(row.pending), 0),
        byAdapter: byAdapterCount(owedRows),
      },
      runsNotOwedReceipt: {
        total: notOwedRows.reduce((sum, row) => sum + Number(row.count), 0),
        byAdapter: byAdapterCount(notOwedRows),
      },
      tokenSemantics: TOKEN_SEMANTICS,
    };
  });
}
