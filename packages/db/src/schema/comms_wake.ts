import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

/**
 * One row per Paperclip agent that the comms board may wake. The signing secret
 * lives in the secret vault; this table only holds the reference to it.
 */
export const commsWakeRegistrations = pgTable(
  "comms_wake_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    boardAgentId: uuid("board_agent_id").notNull(),
    signingSecretId: uuid("signing_secret_id")
      .notNull()
      .references(() => companySecrets.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentFk: foreignKey({
      name: "comms_wake_registrations_company_agent_fk",
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    agentUq: uniqueIndex("comms_wake_registrations_agent_uq").on(table.agentId),
    companyIdx: index("comms_wake_registrations_company_idx").on(table.companyId),
    signingSecretIdx: index("comms_wake_registrations_signing_secret_idx").on(table.signingSecretId),
  }),
);

/** Wake events already received, used to drop duplicates per agent. */
export const commsWakeEvents = pgTable(
  "comms_wake_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    eventId: uuid("event_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    boardConversationId: uuid("board_conversation_id").notNull(),
    seq: integer("seq"),
    messageType: text("message_type"),
    senderBoardAgentId: uuid("sender_board_agent_id").notNull(),
    /** The session reference the board sent with the event (data.sessionRef), kept so a later pass can act on the event. */
    boardSessionRef: text("board_session_ref"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    outcome: text("outcome"),
    /** The session reference Paperclip answered with for this event; replayed on a duplicate. Null until the wake logic sets it. */
    sessionRef: text("session_ref"),
  },
  (table) => ({
    agentFk: foreignKey({
      name: "comms_wake_events_company_agent_fk",
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    agentEventUq: uniqueIndex("comms_wake_events_agent_event_uq").on(table.agentId, table.eventId),
    companyReceivedIdx: index("comms_wake_events_company_received_idx").on(table.companyId, table.receivedAt),
    conversationIdx: index("comms_wake_events_agent_conversation_idx").on(table.agentId, table.boardConversationId),
    kindCheck: check("comms_wake_events_kind_check", sql`${table.kind} in ('message', 'invite')`),
    reasonCheck: check("comms_wake_events_reason_check", sql`${table.reason} in ('rule', 'open_conversation')`),
  }),
);

/** Link between an agent, a board conversation and the Paperclip issue that carries it. */
export const commsWakeConversations = pgTable(
  "comms_wake_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    boardConversationId: uuid("board_conversation_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentFk: foreignKey({
      name: "comms_wake_conversations_company_agent_fk",
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    issueFk: foreignKey({
      name: "comms_wake_conversations_company_issue_fk",
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
    }).onDelete("cascade"),
    agentConversationUq: uniqueIndex("comms_wake_conversations_agent_conversation_uq").on(
      table.agentId,
      table.boardConversationId,
    ),
    issueIdx: index("comms_wake_conversations_issue_idx").on(table.issueId),
    companyIdx: index("comms_wake_conversations_company_idx").on(table.companyId),
  }),
);
