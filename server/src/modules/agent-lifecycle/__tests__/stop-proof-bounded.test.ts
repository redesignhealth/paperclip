import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped, STOP_PROOF_PAGE_SIZE } from "../../../services/agent-execution-stop.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";

/** Records how many rows each awaited query returns while `run` executes. */
async function rowCounts<T>(db: Db, run: () => Promise<T>) {
  const sizes: number[] = [];
  // Find the prototype that owns `then` for this driver's query builders.
  let owner = Object.getPrototypeOf(db.select().from(heartbeatRuns));
  while (owner && !Object.hasOwn(owner, "then")) owner = Object.getPrototypeOf(owner);
  const original = owner.then;
  owner.then = function patched(this: unknown, resolve?: any, reject?: any) {
    return (original as any).call(this, (rows: unknown) => {
      if (Array.isArray(rows)) sizes.push(rows.length);
      return resolve ? resolve(rows) : rows;
    }, reject);
  } as typeof original;
  try { return { result: await run(), sizes }; }
  finally { owner.then = original; }
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("stuck pausing agent polling", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-pending-backoff-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function agentWithRuns(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backoff test", issuePrefix: `B${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Stuck", status: "paused", lifecycleState: "pausing" }).returning();
    if (count) await db.insert(heartbeatRuns).values(Array.from({ length: count }, () => ({ companyId, agentId: agent!.id,
      status: "succeeded", invocationSource: "on_demand", startedAt: new Date(), finishedAt: new Date() })));
    return { companyId, agent: agent! };
  }

  it("loads no settled run rows when the agent has stopped", async () => {
    const { agent } = await agentWithRuns(STOP_PROOF_PAGE_SIZE * 3);
    const { result, sizes } = await rowCounts(db, () => agentExecutionsHaveStopped(db, [agent.id]));
    expect(result).toBe(true);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(0);
  });

  it("loads a bounded page of rows per query while proving a stop with many cancelled runs", async () => {
    const { companyId, agent } = await agentWithRuns(0);
    await db.insert(heartbeatRuns).values(Array.from({ length: STOP_PROOF_PAGE_SIZE * 3 }, () => ({ companyId, agentId: agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "native", startedAt: new Date(), finishedAt: new Date(),
      processPid: 2_147_483_000 })));
    const { sizes } = await rowCounts(db, () => agentExecutionsHaveStopped(db, [agent.id]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(STOP_PROOF_PAGE_SIZE);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThanOrEqual(STOP_PROOF_PAGE_SIZE * 3);
  });

  it("answers a live run with a single-row existence check", async () => {
    const { companyId, agent } = await agentWithRuns(STOP_PROOF_PAGE_SIZE * 2);
    await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", invocationSource: "on_demand" });
    const { result, sizes } = await rowCounts(db, () => agentExecutionsHaveStopped(db, [agent.id]));
    expect(result).toBe(false);
    expect(sizes).toEqual([1]);
  });

  it("does not offer a deferred agent for work before its retry time", async () => {
    const { agent } = await agentWithRuns(1);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const now = new Date();
    const claimed = await store.claim(agent.id, "owner", now);
    expect(claimed).not.toBeNull();
    expect(await store.defer(claimed!, "owner", null, now, 16_000)).toBe(true);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(Date.parse(row!.lifecycleOperation!.retryAt!) - now.getTime()).toBe(16_000);
    expect(await store.pending(100, new Date(now.getTime() + 15_000))).not.toContain(agent.id);
    expect(await store.claim(agent.id, "other", new Date(now.getTime() + 15_000))).toBeNull();
    expect(await store.pending(100, new Date(now.getTime() + 16_001))).toContain(agent.id);
    // An operator Retry starts the backoff over so a flagged agent is checked at once.
    await store.change(agent.id, "retry");
    const [retried] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(retried!.lifecycleOperation).toMatchObject({ attempts: 0 });
    expect(retried!.lifecycleOperation!.retryAt).toBeUndefined();
  });
});
