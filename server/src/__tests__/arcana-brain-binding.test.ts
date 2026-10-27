import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { composeArcanaBrainIdentity } from "../services/arcana-provisioner-client.js";
import { composeCommsBoardIdentity } from "../services/comms-board-provisioner-client.js";
import { readDefaultMcpState } from "../services/default-mcp-spec.js";
import {
  BRAIN_BINDING_CONFIRMATION,
  BrainBindingConfirmationError,
  backfillBrainBindings,
  __resetBrainBindingSweepForTests,
  resolveBrainBindingConfig,
  sweepBrainBindings,
} from "../services/arcana-brain-binding.js";
import { captureAndScrubArcanaProvisionerCredentials, __resetArcanaProvisionerForTests, readArcanaProvisionerSnapshot } from "../secrets/arcana-provisioner-credentials.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REGISTRY = "https://aca.example.test/registry";
const TOKEN = "binding-token-value";
const ENV = { PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: REGISTRY, PAPERCLIP_ARCANA_BINDING_TOKEN: TOKEN } as NodeJS.ProcessEnv;

describe("brain binding config", () => {
  it("needs both the registry URL and the binding token, and only a safe endpoint", () => {
    expect(resolveBrainBindingConfig({} as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "binding_not_configured" });
    expect(resolveBrainBindingConfig({ PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: REGISTRY } as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "binding_not_configured" });
    expect(resolveBrainBindingConfig({ ...ENV, PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL: "http://aca.example.test" } as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "binding_config_invalid" });
    expect(resolveBrainBindingConfig(ENV)).toEqual({ ok: true, config: { registryUrl: REGISTRY, bindingToken: TOKEN } });
  });

  it("the binding token is captured once and scrubbed from the environment", () => {
    __resetArcanaProvisionerForTests();
    const env = { PAPERCLIP_ARCANA_BINDING_TOKEN: "t1", PAPERCLIP_ARCANA_URL: "https://arcana.example.test", PAPERCLIP_ARCANA_PROVISION_KEY: "k" } as NodeJS.ProcessEnv;
    captureAndScrubArcanaProvisionerCredentials(env);
    expect(env.PAPERCLIP_ARCANA_BINDING_TOKEN).toBeUndefined();
    expect(readArcanaProvisionerSnapshot().bindingToken).toBe("t1");
    env.PAPERCLIP_ARCANA_BINDING_TOKEN = "later";
    captureAndScrubArcanaProvisionerCredentials(env);
    expect(env.PAPERCLIP_ARCANA_BINDING_TOKEN).toBeUndefined();
    expect(readArcanaProvisionerSnapshot().bindingToken).toBe("t1");
    __resetArcanaProvisionerForTests();
  });
});

