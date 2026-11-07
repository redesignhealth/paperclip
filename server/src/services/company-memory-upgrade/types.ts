import type { companyMemoryUpgrades, UpgradeState } from "@paperclipai/db";

export { UPGRADE_STATES, type UpgradeState } from "@paperclipai/db";

export type CompanyMemoryUpgradeRow = typeof companyMemoryUpgrades.$inferSelect;
export type NewCompanyMemoryUpgradeRow = typeof companyMemoryUpgrades.$inferInsert;

export const UPGRADE_LEDGER_OUTCOMES = [
  "published",
  "dropped_noise",
  "deduplicated",
  "dropped_sensitive",
  "unroutable",
  "quarantined",
  "superseded",
  "source_deleted",
] as const;

export type UpgradeLedgerOutcome = (typeof UPGRADE_LEDGER_OUTCOMES)[number];

export const UPGRADE_ERROR_CODES = [
  "lease_lapsed",
  "lease_expired",
  "lease_fenced_out",
  "state_mismatch",
  "migration_failed",
  "schema_init_failed",
  "source_read_failed",
  "conversion_failed",
  "embedding_failed",
  "staging_write_failed",
  "publish_failed",
  "verification_failed",
  "drain_timeout",
  "rollback_failed",
  "aborted_by_operator",
  "unexpected_failure",
] as const;

export type UpgradeErrorCode = (typeof UPGRADE_ERROR_CODES)[number];

export interface OpenUpgradeParams {
  companyId: string;
  converterId: string;
  converterVersion: number;
  collectionName: string;
  embeddingModel: string;
  embeddingDimensions: number;
  /** Operator-provided label for identification. Must not be used for raw errors or exception messages. */
  operatorLabel?: string | null;
}

export interface ClaimLeaseParams {
  upgradeId: string;
  leaseOwner: string;
  ttlMs?: number;
  now?: Date;
}

export interface ClaimLeaseResult {
  acquired: boolean;
  leaseToken?: string;
  leaseOwner?: string;
  leaseAcquiredAt?: Date;
  leaseExpiresAt?: Date;
  upgrade?: CompanyMemoryUpgradeRow;
}

export interface LeaseHeartbeatHandle {
  isLost(): boolean;
  assertActive(): void;
  stop(): Promise<void>;
  getKnownExpiresAtMs(): number;
}

export interface StartLeaseHeartbeatOptions {
  initialExpiresAt: Date | number;
  intervalMs?: number;
  ttlMs?: number;
  onLost?: () => void;
  clock?: Clock;
}

export interface UpdateCountersParams {
  // Integer counter deltas
  sweepCount?: number;
  sourceSeenCount?: number;
  publishedCount?: number;
  droppedNoiseCount?: number;
  droppedSensitiveCount?: number;
  deduplicatedCount?: number;
  unroutableCount?: number;
  quarantinedCount?: number;
  supersededCount?: number;
  sourceDeletedCount?: number;

  // Bigint counter deltas
  llmInputTokens?: number | bigint;
  llmOutputTokens?: number | bigint;
  embeddingTokens?: number | bigint;
  estimatedCostNanodollars?: number | bigint;

  // Timestamps to record
  markedAt?: Date;
  drainConfirmedAt?: Date;

  lastError?: UpgradeErrorCode | null;
}

export interface Clock {
  now(): Date;
}
