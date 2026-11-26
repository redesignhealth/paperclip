import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";

export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    /**
     * Environment NEW agents of any company inherit at create/hire when neither the request nor the company names one
     * (TECH-10878). Separate from defaultEnvironmentId, whose meaning is unchanged. Null = unset.
     */
    newAgentDefaultEnvironmentId: uuid("new_agent_default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    sso: jsonb("sso").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_settings_singleton_key_idx").on(table.singletonKey),
  }),
);