describeEmbeddedPostgres("arcana brain binding push, sweep and backfill", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("arcana-brain-binding");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(async () => {
    __resetBrainBindingSweepForTests();
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    opts: {
      generation?: number;
      commsState?: string;
      arcanaState?: string;
      boardSub?: string;
      agentKey?: string | null;
      arcanaExtra?: Record<string, unknown>;
      status?: string;
      id?: string;
    } = {},
  ) {
    const agentId = opts.id ?? randomUUID();
    const identity = composeArcanaBrainIdentity(companyId, agentId)!;
    const generation = opts.generation ?? 0;
    const minted = composeCommsBoardIdentity(agentId, generation)!;
    const metadata = {
      defaultMcp: {
        version: 1,
        entries: {
          "comms-board": {
            key: "comms-board",
            ...(generation ? { identityGeneration: generation } : {}),
            setup: { state: opts.commsState ?? "ready", reason: null },
            binding: { baseSub: minted.baseSub, boardSub: opts.boardSub ?? minted.boardSub, agentKey: opts.agentKey ?? null, secretId: randomUUID() },
          },
          "arcana-brain": {
            key: "arcana-brain",
            setup: { state: opts.arcanaState ?? "ready", reason: null },
            binding: { baseSub: identity.agentPrincipalId, boardSub: null, agentKey: null, secretId: randomUUID(), ...opts.arcanaExtra },
          },
        },
      },
    };
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${agentId.slice(0, 6)}`,
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      status: (opts.status ?? "idle") as never,
      metadata,
    });
    return { agentId, identity, minted, generation };
  }

  async function arcanaOf(agentId: string) {
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId));
    return readDefaultMcpState(row!.metadata)!.entries["arcana-brain"]!;
  }

  const real = { dryRun: false, confirm: BRAIN_BINDING_CONFIRMATION };

  function aca(status: number | ((sub: string) => number) = 201) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const s = typeof status === "function" ? status(String(_url).split("/brain-bindings/")[1]!) : status;
      void init;
      return new Response(JSON.stringify({ detail: "x" }), { status: s });
    });
  }

  it("a dry run (the default) makes no call and reports would_bind", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl });
    expect(report.dryRun).toBe(true);
    expect(report.counts.would_bind).toBe(1);
    expect(report.outcomes[0]).toMatchObject({ agentId, result: "would_bind", generation: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await arcanaOf(agentId)).binding?.brainBinding).toBeUndefined();
  });

  it("a real run needs the confirmation string", async () => {
    const companyId = await seedCompany();
    await expect(backfillBrainBindings(db, { companyId, env: ENV, dryRun: false })).rejects.toBeInstanceOf(BrainBindingConfirmationError);
  });

  it("binds with the exact recipe body, records the marker and ids, and a second run is already_current", async () => {
    const companyId = await seedCompany();
    const { agentId, identity, minted } = await seedAgent(companyId);
    const fetchImpl = aca(201);
    const first = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(first.counts.bound).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${REGISTRY}/brain-bindings/${minted.boardSub}`);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      principal: identity.agentPrincipalId,
      runtime: identity.runtimeId,
      company: companyId,
      brain_id: identity.brainId,
      agent_id: agentId,
      identity_generation: 0,
    });
    const binding = (await arcanaOf(agentId)).binding!;
    expect(binding.brainBinding).toMatchObject({ state: "bound", boardSub: minted.boardSub, generation: 0 });
    expect(binding.arcanaRuntimeId).toBe(identity.runtimeId);
    expect(binding.arcanaBrainId).toBe(identity.brainId);
    expect(binding.arcanaRecipeVersion).toBe(1);
    const second = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(second.counts.already_current).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an identical replay (200) is also bound", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(200), ...real });
    expect(report.counts.bound).toBe(1);
    expect((await arcanaOf(agentId)).binding?.brainBinding?.state).toBe("bound");
  });

  it("waits for both entries: either one not ready is skipped without a call", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { commsState: "pending" });
    await seedAgent(companyId, { arcanaState: "in_progress" });
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(report.counts.skipped_comms_not_ready).toBe(1);
    expect(report.counts.skipped_arcana_not_ready).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never binds a sub Paperclip did not mint (legacy keyed or foreign board sub)", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { agentKey: "claude-code" });
    await seedAgent(companyId, { boardSub: "someone-else" });
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(report.counts.skipped_sub_not_minted).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a stored brain id that disagrees with the recipe is an identity_mismatch and sends nothing", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { arcanaExtra: { arcanaBrainId: `agent:${randomUUID()}` } });
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(report.counts.identity_mismatch).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a reissued identity binds its new generation sub", async () => {
    const companyId = await seedCompany();
    const { agentId, minted } = await seedAgent(companyId, { generation: 1 });
    expect(minted.boardSub.endsWith("-r1")).toBe(true);
    const fetchImpl = aca();
    await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${REGISTRY}/brain-bindings/${minted.boardSub}`);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body)).identity_generation).toBe(1);
    expect((await arcanaOf(agentId)).binding?.brainBinding?.boardSub).toBe(minted.boardSub);
  });

  it("a conflict is recorded once and not retried; retrySettled re-attempts it", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    const fetchImpl = aca(409);
    const first = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(first.counts.conflict).toBe(1);
    expect((await arcanaOf(agentId)).binding?.brainBinding?.state).toBe("conflict");
    const second = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(second.counts.conflict).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const retried = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(201), retrySettled: true, ...real });
    expect(retried.counts.bound).toBe(1);
    expect((await arcanaOf(agentId)).binding?.brainBinding?.state).toBe("bound");
  });

  it("403 and 422 settle as rejected", async () => {
    const companyId = await seedCompany();
    const a = await seedAgent(companyId);
    const b = await seedAgent(companyId);
    const status = (sub: string) => (sub === a.minted.boardSub ? 403 : 422);
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(status), ...real });
    expect(report.counts.rejected).toBe(2);
    expect((await arcanaOf(a.agentId)).binding?.brainBinding?.state).toBe("rejected");
    expect((await arcanaOf(b.agentId)).binding?.brainBinding?.state).toBe("rejected");
  });

  it("transient failures (401, 5xx, network) write nothing and the next run retries", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    for (const fetchImpl of [aca(401), aca(503), vi.fn(async () => { throw new Error("connect ECONNREFUSED aca.example.test"); })]) {
      const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: fetchImpl as never, ...real });
      expect(report.counts.bind_failed).toBe(1);
      expect((await arcanaOf(agentId)).binding?.brainBinding).toBeUndefined();
    }
    const ok = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(201), ...real });
    expect(ok.counts.bound).toBe(1);
  });

  it("without the binding token a real run makes no call", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: {} as NodeJS.ProcessEnv, fetchImpl, ...real });
    expect(report.counts.binding_not_configured).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("terminated agents are skipped", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { status: "terminated" });
    const fetchImpl = aca();
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(report.counts.skipped_terminated).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports counts and ids only, never the token, URL or board sub", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(201), ...real });
    const text = JSON.stringify(report);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("aca.example.test");
    expect(text).not.toContain("paperclip-agent-");
  });

  it("the sweep binds ready agents, skips settled ones, and is a no-op without the token", async () => {
    const companyId = await seedCompany();
    const ready = await seedAgent(companyId);
    await seedAgent(companyId, { commsState: "pending" });
    const settled = await seedAgent(companyId);
    const fetchImpl = aca(201);
    expect(await sweepBrainBindings(db, { env: {} as NodeJS.ProcessEnv, fetchImpl })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Settle one agent first (conflict) so the sweep must not touch it again.
    await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca((sub) => (sub === settled.minted.boardSub ? 409 : 500)), ...real });
    const sweepFetch = aca(201);
    await sweepBrainBindings(db, { env: ENV, fetchImpl: sweepFetch });
    const subs = sweepFetch.mock.calls.map(([url]) => String(url).split("/brain-bindings/")[1]);
    expect(subs).toContain(ready.minted.boardSub);
    expect(subs).not.toContain(settled.minted.boardSub);
    expect((await arcanaOf(ready.agentId)).binding?.brainBinding?.state).toBe("bound");
    // A second sweep has nothing left to do for the bound agent.
    const again = aca(201);
    await sweepBrainBindings(db, { env: ENV, fetchImpl: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("the sweep re-evaluates an agent whose board sub changed (reissue)", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    await sweepBrainBindings(db, { env: ENV, fetchImpl: aca(201) });
    expect((await arcanaOf(agentId)).binding?.brainBinding?.generation).toBe(0);
    const next = composeCommsBoardIdentity(agentId, 1)!;
    const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId));
    const metadata = JSON.parse(JSON.stringify(row!.metadata));
    metadata.defaultMcp.entries["comms-board"].identityGeneration = 1;
    metadata.defaultMcp.entries["comms-board"].binding.boardSub = next.boardSub;
    metadata.defaultMcp.entries["comms-board"].binding.baseSub = next.baseSub;
    await db.update(agents).set({ metadata }).where(eq(agents.id, agentId));
    const fetchImpl = aca(201);
    await sweepBrainBindings(db, { env: ENV, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(next.boardSub);
  });

  it("agents that can never be bound do not starve the sweep", async () => {
    const companyId = await seedCompany();
    for (let i = 0; i < 6; i++) await seedAgent(companyId, { agentKey: "legacy" });
    const good = await seedAgent(companyId, { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const fetchImpl = aca(201);
    // Batch of 3: the unbindable agents are walked past by the rotating cursor until the good one is reached.
    for (let i = 0; i < 6; i++) await sweepBrainBindings(db, { env: ENV, fetchImpl, limit: 3 });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split("/brain-bindings/")[1])).toEqual([good.minted.boardSub]);
    expect((await arcanaOf(good.agentId)).binding?.brainBinding?.state).toBe("bound");
  });

  it("pending_approval agents are skipped by the sweep and by the route", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { status: "pending_approval" });
    const fetchImpl = aca();
    await sweepBrainBindings(db, { env: ENV, fetchImpl });
    const report = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, ...real });
    expect(report.counts.skipped_pending_approval).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("paging: nextCursor resumes after the last scanned agent", async () => {
    const companyId = await seedCompany();
    for (let i = 0; i < 3; i++) await seedAgent(companyId);
    const fetchImpl = aca(201);
    const first = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, limit: 2, ...real });
    expect(first.scanned).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl, limit: 2, afterId: first.nextCursor!, ...real });
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("outcomes for archived companies, missing entries and a timeout", async () => {
    const companyId = await seedCompany();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await seedAgent(companyId);
    const archived = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(), ...real });
    expect(archived.counts.skipped_company_archived).toBe(1);

    const other = await seedCompany();
    await db.insert(agents).values({ companyId: other, name: "bare", role: "general", adapterType: "process", adapterConfig: {}, status: "idle" as never, metadata: {} });
    const bare = await backfillBrainBindings(db, { companyId: other, env: ENV, fetchImpl: aca(), ...real });
    expect(bare.counts.skipped_no_arcana_entry).toBe(1);

    const slow = await seedCompany();
    await seedAgent(slow);
    const timedOut = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const report = await backfillBrainBindings(db, { companyId: slow, env: ENV, fetchImpl: timedOut as never, ...real });
    expect(report.counts.bind_failed).toBe(1);
  });

  it("three transient failures in a row end the sweep tick; a success resets the count", async () => {
    const companyId = await seedCompany();
    for (let i = 0; i < 5; i++) await seedAgent(companyId);
    const down = aca(503);
    await sweepBrainBindings(db, { env: ENV, fetchImpl: down, limit: 25 });
    expect(down).toHaveBeenCalledTimes(3);
    __resetBrainBindingSweepForTests();
    let n = 0;
    const flaky = vi.fn(async () => new Response("{}", { status: ++n === 2 ? 503 : 201 }));
    await sweepBrainBindings(db, { env: ENV, fetchImpl: flaky as never, limit: 25 });
    expect(flaky).toHaveBeenCalledTimes(5);
  });

  it("retrySettled also re-attempts a rejection; without it a rejected agent makes no call", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgent(companyId);
    await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: aca(403), ...real });
    const quiet = aca(201);
    const skipped = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: quiet, ...real });
    expect(skipped.counts.rejected).toBe(1);
    expect(quiet).not.toHaveBeenCalled();
    const retried = await backfillBrainBindings(db, { companyId, env: ENV, fetchImpl: quiet, retrySettled: true, ...real });
    expect(retried.counts.bound).toBe(1);
    expect((await arcanaOf(agentId)).binding?.brainBinding?.state).toBe("bound");
  });
});
