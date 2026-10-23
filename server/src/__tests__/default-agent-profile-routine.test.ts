import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, routineRevisions, routines, routineTriggers } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  AGENT_PROFILE_ROUTINE_ORIGIN_KIND,
  __resetAgentProfileRoutineBackoffForTests,
  agentProfileCronFor,
  buildAgentProfileRoutineDescription,
  ensureAgentProfileRoutine,
  isDefaultAgentProfileRoutineEnabled,
  sweepAgentProfileRoutines,
} from "../services/default-agent-profile-routine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ON = { PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED: "true", PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED: "true" };
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const PROFILE_DOC = "skills/paperclip/references/agent-profile-upkeep.md";

/** Full text of the `## ` section whose header (without the `## ` prefix) matches, or null when absent. */
const sectionOf = (markdown: string, header: RegExp): string | null => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^##\s/.test(line) && header.test(line.replace(/^##\s/, "")));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

describe("agent profile routine: pure parts", () => {
  it("is off unless exactly true", () => {
    expect(isDefaultAgentProfileRoutineEnabled({})).toBe(false);
    expect(isDefaultAgentProfileRoutineEnabled({ PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED: "yes" })).toBe(false);
    expect(isDefaultAgentProfileRoutineEnabled({ PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED: " TRUE " })).toBe(true);
  });

  it("derives a stable daily cron in the 07-10 UTC window", () => {
    const id = randomUUID();
    expect(agentProfileCronFor(id)).toBe(agentProfileCronFor(id));
    for (let i = 0; i < 50; i += 1) {
      const m = /^(\d+) (\d+) \* \* \*$/.exec(agentProfileCronFor(randomUUID()));
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThan(60);
      expect(Number(m![2])).toBeGreaterThanOrEqual(7);
      expect(Number(m![2])).toBeLessThanOrEqual(10);
    }
  });

  it("carries the hard guard rails and points at the skill reference", () => {
    const text = buildAgentProfileRoutineDescription();
    for (const needle of [
      "references/agent-profile-upkeep.md",
      "arcana_source_add",
      "secrets",
      "PHI",
      "PII",
      "8000",
      "proposals_get",
      "do nothing",
      "untrusted",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toContain("arcana_source_revise");
  });

  it("ships the procedure with the guard rails, and the revise-not-supported rule", () => {
    const doc = fs.readFileSync(path.join(repoRoot, PROFILE_DOC), "utf8");
    for (const needle of [
      "arcana_source_add",
      "arcana-source:agent-profile",
      "proposals_get",
      "8000",
      "PHI",
      "Do not submit `arcana_source_revise`",
      "Source document: agent-profile.md",
      "zero hits means it does not",
      "sha256",
    ]) {
      expect(doc, needle).toContain(needle);
    }
    expect(doc).not.toContain("open_source` with `agent-profile` to");
    expect(fs.readFileSync(path.join(repoRoot, "skills/paperclip/references/arcana-brain-proposals.md"), "utf8")).toContain(
      "agent-profile-upkeep.md",
    );
  });

  it("leaves a pending or applying profile proposal alone, and tracks the proposal id without a list tool", () => {
    const doc = fs.readFileSync(path.join(repoRoot, PROFILE_DOC), "utf8");
    // Only the two proposal tools exist; the id is tracked in the run comment, not via a list tool.
    expect(doc).toMatch(/only[^\n]{0,120}proposals_submit[^\n]{0,80}proposals_get/);
    expect(doc).toMatch(/no list tool/);
    expect(doc).toMatch(/track[^\n]{0,160}proposal_id|proposal_id[^\n]{0,160}track/);
    const steps = sectionOf(doc, /^Steps$/);
    expect(steps, "## Steps section").toBeTruthy();
    const stepsSection = steps ?? "";
    // Pending or applying: do nothing, no pokes, no resubmission.
    expect(stepsSection).toMatch(/pending/);
    expect(stepsSection).toMatch(/applying/);
    expect(stepsSection).toMatch(/(?:do not|don't)[^\n]{0,60}(?:resubmit|poke)/);
  });

  it("treats an existing profile as a NOOP, forbids duplicate profiles, and states the configured, unproven age policy", () => {
    const doc = fs.readFileSync(path.join(repoRoot, PROFILE_DOC), "utf8");
    const updating = sectionOf(doc, /Updating/);
    expect(updating, "## Updating section").toBeTruthy();
    const updatingSection = updating ?? "";
    // Current revise status: accepted at submission and fails at apply (apply_failed), no submit rejection.
    expect(updatingSection).toMatch(/accepted[^\n]{0,60}submi|submi[^\n]{0,60}accepted/i);
    expect(updatingSection).toMatch(/fail[^\n]{0,60}apply|apply[^\n]{0,60}fail/i);
    expect(updatingSection).toContain("apply_failed");
    expect(updatingSection).not.toMatch(/reject[^\n]{0,40}submi|submi[^\n]{0,40}reject/i);
    expect(doc).not.toContain("ARCANA_SOURCE_REVISE_ENABLED");
    expect(doc).not.toMatch(/422/);

    // An existing profile means the routine does nothing.
    expect(updatingSection).toMatch(/exists[^\n]{0,200}(?:NOOP|do nothing)|(?:NOOP|do nothing)[^\n]{0,200}exists/i);
    // Never work around a stale profile with a duplicate logical id.
    expect(updatingSection).toMatch(/(?:never|do not|don't)[^\n]{0,200}(?:work around|duplicate|agent-profile-2)/i);
    for (const mention of updatingSection.match(/[^.\n]{0,200}agent-profile-\d[^.\n]{0,200}/gi) ?? []) {
      expect(mention, mention).toMatch(/\b(?:never|do not|don't|no)\b/i);
    }
    // The minimum age is configured, and the policy stays unproven pending DEV proof.
    expect(updatingSection).toMatch(/min(?:imum)?\s+age|age\s+(?:threshold|gate|policy|clock)/i);
    expect(updatingSection).toMatch(/configur/i);
    expect(updatingSection).toMatch(/unproven|unsettled|not (?:yet )?(?:proven|verified|settled)|pending DEV/i);
    // No fixed 24-hour/day age promise survives: every fixed-age clause must be a disclaimer.
    for (const clause of updatingSection.match(
      /[^.\n]{0,240}(?:24[-\s]hours?|day-long|day of manual approvals|age clock)[^.\n]{0,240}/gi,
    ) ?? []) {
      expect(clause, clause).toMatch(
        /\b(?:not|never|no longer|instead|rather|unlike|unproven|do not|don't|cannot)\b/i,
      );
    }
  });
});

describeEmbeddedPostgres("sweepAgentProfileRoutines", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-agent-profile-routine-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    __resetAgentProfileRoutineBackoffForTests();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRevisions);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const entry = (state: string) => ({ setup: { state }, dedicated: true });
  const ready = { defaultMcp: { version: 1, entries: { "comms-board": entry("ready"), "arcana-brain": entry("ready") } } };

  async function seedCompany(opts: { responsible?: boolean; status?: "active" | "archived" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: opts.responsible === false ? null : randomUUID(),
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, over: { status?: string; metadata?: unknown } = {}) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent-${id.slice(0, 6)}`,
      role: "engineer",
      status: over.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: (over.metadata ?? ready) as Record<string, unknown>,
    });
    return id;
  }

  const routinesFor = (companyId: string) => db.select().from(routines).where(eq(routines.companyId, companyId));

  it("does nothing while the flag, or the default-MCP spec, is off", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);
    expect(await sweepAgentProfileRoutines(db, { env: {} })).toEqual({ created: 0, archived: 0 });
    expect(await sweepAgentProfileRoutines(db, { env: { PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED: "true" } })).toEqual({ created: 0, archived: 0 });
    expect(await routinesFor(companyId)).toHaveLength(0);
  });

  it("creates one daily routine per eligible agent, idempotently, and skips ineligible agents", async () => {
    const companyId = await seedCompany();
    const eligible = await seedAgent(companyId);
    const running = await seedAgent(companyId, { status: "running" });
    await seedAgent(companyId, { status: "paused" });
    await seedAgent(companyId, { status: "terminated" });
    await seedAgent(companyId, { status: "pending_approval" });
    await seedAgent(companyId, { metadata: { defaultMcp: { version: 1, entries: { "comms-board": entry("pending"), "arcana-brain": entry("ready") } } } }); // owner_required etc.
    await seedAgent(companyId, { metadata: { defaultMcp: { version: 1, entries: { "comms-board": entry("ready") } } } }); // no Arcana
    await seedAgent(companyId, { metadata: {} });
    const archivedCompany = await seedCompany({ status: "archived" });
    await seedAgent(archivedCompany);

    expect(await sweepAgentProfileRoutines(db, { env: ON })).toEqual({ created: 2, archived: 0 });
    expect(await sweepAgentProfileRoutines(db, { env: ON })).toEqual({ created: 0, archived: 0 });

    const rows = await routinesFor(companyId);
    expect(rows.map((r) => r.assigneeAgentId).sort()).toEqual([eligible, running].sort());
    for (const row of rows) {
      expect(row.originKind).toBe(AGENT_PROFILE_ROUTINE_ORIGIN_KIND);
      expect(row.originId).toBe(row.assigneeAgentId);
      expect(row.status).toBe("active");
      expect(row.concurrencyPolicy).toBe("skip_if_active");
      expect(row.description).toContain("references/agent-profile-upkeep.md");
      const triggers = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id));
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.kind).toBe("schedule");
      expect(triggers[0]!.timezone).toBe("UTC");
      expect(triggers[0]!.cronExpression).toBe(agentProfileCronFor(row.assigneeAgentId!));
      expect(triggers[0]!.enabled).toBe(true);
    }
    expect(await routinesFor(archivedCompany)).toHaveLength(0);
  });

  it("picks up a new agent that becomes ready later (new-agent path)", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId, { metadata: { defaultMcp: { version: 1, entries: { "comms-board": entry("pending"), "arcana-brain": entry("pending") } } } });
    expect((await sweepAgentProfileRoutines(db, { env: ON })).created).toBe(0);
    await db.update(agents).set({ metadata: ready }).where(eq(agents.id, id));
    expect((await sweepAgentProfileRoutines(db, { env: ON })).created).toBe(1);
  });

  it("never recreates or revives a routine an owner archived or paused", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId);
    await sweepAgentProfileRoutines(db, { env: ON });
    await db.update(routines).set({ status: "archived" }).where(eq(routines.companyId, companyId));
    expect(await sweepAgentProfileRoutines(db, { env: ON })).toEqual({ created: 0, archived: 0 });
    const rows = await routinesFor(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("archived");
    expect(rows[0]!.assigneeAgentId).toBe(id);
  });

  it("serialises concurrent creation to one routine", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const results = await Promise.all([1, 2, 3].map(() => ensureAgentProfileRoutine(db, { companyId, agentId })));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(await routinesFor(companyId)).toHaveLength(1);
  });

  it("archives the routine of a terminated agent", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId);
    await sweepAgentProfileRoutines(db, { env: ON });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, id));
    expect((await sweepAgentProfileRoutines(db, { env: ON })).archived).toBe(1);
    expect((await routinesFor(companyId))[0]!.status).toBe("archived");
  });

  it("isolates a failing agent (no responsible user) and backs off without blocking others", async () => {
    const bad = await seedCompany({ responsible: false });
    const good = await seedCompany();
    await seedAgent(bad);
    await seedAgent(good);
    const first = await sweepAgentProfileRoutines(db, { env: ON, now: 1_000 });
    expect(first.created).toBe(1);
    expect(await routinesFor(bad)).toHaveLength(0);
    expect(await routinesFor(good)).toHaveLength(1);
    // Backed off: a later sweep inside the window does not retry (no repeated failures).
    expect((await sweepAgentProfileRoutines(db, { env: ON, now: 2_000 })).created).toBe(0);
  });

  it("honours an allowlist rollout scope", async () => {
    const inScope = await seedCompany();
    const outScope = await seedCompany();
    await seedAgent(inScope);
    await seedAgent(outScope);
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS: inScope });
    expect((await sweepAgentProfileRoutines(db, { env: ON })).created).toBe(1);
    expect(await routinesFor(outScope)).toHaveLength(0);
  });
});
