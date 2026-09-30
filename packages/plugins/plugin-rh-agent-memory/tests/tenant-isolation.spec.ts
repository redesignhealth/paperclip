import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest, {
  EXPECTED_DB_NAMESPACE,
  MEMORY_DELETE_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_LIST_TOOL,
  MEMORY_SET_TOOL,
  MEMORY_TOOL_NAMES,
  NAMESPACE_SLUG,
  PLUGIN_ID,
} from "../src/manifest.js";
import plugin, { registerMemoryTools } from "../src/worker.js";
import {
  MissingRunContextTenantError,
  TenantParameterInjectionError,
  assertNoTenantParams,
  requireTenant,
  resolveTenant,
} from "../src/tenant.js";
import { getMemory, listMemory, setMemory } from "../src/store.js";
import { createFakeDb, type FakeDb } from "./fake-db.js";

// "Victim" tenant — the agent whose memory an attacker wants to reach.
const VICTIM_COMPANY = "11111111-1111-4111-8111-111111111111";
const VICTIM_AGENT = "22222222-2222-4222-8222-222222222222";
// "Attacker" tenant — the run context the host actually validated.
const ATTACKER_COMPANY = "99999999-9999-4999-8999-999999999999";
const ATTACKER_AGENT = "88888888-8888-4888-8888-888888888888";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

function attackerRunContext() {
  return { companyId: ATTACKER_COMPANY, agentId: ATTACKER_AGENT, runId: RUN_ID, projectId: PROJECT_ID };
}

function victimRunContext() {
  return { companyId: VICTIM_COMPANY, agentId: VICTIM_AGENT, runId: RUN_ID, projectId: PROJECT_ID };
}

let harness: TestHarness;
let db: FakeDb;

beforeEach(async () => {
  harness = createTestHarness({ manifest });
  db = createFakeDb();
  // Same override pattern plugin-llm-wiki's own tests use, but backed by a
  // store that really evaluates the bound tenant parameters.
  harness.ctx.db = db;
  registerMemoryTools(harness.ctx);
});

function seedVictimSecret(key = "okta-refresh-token", value: unknown = "victim-secret-value") {
  db.seed({ company_id: VICTIM_COMPANY, agent_id: VICTIM_AGENT, memory_key: key, value_json: value });
}

// ---------------------------------------------------------------------------
// THE ATTACK. This is the test that does not exist for any of Paperclip's
// three native per-agent storage mechanisms.
// ---------------------------------------------------------------------------

