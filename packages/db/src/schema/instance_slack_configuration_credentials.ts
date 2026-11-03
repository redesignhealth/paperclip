import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * RH-only: an instance-wide Slack app-configuration credential, saved once by
 * an instance administrator and used by every company's Slack setup.
 *
 * Deliberately NOT tenant-scoped: it has no `company_id`, so the tenant policy
 * does not apply, the same as `instance_settings`. Slack's `tooling.tokens.rotate`
 * refresh token is SINGLE-USE, so the stored chain is the only valid one;
 * `revision` fences every state change and `chain_generation` fences a stale
 * rotation flight against a newer paste. Same protocol as
 * `chat_slack_configuration_credentials`, with the token pair encrypted by the
 * instance master key (see `encryptInstanceSecretValue`) instead of stored as
 * company secrets. The table never holds a plaintext token.
 */
export const instanceSlackConfigurationCredentials = pgTable("instance_slack_configuration_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: text("workspace_id").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  savedByUserId: text("saved_by_user_id").notNull(),
  status: text("status").$type<"active" | "rotating" | "reauthorize" | "revoked">().notNull().default("active"),
  accessMaterial: jsonb("access_material").$type<Record<string, unknown>>(),
  refreshMaterial: jsonb("refresh_material").$type<Record<string, unknown>>(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(0),
  chainGeneration: integer("chain_generation").notNull().default(0),
  rotationStartedAt: timestamp("rotation_started_at", { withTimezone: true }),
  lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // One credential per Slack workspace; a re-save replaces its chain in place.
  uniqueIndex("instance_slack_configuration_credentials_workspace_idx").on(t.workspaceId),
  check("instance_slack_configuration_credentials_status_check", sql`${t.status} in ('active', 'rotating', 'reauthorize', 'revoked')`),
]);
