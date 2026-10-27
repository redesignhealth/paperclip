import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, issueComments,
  agents, companies, createDb, heartbeatRuns, issues, projects, toolApplications, toolCatalogEntries,
  toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { githubGuestBotConnectionForSession } from "../services/chat-github-tools.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("runtime MCP gateway for assigned agents", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-runtime-mcp-agent-created-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function seed(creator: "user" | "agent", creatorCause: string | null = null) {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const [company] = await db.insert(companies).values({
      name: `Delegated ${randomUUID()}`, issuePrefix: `DG${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id, applicationKey: `deleg-${randomUUID().slice(0, 8)}`, name: "App", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id, applicationId: application!.id, name: "Installed MCP", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok",
      config: { url: "https://installed.example.test/mcp" },
    }).returning();
    await db.insert(toolCatalogEntries).values({
      companyId: company!.id, applicationId: application!.id, connectionId: connection!.id,
      name: "installed_tool", toolName: "installed_tool", versionHash: "fixture", status: "active",
    });
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id, profileKey: `app:${connection!.id}`, name: "Installed MCP", defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id, profileId: profile!.id, selectorType: "connection", effect: "include",
      applicationId: application!.id, connectionId: connection!.id,
    });
    const mkAgent = async (name: string) => {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id, name, role: "engineer", adapterType: "hermes_local", adapterConfig: {},
      }).returning();
      await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: profile!.id, targetType: "agent", targetId: agent!.id });
      await db.insert(toolConnectionInstalls).values({ companyId: company!.id, connectionId: connection!.id, targetType: "agent", targetId: agent!.id });
      return agent!;
    };
    const creatorAgent = await mkAgent("Creator");
    const assignee = await mkAgent("Assignee");
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "P" }).returning();
    let originIdentityContextId: string | null = null;
    if (creator === "agent" && creatorCause) {
      const [creatorRun] = await db.insert(heartbeatRuns).values({
        companyId: company!.id, agentId: creatorAgent.id, invocationSource: "on_demand", status: "running", contextSnapshot: {},
      }).returning();
      const ctx = await initializeRunIdentity(db, {
        companyId: company!.id, runId: creatorRun!.id,
        responsibleUserId: creatorCause === "company_default" ? null : "board-user", cause: creatorCause,
      });
      originIdentityContextId = ctx.id;
    }
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, projectId: project!.id, title: "Delegated", status: "in_progress",
      assigneeAgentId: assignee.id,
      ...(creator === "agent" ? { createdByAgentId: creatorAgent.id, originIdentityContextId } : { createdByUserId: "board-user", responsibleUserId: "board-user" }),
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: assignee.id, invocationSource: "assignment", status: "running",
      contextSnapshot: { issueId: issue!.id, projectId: project!.id, wakeReason: "issue_assigned" },
    }).returning();
    return { company: company!, originIdentityContextId, assignee, issue: issue!, run: run!, creatorAgent };
  }

  const cases: Array<["user" | "agent", string | null]> = [["user", null], ["agent", null], ["agent", "manual_user_wake"], ["agent", "company_default"]];
  for (const [creator, creatorCause] of cases) {
    it(`accepts the assigned run credential for an issue created by a ${creator} (${creatorCause})`, async () => {
      const s = await seed(creator, creatorCause);
      await initializeRunIdentity(db, {
        companyId: s.company.id, runId: s.run.id, responsibleUserId: creator === "user" ? "board-user" : null,
        issueId: s.issue.id, cause: "issue_assigned", parentContextId: s.originIdentityContextId,
      });
      const [server] = await buildPaperclipRuntimeMcpServers({ db, agent: s.assignee, runId: s.run.id });
      expect(server).toBeDefined();
      const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(createToolGatewayService(db)));
      const url = new URL(server!.url).pathname;
      const post = (method: string) => request(app).post(url).set("Authorization", `Bearer ${server!.token}`)
        .send({ jsonrpc: "2.0", id: 1, method });
      const init = await post("initialize");
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const list = await post("tools/list");
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...server!.allowedTools].sort());
    });
  }
  for (const guest of [true, false]) {
    it(`keeps a delegated run restricted exactly when its originating GitHub request was sponsored (guest=${guest})`, async () => {
      const s = await seed("agent");
      // The creator's own task, woken by a linked GitHub chat message.
      const [creatorIssue] = await db.insert(issues).values({
        companyId: s.company.id, title: "Chat task", status: "in_progress", assigneeAgentId: s.creatorAgent.id,
      }).returning();
      const [creatorRun] = await db.insert(heartbeatRuns).values({
        companyId: s.company.id, agentId: s.creatorAgent.id, invocationSource: "on_demand", status: "running",
        contextSnapshot: { issueId: creatorIssue!.id },
      }).returning();
      const [comment] = await db.insert(issueComments).values({
        companyId: s.company.id, issueId: creatorIssue!.id, authorType: "user", authorUserId: "board-user", body: "review",
      }).returning();
      const [application] = await db.insert(toolApplications).values({
        companyId: s.company.id, applicationKey: `chat:github:${randomUUID()}`, name: "GitHub", type: "chat", status: "active",
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId: s.company.id, applicationId: application!.id, name: "GitHub bot", uid: `chat-${randomUUID()}`,
        connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
      }).returning();
      const [endpoint] = await db.insert(chatEndpoints).values({
        companyId: s.company.id, connectionId: connection!.id, provider: "github", publicId: randomUUID(),
        assignedAgentId: s.creatorAgent.id, status: "active", providerAccountId: "acct", allowUnlinkedPeople: false,
      }).returning();
      const [conversation] = await db.insert(chatConversations).values({
        companyId: s.company.id, endpointId: endpoint!.id, issueId: creatorIssue!.id, externalConversationId: "c",
        externalThreadId: "t", externalLabel: "pr", state: "active",
      }).returning();
      const [delivery] = await db.insert(chatDeliveries).values({
        companyId: s.company.id, endpointId: endpoint!.id, conversationId: conversation!.id, providerEventId: randomUUID(),
        deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: { githubAuthority: { guest } },
        state: "processed", attempts: 1, processedAt: new Date(),
      }).returning();
      await db.insert(chatMessageLinks).values({
        companyId: s.company.id, endpointId: endpoint!.id, conversationId: conversation!.id, deliveryId: delivery!.id,
        commentId: comment!.id, providerMessageId: "m", direction: "inbound",
      });
      const origin = await initializeRunIdentity(db, {
        companyId: s.company.id, runId: creatorRun!.id, responsibleUserId: "board-user", issueId: creatorIssue!.id,
        messageIds: [comment!.id], cause: "instruction",
      });
      await initializeRunIdentity(db, {
        companyId: s.company.id, runId: s.run.id, responsibleUserId: null, issueId: s.issue.id, cause: "issue_assigned",
        parentContextId: origin.id,
      });
      const guestConnection = await githubGuestBotConnectionForSession(db, {
        companyId: s.company.id, agentId: s.assignee.id, runId: s.run.id, issueId: s.issue.id,
      });
      expect(guestConnection).toBe(guest ? connection!.id : null);
    });
  }
});