describe("cross-tenant parameter injection (the plugin-llm-wiki vulnerability class)", () => {
  it("rejects memory_get when a foreign companyId is supplied as a tool parameter", async () => {
    seedVictimSecret();

    const result = await harness.executeTool<ToolResult>(
      MEMORY_GET_TOOL,
      { key: "okta-refresh-token", companyId: VICTIM_COMPANY },
      attackerRunContext(),
    );

    expect(result.error).toMatch(/tenant identity may not be passed as a parameter/i);
    expect(result.error).toContain("companyId");
    expect(result.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("victim-secret-value");
    // The call died before any SQL ran.
    expect(db.statements).toHaveLength(0);
  });

  it("rejects memory_get when a foreign agentId is supplied as a tool parameter", async () => {
    seedVictimSecret();

    const result = await harness.executeTool<ToolResult>(
      MEMORY_GET_TOOL,
      { key: "okta-refresh-token", agentId: VICTIM_AGENT },
      // Same company, different agent — the narrower attack.
      { ...victimRunContext(), agentId: ATTACKER_AGENT },
    );

    expect(result.error).toContain("agentId");
    expect(JSON.stringify(result)).not.toContain("victim-secret-value");
    expect(db.statements).toHaveLength(0);
  });

  it.each([
    ["company_id", { key: "k", company_id: VICTIM_COMPANY }],
    ["companyID", { key: "k", companyID: VICTIM_COMPANY }],
    ["company-id", { key: "k", "company-id": VICTIM_COMPANY }],
    ["agent_id", { key: "k", agent_id: VICTIM_AGENT }],
    ["tenantId", { key: "k", tenantId: VICTIM_COMPANY }],
    ["scopeId", { key: "k", scopeId: VICTIM_COMPANY }],
    ["runId", { key: "k", runId: RUN_ID }],
    ["projectId", { key: "k", projectId: PROJECT_ID }],
    ["userId", { key: "k", userId: VICTIM_AGENT }],
  ])("rejects the %s parameter alias", async (_label, params) => {
    const result = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, params, attackerRunContext());
    expect(result.error).toMatch(/tenant identity may not be passed as a parameter/i);
    expect(db.statements).toHaveLength(0);
  });

  it("rejects a tenant parameter even when it MATCHES the real runContext", async () => {
    // No silent tolerance: a model sending tenancy at all is a signal.
    const result = await harness.executeTool<ToolResult>(
      MEMORY_GET_TOOL,
      { key: "k", companyId: ATTACKER_COMPANY },
      attackerRunContext(),
    );
    expect(result.error).toMatch(/tenant identity may not be passed as a parameter/i);
  });

  it("refuses to let memory_set write into another tenant's row", async () => {
    seedVictimSecret("shared-key", "victim-original");

    const result = await harness.executeTool<ToolResult>(
      MEMORY_SET_TOOL,
      { key: "shared-key", value: "attacker-overwrite", companyId: VICTIM_COMPANY, agentId: VICTIM_AGENT },
      attackerRunContext(),
    );

    expect(result.error).toMatch(/tenant identity may not be passed as a parameter/i);
    // The victim's row is untouched. (This is the plugin_entities
    // NULLS-NOT-DISTINCT overwrite scenario, which cannot happen here.)
    expect(db.rowsFor(VICTIM_COMPANY, VICTIM_AGENT)).toEqual([
      expect.objectContaining({ memory_key: "shared-key", value_json: "victim-original" }),
    ]);
    expect(db.rowsFor(ATTACKER_COMPANY, ATTACKER_AGENT)).toEqual([]);
  });

  it("refuses to let memory_delete destroy another tenant's row", async () => {
    seedVictimSecret("shared-key", "victim-original");

    const result = await harness.executeTool<ToolResult>(
      MEMORY_DELETE_TOOL,
      { key: "shared-key", companyId: VICTIM_COMPANY },
      attackerRunContext(),
    );

    expect(result.error).toMatch(/tenant identity may not be passed as a parameter/i);
    expect(db.rowsFor(VICTIM_COMPANY, VICTIM_AGENT)).toHaveLength(1);
  });

  it("records a rejected injection attempt in the activity log", async () => {
    await harness.executeTool<ToolResult>(
      MEMORY_GET_TOOL,
      { key: "k", companyId: VICTIM_COMPANY },
      attackerRunContext(),
    );

    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]?.message).toContain("rejected a memory_get call");
    // Audited against the attacker's own (host-validated) company, never the
    // company they claimed in the parameter.
    expect(harness.activity[0]).toMatchObject({ companyId: ATTACKER_COMPANY });
    expect(harness.activity[0]).not.toMatchObject({ companyId: VICTIM_COMPANY });
    expect(harness.activity[0]?.metadata).toMatchObject({
      tool: MEMORY_GET_TOOL,
      rejectedKeys: ["companyId"],
      runContextCompanyId: ATTACKER_COMPANY,
      runContextAgentId: ATTACKER_AGENT,
    });
    expect(harness.logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  /**
   * Belt and braces: even if the reject layer were removed, the store layer
   * still cannot be pointed at a foreign tenant, because the tenant argument is
   * derived from `runCtx` and the params object is never consulted. Here we
   * call the store directly with a tenant resolved ONLY from the attacker's
   * runContext, while a foreign companyId sits in the params object.
   */
  it("derives the tenant from runContext even with the reject layer bypassed", async () => {
    seedVictimSecret();
    const maliciousParams = { key: "okta-refresh-token", companyId: VICTIM_COMPANY, agentId: VICTIM_AGENT };
    const tenant = resolveTenant(attackerRunContext());

    expect(tenant).toEqual({ companyId: ATTACKER_COMPANY, agentId: ATTACKER_AGENT });
    // `resolveTenant` has no parameter through which `maliciousParams` could
    // reach it; assert the values it produced are unrelated to them.
    expect(tenant.companyId).not.toBe(maliciousParams.companyId);
    expect(tenant.agentId).not.toBe(maliciousParams.agentId);

    const record = await getMemory(db, tenant, String(maliciousParams.key));
    expect(record).toBeNull();

    const [statement] = db.statements;
    expect(statement?.params).toEqual([ATTACKER_COMPANY, ATTACKER_AGENT, "okta-refresh-token"]);
    expect(statement?.params).not.toContain(VICTIM_COMPANY);
    expect(statement?.params).not.toContain(VICTIM_AGENT);
  });

  it("keeps two tenants' identical keys completely separate end to end", async () => {
    await harness.executeTool(MEMORY_SET_TOOL, { key: "notes", value: "victim notes" }, victimRunContext());
    await harness.executeTool(MEMORY_SET_TOOL, { key: "notes", value: "attacker notes" }, attackerRunContext());

    const victimRead = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "notes" }, victimRunContext());
    const attackerRead = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "notes" }, attackerRunContext());

    expect(victimRead.content).toBe(JSON.stringify("victim notes"));
    expect(attackerRead.content).toBe(JSON.stringify("attacker notes"));
    expect(db.allRows()).toHaveLength(2);

    const attackerList = await harness.executeTool<ToolResult>(MEMORY_LIST_TOOL, {}, attackerRunContext());
    expect(attackerList.data).toMatchObject({ count: 1 });
    expect(JSON.stringify(attackerList.data)).not.toContain("victim notes");
  });

  it("isolates two agents inside the same company", async () => {
    const agentB = { ...victimRunContext(), agentId: "55555555-5555-4555-8555-555555555555" };
    await harness.executeTool(MEMORY_SET_TOOL, { key: "notes", value: "agent-a" }, victimRunContext());
    await harness.executeTool(MEMORY_SET_TOOL, { key: "notes", value: "agent-b" }, agentB);

    const readB = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "notes" }, agentB);
    expect(readB.content).toBe(JSON.stringify("agent-b"));
    expect(db.rowsFor(VICTIM_COMPANY, VICTIM_AGENT)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runContext validation
// ---------------------------------------------------------------------------

describe("runContext validation", () => {
  it("fails closed when the host supplies no runContext tenant", async () => {
    const result = await harness.executeTool<ToolResult>(
      MEMORY_GET_TOOL,
      { key: "k" },
      { companyId: "", agentId: "", runId: RUN_ID, projectId: PROJECT_ID },
    );
    expect(result.error).toMatch(/runContext\.companyId is missing or is not a UUID/);
    expect(db.statements).toHaveLength(0);
  });

  it("fails closed when runContext.agentId is not a UUID", () => {
    expect(() => resolveTenant({ ...attackerRunContext(), agentId: "not-a-uuid" }))
      .toThrow(MissingRunContextTenantError);
  });

  it("fails closed on a null runContext", () => {
    expect(() => resolveTenant(null)).toThrow(MissingRunContextTenantError);
  });

  it("normalizes runContext identifiers to lowercase and returns a frozen tenant", () => {
    const tenant = resolveTenant({ ...attackerRunContext(), companyId: ATTACKER_COMPANY.toUpperCase() });
    expect(tenant.companyId).toBe(ATTACKER_COMPANY);
    expect(Object.isFrozen(tenant)).toBe(true);
  });

  it("accepts a clean params object", () => {
    expect(() => assertNoTenantParams({ key: "k", value: 1, limit: 10 })).not.toThrow();
    expect(() => assertNoTenantParams(null)).not.toThrow();
    expect(requireTenant({ key: "k" }, attackerRunContext())).toEqual({
      companyId: ATTACKER_COMPANY,
      agentId: ATTACKER_AGENT,
    });
  });

  it("reports every rejected key, sorted", () => {
    try {
      assertNoTenantParams({ key: "k", agentId: "a", companyId: "c" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TenantParameterInjectionError);
      expect((error as TenantParameterInjectionError).rejectedKeys).toEqual(["agentId", "companyId"]);
    }
  });
});

// ---------------------------------------------------------------------------
// SQL scoping invariants
// ---------------------------------------------------------------------------

describe("SQL scoping invariants", () => {
  it("scopes every statement by company_id AND agent_id, in that bind order", async () => {
    await harness.executeTool(MEMORY_SET_TOOL, { key: "a", value: 1 }, attackerRunContext());
    await harness.executeTool(MEMORY_GET_TOOL, { key: "a" }, attackerRunContext());
    await harness.executeTool(MEMORY_LIST_TOOL, {}, attackerRunContext());
    await harness.executeTool(MEMORY_DELETE_TOOL, { key: "a" }, attackerRunContext());

    expect(db.statements).toHaveLength(4);
    for (const statement of db.statements) {
      const flat = statement.sql.replace(/\s+/g, " ");
      // createFakeDb already throws if these are absent; assert explicitly too.
      expect(flat).toMatch(/company_id = \$1/);
      expect(flat).toMatch(/agent_id = \$2/);
      expect(statement.params[0]).toBe(ATTACKER_COMPANY);
      expect(statement.params[1]).toBe(ATTACKER_AGENT);
      // Tenant values are bound, never interpolated into the SQL text.
      expect(flat).not.toContain(ATTACKER_COMPANY);
      expect(flat).not.toContain(ATTACKER_AGENT);
    }
  });

  it("targets the (company_id, agent_id, memory_key) unique index on upsert", async () => {
    await harness.executeTool(MEMORY_SET_TOOL, { key: "a", value: 1 }, attackerRunContext());
    const flat = db.statements[0]?.sql.replace(/\s+/g, " ") ?? "";
    expect(flat).toContain("ON CONFLICT (company_id, agent_id, memory_key)");
  });

  it("quotes the host-derived namespace and rejects an unsafe one", async () => {
    await harness.executeTool(MEMORY_GET_TOOL, { key: "a" }, attackerRunContext());
    expect(db.statements[0]?.sql).toContain(`"${EXPECTED_DB_NAMESPACE}"."agent_memory"`);

    const unsafe = createFakeDb('evil"; DROP SCHEMA public; --');
    await expect(getMemory(unsafe, resolveTenant(attackerRunContext()), "a"))
      .rejects.toThrow(/Unsafe plugin database namespace/);
  });
});

// ---------------------------------------------------------------------------
// Functional behavior
// ---------------------------------------------------------------------------

describe("memory tool behavior", () => {
  it("round-trips get / set / list / delete", async () => {
    const run = attackerRunContext();

    const missing = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "prefs" }, run);
    expect(missing.data).toMatchObject({ found: false, key: "prefs", value: null });

    await harness.executeTool(MEMORY_SET_TOOL, { key: "prefs", value: { theme: "dark", pins: [1, 2] } }, run);
    const found = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "prefs" }, run);
    expect(found.data).toMatchObject({ found: true, key: "prefs", value: { theme: "dark", pins: [1, 2] } });

    await harness.executeTool(MEMORY_SET_TOOL, { key: "other", value: null }, run);
    const list = await harness.executeTool<ToolResult>(MEMORY_LIST_TOOL, {}, run);
    expect(list.data).toMatchObject({ count: 2, limit: 100 });
    expect((list.data as { entries: Array<{ key: string }> }).entries.map((e) => e.key)).toEqual(["other", "prefs"]);

    const deleted = await harness.executeTool<ToolResult>(MEMORY_DELETE_TOOL, { key: "prefs" }, run);
    expect(deleted.data).toMatchObject({ key: "prefs", deleted: true });
    const reDeleted = await harness.executeTool<ToolResult>(MEMORY_DELETE_TOOL, { key: "prefs" }, run);
    expect(reDeleted.data).toMatchObject({ deleted: false });
  });

  it("overwrites in place rather than duplicating", async () => {
    const run = attackerRunContext();
    await harness.executeTool(MEMORY_SET_TOOL, { key: "k", value: "v1" }, run);
    await harness.executeTool(MEMORY_SET_TOOL, { key: "k", value: "v2" }, run);
    expect(db.rowsFor(ATTACKER_COMPANY, ATTACKER_AGENT)).toHaveLength(1);
    const read = await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "k" }, run);
    expect(read.content).toBe(JSON.stringify("v2"));
  });

  it("clamps and defaults the list limit", async () => {
    const tenant = resolveTenant(attackerRunContext());
    await listMemory(db, tenant, 100);
    await setMemory(db, tenant, "k", JSON.stringify("v"));

    const clamped = await harness.executeTool<ToolResult>(MEMORY_LIST_TOOL, { limit: 9_999 }, attackerRunContext());
    expect(clamped.data).toMatchObject({ limit: 500 });
    const defaulted = await harness.executeTool<ToolResult>(MEMORY_LIST_TOOL, { limit: -5 }, attackerRunContext());
    expect(defaulted.data).toMatchObject({ limit: 100 });
  });

  it("returns errors instead of throwing for bad input", async () => {
    const run = attackerRunContext();
    expect((await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "" }, run)).error)
      .toMatch(/must not be blank/);
    expect((await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, {}, run)).error)
      .toMatch(/`key` is required/);
    expect((await harness.executeTool<ToolResult>(MEMORY_GET_TOOL, { key: "x".repeat(513) }, run)).error)
      .toMatch(/at most 512 characters/);
    expect((await harness.executeTool<ToolResult>(MEMORY_SET_TOOL, { key: "k" }, run)).error)
      .toMatch(/`value` is required/);
    expect((await harness.executeTool<ToolResult>(MEMORY_SET_TOOL, { key: "k", value: "x".repeat(300_000) }, run)).error)
      .toMatch(/exceeds the \d+-byte limit/);
    // Nothing was written by any of the failed calls.
    expect(db.allRows()).toHaveLength(0);
  });

  it("rejects a value containing a cycle", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await harness.executeTool<ToolResult>(
      MEMORY_SET_TOOL,
      { key: "k", value: cyclic },
      attackerRunContext(),
    );
    expect(result.error).toMatch(/JSON-serializable/);
  });
});

