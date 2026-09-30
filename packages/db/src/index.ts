export {
  createDb,
  closeRegisteredClients,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
// TECH-6956: Postgres RLS tenant-isolation backstop.
export {
  TENANT_COMPANY_SETTING,
  TENANT_ISOLATION_POLICY,
  TENANT_SCOPE_COLUMN,
  RLS_EXEMPT_TENANT_TABLES,
  listRlsTargets,
  verifyTenantIsolationPolicies,
  describeRlsRole,
  formatRlsProblems,
  type RlsTarget,
  type RlsPolicyProblem,
  type RlsVerificationResult,
  type RlsRoleDescription,
} from "./rls.js";
export {
  assertRlsPoliciesInForce,
  resolveRlsBootCheckMode,
  type RlsBootCheckMode,
} from "./rls-boot-check.js";
export {
  runWithTenantContext,
  getTenantContext,
  setAmbientCompanyId,
  getAmbientCompanyId,
  clearAmbientCompanyId,
  type TenantContext,
} from "./tenant-context.js";
export {
  withCompanyScope,
  bindCompanyScope,
  bindAmbientCompanyScope,
  runWithCompanyScopeTracked,
  isBindableCompanyId,
} from "./company-scope.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
