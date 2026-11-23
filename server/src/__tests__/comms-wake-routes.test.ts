import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  commsWakeEvents,
  commsWakeRegistrations,
  companies,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { signCommsWake } from "../services/comms-wake-signature.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comms wake route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("comms board wake route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comms-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  async function createApp() {
    const { errorHandler } = await import("../middleware/index.js");
    const { commsWakeRoutes } = await import("../routes/comms-wake.js");
    const app = express();
    // Same raw-body capture as app.ts so the route verifies the original bytes.
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use("/api", commsWakeRoutes(db, { heartbeat: { wakeup: async () => ({ id: randomUUID() }) } }));
    app.use(errorHandler);
    return app;
  }

  async function seed(options: { registered?: boolean } = {}) {
    const { secretService } = await import("../services/secrets.js");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const boardAgentId = randomUUID();
    const key = randomBytes(32);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (options.registered !== false) {
      const secret = await secretService(db).create(
        companyId,
        {
          name: `Comms wake secret (agent ${agentId})`,
          key: `comms-wake-${agentId}`,
          provider: "local_encrypted",
          value: `whsec_${key.toString("base64")}`,
        },
        { userId: null },
      );
      await db.insert(commsWakeRegistrations).values({
        companyId,
        agentId,
        boardAgentId,
        signingSecretId: secret.id,
      });
    }
    return { companyId, agentId, boardAgentId, key };
  }

  function eventBody(boardAgentId: string, overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    return {
      eventId: randomUUID(),
      name: "comms.wake",
      timestamp: new Date().toISOString(),
      data: {
        kind: "message",
        recipientAgentId: boardAgentId,
        conversationId: randomUUID(),
        seq: 4,
        messageType: "task_assign",
        senderAgentId: randomUUID(),
        sessionRef: null,
        reason: "rule",
        ...data,
      },
      cursor: null,
      ...overrides,
    };
  }

  function deliver(
    app: express.Express,
    agentId: string,
    key: Buffer,
    body: Record<string, unknown>,
    opts: { webhookId?: string; timestamp?: string; signWith?: Buffer; rawOverride?: string } = {},
  ) {
    const raw = opts.rawOverride ?? JSON.stringify(body);
    const webhookId = opts.webhookId ?? (body.eventId as string);
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = signCommsWake({
      key: opts.signWith ?? key,
      webhookId,
      timestamp,
      rawBody: Buffer.from(raw),
    });
    return request(app)
      .post(`/api/comms-board/wake/${agentId}`)
      .set("Content-Type", "application/json")
      .set("webhook-id", webhookId)
      .set("webhook-timestamp", timestamp)
      .set("webhook-signature", `v1,${signature}`)
      .send(raw);
  }

  const storedEvents = () => db.select().from(commsWakeEvents);

  it("accepts a verified event once and reports a duplicate afterwards", async () => {
    const { agentId, boardAgentId, key, companyId } = await seed();
    const app = await createApp();
    const body = eventBody(boardAgentId, {}, { sessionRef: "board-session-1" });

    const first = await deliver(app, agentId, key, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "accepted" });
    const issueId = first.body.sessionRef as string;

    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      agentId,
      eventId: body.eventId,
      kind: "message",
      reason: "rule",
      seq: 4,
      messageType: "task_assign",
      boardSessionRef: "board-session-1",
      issueId,
      outcome: "accepted",
      sessionRef: issueId,
    });
    expect(rows[0]!.commentId).toBeTruthy();

    const second = await deliver(app, agentId, key, body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "duplicate", sessionRef: issueId });
    expect(await storedEvents()).toHaveLength(1);
  });

  it("returns the stored session reference on a duplicate", async () => {
    const { agentId, boardAgentId, key } = await seed();
    const app = await createApp();
    const body = eventBody(boardAgentId);
    await deliver(app, agentId, key, body);
    await db.update(commsWakeEvents).set({ sessionRef: "PAP-42" });
    const again = await deliver(app, agentId, key, body);
    expect(again.body).toEqual({ status: "duplicate", sessionRef: "PAP-42" });
  });

  it("accepts an invite with null seq and message type", async () => {
    const { agentId, boardAgentId, key } = await seed();
    const app = await createApp();
    const res = await deliver(app, agentId, key, eventBody(boardAgentId, {}, { kind: "invite", seq: null, messageType: null, reason: "open_conversation" }));
    expect(res.status).toBe(200);
    expect(await storedEvents()).toMatchObject([{ kind: "invite", seq: null, messageType: null, reason: "open_conversation" }]);
  });

  it("scopes duplicate detection to the agent", async () => {
    const first = await seed();
    const second = await seed();
    const app = await createApp();
    const eventId = randomUUID();
    expect((await deliver(app, first.agentId, first.key, eventBody(first.boardAgentId, { eventId }))).body.status).toBe("accepted");
    expect((await deliver(app, second.agentId, second.key, eventBody(second.boardAgentId, { eventId }))).body.status).toBe("accepted");
    expect(await storedEvents()).toHaveLength(2);
  });

  it("rejects a webhook-id that differs from the event id", async () => {
    const { agentId, boardAgentId, key } = await seed();
    const app = await createApp();
    const res = await deliver(app, agentId, key, eventBody(boardAgentId), { webhookId: randomUUID() });
    expect(res.status).toBe(401);
    expect(await storedEvents()).toHaveLength(0);
  });

  it("rejects a recipient that is not the agent's board identity", async () => {
    const { agentId, key } = await seed();
    const app = await createApp();
    const res = await deliver(app, agentId, key, eventBody(randomUUID()));
    expect(res.status).toBe(401);
    expect(await storedEvents()).toHaveLength(0);
  });

  it("returns the same 410 for an unknown agent, an unregistered agent and a non-uuid id", async () => {
    const unregistered = await seed({ registered: false });
    const app = await createApp();
    const body = eventBody(randomUUID());
    const responses = [
      await deliver(app, randomUUID(), randomBytes(32), body),
      await deliver(app, unregistered.agentId, unregistered.key, body),
      await deliver(app, "not-a-uuid", randomBytes(32), body),
    ];
    for (const res of responses) expect(res.status).toBe(410);
    expect(new Set(responses.map((res) => JSON.stringify(res.body))).size).toBe(1);
    expect(await storedEvents()).toHaveLength(0);
  });

  it("returns 400 and stores nothing for an invalid body with a valid signature", async () => {
    const { agentId, boardAgentId, key } = await seed();
    const app = await createApp();
    const bad = [
      eventBody(boardAgentId, { name: "other.event" }),
      eventBody(boardAgentId, {}, { kind: "reply" }),
      eventBody(boardAgentId, {}, { conversationId: "nope" }),
      eventBody(boardAgentId, {}, { sessionRef: "x".repeat(256) }),
      eventBody(boardAgentId, {}, { seq: 1.5 }),
      eventBody(boardAgentId, {}, { reason: "other" }),
    ];
    for (const body of bad) {
      const res = await deliver(app, agentId, key, body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    expect(await storedEvents()).toHaveLength(0);
  });

  it("returns 401 and stores nothing for bad signatures", async () => {
    const { agentId, boardAgentId, key } = await seed();
    const app = await createApp();
    const body = eventBody(boardAgentId);
    const raw = JSON.stringify(body);
    const now = Math.floor(Date.now() / 1000);

    const wrongSecret = await deliver(app, agentId, key, body, { signWith: randomBytes(32) });
    const stale = await deliver(app, agentId, key, body, { timestamp: String(now - 10 * 60) });
    const future = await deliver(app, agentId, key, body, { timestamp: String(now + 10 * 60) });
    // Signed over the original bytes, delivered with one extra byte.
    const altered = await request(app)
      .post(`/api/comms-board/wake/${agentId}`)
      .set("Content-Type", "application/json")
      .set("webhook-id", body.eventId as string)
      .set("webhook-timestamp", String(now))
      .set(
        "webhook-signature",
        `v1,${signCommsWake({ key, webhookId: body.eventId as string, timestamp: String(now), rawBody: Buffer.from(raw) })}`,
      )
      .send(`${raw} `);
    const noHeaders = await request(app)
      .post(`/api/comms-board/wake/${agentId}`)
      .set("Content-Type", "application/json")
      .send(raw);
    const malformed = await request(app)
      .post(`/api/comms-board/wake/${agentId}`)
      .set("Content-Type", "application/json")
      .set("webhook-id", body.eventId as string)
      .set("webhook-timestamp", String(now))
      .set("webhook-signature", "v1,!!!not-base64")
      .send(raw);

    for (const res of [wrongSecret, stale, future, altered, noHeaders, malformed]) {
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("v1,");
    }
    expect(await storedEvents()).toHaveLength(0);
  });

  it("rejects a request without a JSON content type", async () => {
    const { agentId, boardAgentId } = await seed();
    const app = await createApp();
    const res = await request(app)
      .post(`/api/comms-board/wake/${agentId}`)
      .type("text")
      .send(JSON.stringify(eventBody(boardAgentId)));
    expect(res.status).toBe(415);
    expect(await storedEvents()).toHaveLength(0);
  });

  it("keeps the signing secret out of the registration table", async () => {
    const { key } = await seed();
    const [registration] = await db.select().from(commsWakeRegistrations);
    expect(JSON.stringify(registration)).not.toContain(key.toString("base64"));
    const [secret] = await db.select().from(companySecrets);
    expect(registration.signingSecretId).toBe(secret.id);
  });
});