// ---------------------------------------------------------------------------
// Manifest contract
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("declares the four memory tools and the database namespace capabilities", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBeUndefined();
    expect(manifest.database?.namespaceSlug).toBe(NAMESPACE_SLUG);
    expect(manifest.database?.migrationsDir).toBe("migrations");
    // Only `companies`, and only to satisfy the migration's ON DELETE CASCADE
    // FK. No runtime query joins a core table.
    expect(manifest.database?.coreReadTables).toEqual(["companies"]);
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([...MEMORY_TOOL_NAMES]);
    for (const capability of [
      "agent.tools.register",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
    ] as const) {
      expect(manifest.capabilities).toContain(capability);
    }
  });

  it("never exposes a tenant-identity property in any tool's parameter schema", () => {
    for (const tool of manifest.tools ?? []) {
      const schema = tool.parametersSchema as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
      expect(schema.additionalProperties).toBe(false);
      const propertyNames = Object.keys(schema.properties ?? {});
      // Every declared property must survive the injection guard.
      expect(() => assertNoTenantParams(Object.fromEntries(propertyNames.map((name) => [name, 1]))))
        .not.toThrow();
    }
  });

  it("keeps the migration schema name in sync with the host derivation", async () => {
    const { readFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10);
    expect(EXPECTED_DB_NAMESPACE).toBe(`plugin_${NAMESPACE_SLUG}_${hash}`);

    const sql = readFileSync(new URL("../migrations/001_agent_memory.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${EXPECTED_DB_NAMESPACE}.agent_memory`);
    expect(sql).toContain("company_id uuid NOT NULL");
    expect(sql).toContain("agent_id uuid NOT NULL");
    expect(sql).toContain("UNIQUE (company_id, agent_id, memory_key)");
    expect(sql).toContain("(company_id, agent_id)");
  });

  it("exports a worker that registers all four tools on setup", async () => {
    const setupHarness = createTestHarness({ manifest });
    setupHarness.ctx.db = createFakeDb();
    await plugin.definition.setup(setupHarness.ctx);
    for (const name of MEMORY_TOOL_NAMES) {
      const result = await setupHarness.executeTool<ToolResult>(name, { key: "k", value: 1 }, attackerRunContext());
      expect(result.error).toBeUndefined();
    }
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok" });
  });
});
