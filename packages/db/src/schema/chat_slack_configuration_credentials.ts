import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * TECH-7981 (RH-only): a personally owned Slack app-configuration credential.
 *
 * Slack's `tooling.tokens.rotate` refresh token is SINGLE-USE, so the stored
 * chain is the only valid one. Secrets are user-scoped vault references; this
 * row never holds a token. `revision` fences every state change and
 * `chain_generation` fences a stale rotation flight against a newer paste.
 * Modelled on `chat_slack_manager_grants`.
 */
export const chatSlackConfigurationCredentials = pgTable("chat_slack_configuration_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  status: text("status").$type<"active" | "rotating" | "reauthorize" | "revoked">().notNull().default("active"),
  accessSecretId: uuid("access_secret_id"),
  refreshSecretId: uuid("refresh_secret_id"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(0),
  chainGeneration: integer("chain_generation").notNull().default(0),
  rotationStartedAt: timestamp("rotation_started_at", { withTimezone: true }),
  lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("chat_slack_configuration_credentials_company_id_idx").on(t.companyId, t.id),
  uniqueIndex("chat_slack_configuration_credentials_owner_idx").on(t.companyId, t.userId, t.workspaceId),
  check("chat_slack_configuration_credentials_status_check", sql`${t.status} in ('active', 'rotating', 'reauthorize', 'revoked')`),
]);
