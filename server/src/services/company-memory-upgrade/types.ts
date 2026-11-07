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

export interface OpenUpgradeParams {
  companyId: string;
  converterId: string;
  converterVersion: number;
  collectionName: string;
  embeddingModel: string;
  embeddingDimensions: number;
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
  llmInputTokens?: number;
  llmOutputTokens?: number;
  embeddingTokens?: number;
  estimatedCostNanodollars?: number;

  // Timestamps to record
  markedAt?: Date;
  drainConfirmedAt?: Date;
  verifiedAt?: Date;
  prunedAt?: Date;
  rolledBackAt?: Date;
  completedAt?: Date;

  lastError?: string | null;
}

export interface Clock {
  now(): Date;
}
