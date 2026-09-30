import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, index, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyMemoryDatabases = pgTable(
  "company_memory_databases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    databaseName: text("database_name").notNull(),
    databaseRole: text("database_role").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(5432),
    sslmode: text("sslmode").notNull().default("require"),
    collectionName: text("collection_name").notNull().default("mem0_memories"),
    embeddingModel: text("embedding_model").notNull().default("text-embedding-3-small"),
    embeddingDimensions: integer("embedding_dimensions").notNull().default(1536),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    secretVersion: integer("secret_version"),
    status: text("status").notNull().default("pending"),
    lastProvisionedAt: timestamp("last_provisioned_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    lastError: text("last_error"),

    // Durable cross-process fenced lease and state machine
    operation: text("operation").notNull().default("idle"),
    leaseToken: text("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseAcquiredAt: timestamp("lease_acquired_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    backoffUntil: timestamp("backoff_until", { withTimezone: true }),
    credentialEpoch: integer("credential_epoch").notNull().default(1),

    // Durable pending rotation metadata for crash-consistent SCRAM credential rotation
    pendingSecretId: uuid("pending_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    pendingSecretVersion: integer("pending_secret_version"),
    pendingScramSalt: text("pending_scram_salt"),
    pendingScramIterations: integer("pending_scram_iterations"),
    pendingScramVerifier: text("pending_scram_verifier"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: uniqueIndex("company_memory_databases_company_id_uq").on(table.companyId),
    databaseNameUq: uniqueIndex("company_memory_databases_database_name_uq").on(table.databaseName),
    databaseRoleUq: uniqueIndex("company_memory_databases_database_role_uq").on(table.databaseRole),
    statusIdx: index("company_memory_databases_status_idx").on(table.status),
    secretIdIdx: index("company_memory_databases_secret_id_idx").on(table.secretId),
    operationIdx: index("company_memory_databases_operation_idx").on(table.operation),
    leaseExpiresIdx: index("company_memory_databases_lease_expires_idx").on(table.leaseExpiresAt),
    backoffUntilIdx: index("company_memory_databases_backoff_until_idx").on(table.backoffUntil),
    statusCheck: check(
      "company_memory_databases_status_check",
      sql`${table.status} in ('pending', 'ready', 'failed', 'deprovisioning', 'deprovisioned')`,
    ),
    operationCheck: check(
      "company_memory_databases_operation_check",
      sql`${table.operation} in ('idle', 'provision', 'rotate', 'archive', 'unarchive', 'deprovision')`,
    ),
    sslmodeCheck: check(
      "company_memory_databases_sslmode_check",
      sql`${table.sslmode} = 'require'`,
    ),
    portCheck: check(
      "company_memory_databases_port_check",
      sql`${table.port} >= 1 and ${table.port} <= 65535`,
    ),
  }),
);
