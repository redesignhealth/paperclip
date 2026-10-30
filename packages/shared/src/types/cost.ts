import type { AgentAppearance } from "../agent-appearance.js";
import type { BillingType, CostStatus } from "../constants.js";

export interface CostEvent {
  subscriptionId?: string | null;
  usageKind?: "agent" | "decision" | "fast_response" | "prompt_injection";
  responsibleUserId?: string | null;
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  idempotencyKey: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  costCentsExact?: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  eventCount: number;
  pendingRunCount: number;
  unpricedEventCount: number;
  estimatedEventCount?: number;
  /** Receipts whose API/subscription billing identity was not established. */
  unknownBillingEventCount?: number;
  pricingComplete: boolean;
  companyId: string;
  spendCents: number;
  spendCentsExact?: string;
  budgetCents: number;
  utilizationPercent: number;
}

export type CostDataQualityReason = "unknown_billing" | "missing_model" | "missing_price"
  | "waiting_for_receipt" | "receipt_unavailable" | "retryable";

export interface CostDataQualityItem {
  id: string;
  runId: string | null;
  agentId: string | null;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  occurredAt: string;
  provider: string | null;
  model: string | null;
  reason: CostDataQualityReason;
}

export interface CostDataQualityReport {
  canRetry: boolean;
  /** Each category is bounded independently so one cannot hide another. */
  events: CostDataQualityItem[];
  runs: CostDataQualityItem[];
  hasMoreEvents: boolean;
  hasMoreRuns: boolean;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByUser {
  /** The run's recorded responsible user; null means unattributed. */
  userId: string | null;
  userName: string | null;
  userImage: string | null;
  eventCount: number;
  estimatedEventCount: number;
  unpricedEventCount: number;
  costCents: number;
  costCentsExact: string;
  /** Input excludes cached input, as in other cost reports. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Distinct recorded runs with cost events in the selected period. */
  runCount: number;
}

export interface CostByUserReport {
  /** Active human members, excluding the synthetic local-board principal. */
  activeUserCount: number;
  /** Includes zero-spend active users, even in single-user companies. */
  rows: CostByUser[];
}

export interface CostByAgent {
  agentId: string | null;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  agentStatus: string | null;
  /** Ledger events in this group and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  costCentsExact?: string;
  eventCount?: number;
  estimatedEventCount?: number;
  unpricedEventCount?: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  costCentsExact?: string;
  eventCount?: number;
  estimatedEventCount?: number;
  unpricedEventCount?: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string | null;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  /** Ledger events in this group and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  /** Ledger events in this project and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Reporting-only classification of how a ledger event's token usage was obtained.
 * `unavailable` means a receipt exists but carries no usable usage (0/0 tokens, no
 * provider request id, no usage payload). It is never evidence of zero consumption.
 * `measured_zero` means 0 tokens with independent evidence: a provider request id, a
 * non-empty per-model usage payload, or provider-reported/invoiced pricing provenance.
 * That rule can undercount real zeros for adapters that supply none of these, and can
 * overstate a zero when a provider reports cost but no tokens; treat it as a lower bound. */
export type UsageAvailability = "reported" | "estimated" | "unavailable" | "measured_zero";

/** Billing kind is kept separate from availability so subscription and unknown
 * billing are never folded into metered coverage. */
export type UsageBillingKind = "metered" | "subscription" | "unknown";

export interface UsageAvailabilityTotals {
  eventCount: number;
  /** Events with costStatus unpriced, excluding subscription_included. */
  unpricedEventCount: number;
  costCentsExact: string;
  /** Includes cache writes, excludes cache reads (those are cachedInputTokens). */
  inputTokens: number;
  /** Cache reads only. */
  cachedInputTokens: number;
  outputTokens: number;
  /** inputTokens + cachedInputTokens + outputTokens; cache tokens are counted once. */
  totalTokens: number;
}

export interface UsageAvailabilityByAdapter {
  adapterType: string;
  /** All receipt-backed events for this adapter. */
  eventCount: number;
  /** (reported + estimated) / eventCount. Null when there are no events. */
  coverageRate: number | null;
  availability: Record<UsageAvailability, UsageAvailabilityTotals>;
  billingKindEventCounts: Record<UsageBillingKind, number>;
}

export interface UsageAvailabilityReport {
  companyId: string;
  /** Receipt-backed agent ledger events only. */
  total: UsageAvailabilityTotals;
  /** Distinct runs behind `total`. A multi-model run yields several events. */
  receiptRunCount: number;
  /** Independent sum of the same ledger rows; availability subtotals must equal it. */
  ledgerCostCentsExact: string;
  reconciled: boolean;
  coverageRate: number | null;
  availability: Record<UsageAvailability, UsageAvailabilityTotals>;
  byAdapter: UsageAvailabilityByAdapter[];
  /** Retained from the ledger, never recomputed. */
  pricingProvenance: Array<{ source: string; eventCount: number; costCentsExact: string }>;
  /** Terminal runs with no ledger event. Excluded from every coverage rate above. */
  runsWithoutReceipt: {
    total: number;
    /** Subset still waiting for accounting to settle (late receipt possible). */
    pendingAccounting: number;
    byAdapter: Array<{ adapterType: string; count: number }>;
  };
  /** Human-readable statement of the token field contract. */
  tokenSemantics: string;
}
