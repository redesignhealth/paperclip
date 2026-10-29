import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agents,
  chatEndpoints,
  chatSlackRegistrations,
  companies,
  createDb,
  toolApplications,
  toolConnections,
  toolCatalogEntries,
} from "@paperclipai/db";
import { buildSlackAppManifest, SLACK_OPT_IN_SCOPE_GROUPS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../../__tests__/helpers/embedded-postgres.js";
import {
  applySlackOptInManifestChange,
  canonicalJson,
  recordInstalledSlackOptIns,
  slackInstallManifestHash,
} from "./opt-in-manifest.js";
import { slackBotCatalogIsCurrent, syncSlackBotTools } from "../../slack-catalog.js";

const support = await getEmbeddedPostgresTestSupport();

/** TECH-7988: manifest/pending/hash/atomic-write and catalog status invariants. */
describe("Slack opt-in manifest machinery", () => {
  it("hashes key-reordered manifests identically", () => {
    const manifest = {
      oauth_config: { scopes: { bot: ["chat:write", "commands"] } },
      settings: { interactivity: { request_url: "https://x/hook", is_enabled: true } },
    };
    const reordered = {
      settings: { interactivity: { is_enabled: true, request_url: "https://x/hook" } },
      oauth_config: { scopes: { bot: ["chat:write", "commands"] } },
    };
    expect(slackInstallManifestHash(manifest)).toBe(slackInstallManifestHash(reordered));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(slackInstallManifestHash({ a: 1 })).not.toBe(slackInstallManifestHash({ a: 2 }));
  });

  const describeDb = support.supported ? describe : describe.skip;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;

  async function fixture() {
    database ??= await startEmbeddedPostgresTestDatabase("paperclip-slack-opt-in-");
    db ??= createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: `Opt-in ${randomUUID()}`, issuePrefix: `SO${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Opt-in agent" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Slack", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId: company.id, connectionId: connection.id, assignedAgentId: agent.id,
      provider: "slack", publicId: randomUUID(), status: "active",
      setup: {
        step: "complete" as const,
        slackSetupMethod: "managed" as const,
        slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
        slackOptInScopeGroups: [],
        slackInstalledOptInScopeGroups: [],
      },
    }).returning();
    const manifest = buildSlackAppManifest({
      app: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
      agentName: "Maya",
      webhookUrl: "https://paperclip.example/api/chat-webhooks/public/slack",
    });
    await db.insert(chatSlackRegistrations).values({
      endpointId: endpoint.id, companyId: company.id, requestId: randomUUID(), status: "configured",
      manifest, manifestHash: slackInstallManifestHash(manifest),
      callbackUri: "https://paperclip.example/api/chat-slack/oauth/callback",
      appId: "ATEST", botUserId: "UBOT", workspaceId: "T1", createdByUserId: "user",
    });
    return { company, agent, connection, endpoint };
  }

  describeDb("database", () => {
    afterAll(async () => { await database?.cleanup(); });

    it("treats missing permission setup as stale even when every definition hash matches", async () => {
      const f = await fixture();
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      expect(await slackBotCatalogIsCurrent(db!, f.endpoint)).toBe(true);
      const { setup: _omitted, ...withoutSetup } = f.endpoint;
      expect(await slackBotCatalogIsCurrent(db!, withoutSetup)).toBe(false);
    });

    it("detects permission staleness and preserves an operator disable across repeated syncs", async () => {
      const f = await fixture();
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      const withUpload = { ...f.endpoint, setup: { ...f.endpoint.setup,
        slackOptInScopeGroups: ["file_upload" as const], slackInstalledOptInScopeGroups: ["file_upload" as const] } };
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(false);
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      expect(await slackBotCatalogIsCurrent(db!, withUpload)).toBe(true);
      await db!.update(toolCatalogEntries).set({ status: "disabled" }).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      await db!.transaction(tx => syncSlackBotTools(tx, f.endpoint, "user", true));
      await db!.transaction(tx => syncSlackBotTools(tx, withUpload, "user", true));
      const [entry] = await db!.select().from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.connectionId, f.connection.id), eq(toolCatalogEntries.toolName, "slack_upload_file"),
      ));
      expect(entry!.status).toBe("disabled");
    });

    it("writes only its own key, so a concurrent runtimeGeneration bump survives", async () => {
      const f = await fixture();
      // Simulate a concurrent writer bumping runtimeGeneration between read and write.
      const pending = recordInstalledSlackOptIns(db!, {
        endpointId: f.endpoint.id,
        companyId: f.company.id,
        grantedScopes: ["files:write"],
      });
      await db!.update(chatEndpoints)
        .set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{runtimeGeneration}', '9'::jsonb)` })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      await pending;
      const [saved] = await db!.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(saved!.setup.slackInstalledOptInScopeGroups).toEqual(["file_upload"]);
      expect((saved!.setup as { runtimeGeneration?: number }).runtimeGeneration).toBe(9);
    });

    it("clears the pending marker when the request returns to the installed set", async () => {
      const f = await fixture();
      const app = f.endpoint.setup.slackApp;
      // Request file_upload: it becomes pending.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: ["file_upload"] },
      });
      let [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBe("slack_permissions_update_pending");
      // Toggling it back to the installed set clears the pending state.
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: f.company.id, agentName: "Maya", app,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: [] },
      });
      [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();
      expect(row!.status).toBe("configured");
    });

    it("scopes its registration writes by company", async () => {
      const f = await fixture();
      const [other] = await db!.insert(companies).values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
      await applySlackOptInManifestChange(db!, {
        endpointId: f.endpoint.id, companyId: other!.id, agentName: "Maya",
        app: f.endpoint.setup.slackApp,
        setup: { ...f.endpoint.setup, slackOptInScopeGroups: ["file_upload"] },
      });
      const [row] = await db!.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, f.endpoint.id));
      expect(row!.errorCode).toBeNull();
    });

    it("flips a gated tool between removed and active as the install changes", async () => {
      const f = await fixture();
      const statuses = async () => Object.fromEntries(
        (await db!.select({ name: toolCatalogEntries.name, status: toolCatalogEntries.status })
          .from(toolCatalogEntries)
          .where(eq(toolCatalogEntries.connectionId, f.connection.id)))
          .map((entry) => [entry.name.replace("slack_bot:", ""), entry.status]),
      );
      const [noOptIns] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, noOptIns!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("removed");

      // Requesting AND installing file_upload: the same definition hash must
      // still flip the entry to active.
      await db!.update(chatEndpoints).set({
        setup: sql`${chatEndpoints.setup} || ${JSON.stringify({
          slackOptInScopeGroups: ["file_upload"], slackInstalledOptInScopeGroups: ["file_upload"],
        })}::jsonb`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      const [withUpload] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, withUpload!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("active");

      // Removing the request disables it, even though Slack may still report
      // the scope on the installation.
      await db!.update(chatEndpoints).set({
        setup: sql`${chatEndpoints.setup} || ${JSON.stringify({
          slackOptInScopeGroups: [], slackInstalledOptInScopeGroups: ["file_upload"],
        })}::jsonb`,
      }).where(eq(chatEndpoints.id, f.endpoint.id));
      const [cleared] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      await db!.transaction((tx) => syncSlackBotTools(tx, cleared!, "user", true));
      expect((await statuses()).slack_upload_file).toBe("removed");
    });

    it("keeps a legacy fieldless installation's gated tools active", async () => {
      const f = await fixture();
      // A legacy install is a connected bot on a row with neither opt-in field;
      // the endpoint fixture omits botExternalId, so set it here. The fields
      // must be absent, not empty: an empty request means "nothing enabled".
      await db!.update(chatEndpoints)
        .set({
          botExternalId: "ULEGACY",
          setup: sql`(${chatEndpoints.setup} - 'slackOptInScopeGroups') - 'slackInstalledOptInScopeGroups'`,
        })
        .where(eq(chatEndpoints.id, f.endpoint.id));
      const [legacy] = await db!.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id));
      expect(SLACK_OPT_IN_SCOPE_GROUPS).toHaveLength(3);
      await db!.transaction((tx) => syncSlackBotTools(tx, legacy!, "user", true));
      const [upload] = await db!.select({ status: toolCatalogEntries.status })
        .from(toolCatalogEntries)
        .where(and(
          eq(toolCatalogEntries.connectionId, f.connection.id),
          eq(toolCatalogEntries.name, "slack_bot:slack_upload_file"),
        ));
      expect(upload?.status).toBe("active");
    });
  });
});
