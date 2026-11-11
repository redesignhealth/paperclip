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
  "tenant_fence_claim_failed",
  "paused_too_long",
  "state_mismatch",
  "migration_failed",
  "schema_init_failed",
  "source_read_failed",
  "conversion_failed",
  "embedding_failed",
  "staging_write_failed",
  "publish_precondition_failed",
  "publish_failed",
  "verification_failed",
  "drain_timeout",
  "rollback_failed",
  "aborted_by_operator",
  "unexpected_failure",
] as const;

export type UpgradeErrorCode = (typeof UPGRADE_ERROR_CODES)[number];

export const SWEEP_ERROR_CODE_MAP: Record<string, UpgradeErrorCode> = {
  // Lease
  LEASE_FENCED_OUT: "lease_fenced_out",
  lease_fenced_out: "lease_fenced_out",
  TENANT_FENCE_CLAIM_FAILED: "tenant_fence_claim_failed",
  tenant_fence_claim_failed: "tenant_fence_claim_failed",
  LEASE_EXPIRED: "lease_expired",
  lease_expired: "lease_expired",
  LEASE_LAPSED: "lease_lapsed",
  lease_lapsed: "lease_lapsed",
  HEARTBEAT_RENEWAL_FAILED: "lease_fenced_out",
  // Active runs
  paused_too_long: "paused_too_long",
  PAUSED_TOO_LONG: "paused_too_long",
  ACTIVE_RUNS_PAUSED_TOO_LONG: "paused_too_long",
  // State
  INVALID_STATE: "state_mismatch",
  STATE_MISMATCH: "state_mismatch",
  UPGRADE_NOT_FOUND: "state_mismatch",
  ACTIVE_UPGRADE_EXISTS: "state_mismatch",
  CONVERTER_CONTRACT_MISMATCH: "state_mismatch",
  // Schema / init
  SCHEMA_INIT_FAILED: "schema_init_failed",
  schema_init_failed: "schema_init_failed",
  MIGRATION_FAILED: "migration_failed",
  migration_failed: "migration_failed",
  NOT_PGVECTOR: "schema_init_failed",
  not_pgvector: "schema_init_failed",
  UNSUPPORTED_VECTOR_TYPE: "schema_init_failed",
  unsupported_vector_type: "schema_init_failed",
  STAGING_VECTOR_TYPE_MISMATCH: "schema_init_failed",
  staging_vector_type_mismatch: "schema_init_failed",
  UNSAFE_CATALOG_TYPE: "schema_init_failed",
  unsafe_catalog_type: "schema_init_failed",
  SCHEMA_MISMATCH: "schema_init_failed",
  schema_mismatch: "schema_init_failed",
  EMBEDDING_DIMENSIONS_MISMATCH: "schema_init_failed",
  embedding_dimensions_mismatch: "schema_init_failed",
  // Source read / tenant database / binding / preflight
  SOURCE_READ_FAILED: "source_read_failed",
  source_read_failed: "source_read_failed",
  UNSUPPORTED_SOURCE_ID: "source_read_failed",
  unsupported_source_id: "source_read_failed",
  TABLE_NOT_FOUND: "source_read_failed",
  table_not_found: "source_read_failed",
  LIVE_TABLE_MISSING: "source_read_failed",
  LIVE_TABLE_INVALID: "source_read_failed",
  DATABASE_IDENTITY_MISMATCH: "source_read_failed",
  DATABASE_IDENTITY_UNAVAILABLE: "source_read_failed",
  SUPERUSER_REJECTED: "source_read_failed",
  superuser_rejected: "source_read_failed",
  SUPERUSER_DISALLOWED: "source_read_failed",
  BYPASSRLS_REJECTED: "source_read_failed",
  bypassrls_rejected: "source_read_failed",
  BYPASSRLS_DISALLOWED: "source_read_failed",
  EXCESSIVE_PRIVILEGE_REJECTED: "source_read_failed",
  excessive_privilege_rejected: "source_read_failed",
  ROLE_CANNOT_SELECT: "source_read_failed",
  ROLE_CAN_MUTATE: "source_read_failed",
  CONTROL_PLANE_ROUTING_MISMATCH: "source_read_failed",
  control_plane_routing_mismatch: "source_read_failed",
  CONTROL_PLANE_UNREACHABLE: "source_read_failed",
  control_plane_unreachable: "source_read_failed",
  COMPANY_MEMORY_DATABASE_UNVERIFIED: "source_read_failed",
  COMPANY_MEMORY_DATABASE_NOT_READY: "source_read_failed",
  COMPANY_NOT_FOUND: "source_read_failed",
  company_not_found: "source_read_failed",
  COMPANY_DELETION_IN_PROGRESS: "state_mismatch",
  company_deletion_in_progress: "state_mismatch",
  COMPANY_BINDING_MISMATCH: "source_read_failed",
  company_binding_mismatch: "source_read_failed",
  OUTPUT_PATH_REJECTED: "source_read_failed",
  output_path_rejected: "source_read_failed",
  PROD_GUARD_ENFORCED: "source_read_failed",
  prod_guard_enforced: "source_read_failed",
  INVALID_DATABASE_URL: "source_read_failed",
  invalid_database_url: "source_read_failed",
  INVALID_ARGUMENT: "source_read_failed",
  invalid_argument: "source_read_failed",
  ACTIVE_RUN_TIMEOUT: "paused_too_long",
  active_run_timeout: "paused_too_long",
  CAS_FAILED: "state_mismatch",
  cas_failed: "state_mismatch",
  INVALID_RECOVERY: "state_mismatch",
  invalid_recovery: "state_mismatch",
  ILLEGAL_TRANSITION: "state_mismatch",
  illegal_transition: "state_mismatch",
  ROLLBACK_REFUSED: "rollback_failed",
  rollback_refused: "rollback_failed",
  // Conversion / embedding / staging / publish / drain / rollback
  CONVERSION_FAILED: "conversion_failed",
  conversion_failed: "conversion_failed",
  LLM_UNAVAILABLE: "conversion_failed",
  llm_unavailable: "conversion_failed",
  COMPANY_OPENAI_KEY_REJECTED: "conversion_failed",
  company_openai_key_rejected: "conversion_failed",
  COMPANY_OPENAI_QUOTA_EXHAUSTED: "conversion_failed",
  company_openai_quota_exhausted: "conversion_failed",
  LLM_REQUEST_REJECTED: "conversion_failed",
  llm_request_rejected: "conversion_failed",
  COMPANY_OPENAI_KEY_MISSING: "conversion_failed",
  company_openai_key_missing: "conversion_failed",
  COMPANY_OPENAI_KEY_PROVIDER_UNSUPPORTED: "conversion_failed",
  company_openai_key_provider_unsupported: "conversion_failed",
  EMBEDDING_FAILED: "embedding_failed",
  embedding_failed: "embedding_failed",
  STAGING_WRITE_FAILED: "staging_write_failed",
  staging_write_failed: "staging_write_failed",
  PUBLISH_PRECONDITION_FAILED: "publish_precondition_failed",
  publish_precondition_failed: "publish_precondition_failed",
  LIVE_TABLE_ID_NOT_UNIQUE: "publish_precondition_failed",
  live_table_id_not_unique: "publish_precondition_failed",
  LIVE_TABLE_NOT_INSERTABLE: "publish_precondition_failed",
  live_table_not_insertable: "publish_precondition_failed",
  PUBLISH_LEDGER_INCONSISTENT: "publish_precondition_failed",
  publish_ledger_inconsistent: "publish_precondition_failed",
  PUBLISH_CONFLICT_UNEXPECTED: "publish_failed",
  publish_conflict_unexpected: "publish_failed",
  PUBLISH_FAILED: "publish_failed",
  publish_failed: "publish_failed",
  VERIFICATION_FAILED: "verification_failed",
  verification_failed: "verification_failed",
  DRAIN_TIMEOUT: "drain_timeout",
  drain_timeout: "drain_timeout",
  ROLLBACK_FAILED: "rollback_failed",
  rollback_failed: "rollback_failed",
  ABORTED_BY_OPERATOR: "aborted_by_operator",
  aborted_by_operator: "aborted_by_operator",
  UNEXPECTED_FAILURE: "unexpected_failure",
  unexpected_failure: "unexpected_failure",
};

export function mapSweepErrorCode(code: string | undefined | null): UpgradeErrorCode {
  if (!code) return "unexpected_failure";
  if (SWEEP_ERROR_CODE_MAP[code]) return SWEEP_ERROR_CODE_MAP[code];
  const lower = code.toLowerCase();
  if ((UPGRADE_ERROR_CODES as readonly string[]).includes(lower)) {
    return lower as UpgradeErrorCode;
  }
  return "unexpected_failure";
}

export const TERMINAL_LLM_ERROR_CODES = Object.freeze(
  new Set<string>([
    "COMPANY_OPENAI_KEY_REJECTED",
    "COMPANY_OPENAI_QUOTA_EXHAUSTED",
    "LLM_REQUEST_REJECTED",
  ]),
);

export class CompanyMemoryUpgradeError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CompanyMemoryUpgradeError";
    this.code = code;
  }
}

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
