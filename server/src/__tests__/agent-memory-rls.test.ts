import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  plugins,
  runWithTenantContext,
  setAmbientCompanyId,
  type Db,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
  validatePluginMigrationStatement,
} from "../services/plugin-database.js";

/**
 * TECH-6956: proves the RH agent-memory plugin's tenant isolation holds at the
 * database level, not just in its own SQL.
 *
 * TECH-6955 built this plugin because Paperclip's native `plugin_entities`
 * store allowed cross-tenant overwrites. Its own tests (tests/fake-db.ts)
 * assert every statement filters on `company_id` -- but they assert it
 * *textually*, against an in-memory fake. Nothing in that suite executes a
 * single statement against a real Postgres, so nothing there would notice if
 * the filter were correct and the database still let a different query through.
 *
 * This test closes that gap from the other direction: it applies the real
 * migrations through the real host validator and then attacks the table with
 * raw SQL that deliberately has NO company filter at all.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-memory RLS tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const PLUGIN_ID = "redesignhealth.plugin-rh-agent-memory";
const NAMESPACE_SLUG = "rh_agent_memory";
const APP_ROLE = "agent_memory_rls_role";
const APP_ROLE_PASSWORD = "agent_memory_rls_password";
const SETTING = "app.current_company_id";

function agentMemoryManifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_ID,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "RH Agent Memory",
    description: "Tenant-isolated per-agent key/value memory.",
    author: "Redesign Health",
    categories: ["workspace", "automation"],
    capabilities: [
      "agent.tools.register",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "activity.log.write",
    ],
    entrypoints: { worker: "./dist/worker.js" },
    database: {
      namespaceSlug: NAMESPACE_SLUG,
      migrationsDir: "migrations",
      coreReadTables: ["companies"],
    },
  } as PaperclipPluginManifestV1;
}

describe("agent-memory plugin RLS statement validation", () => {
  it("accepts the RLS DDL through the production plugin-migration validator", () => {
    const namespace = derivePluginDatabaseNamespace(PLUGIN_ID, NAMESPACE_SLUG);
    // The validator originally rejected `CREATE POLICY` outright: `ON` is not
    // one of its qualified-ref keywords, so a fully qualified policy
    // statement still extracted zero refs and failed the "must use fully
    // qualified schema names" gate. TECH-6956 taught it the shape; this
    // pins that so the plugin migration cannot silently stop applying.
    expect(() =>
      validatePluginMigrationStatement(
        `ALTER TABLE ${namespace}.agent_memory ENABLE ROW LEVEL SECURITY`,
        namespace,
        ["companies"],
      ),
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `CREATE POLICY tenant_isolation ON ${namespace}.agent_memory FOR ALL ` +
          `USING (company_id = nullif(current_setting('${SETTING}', true), '')::uuid)`,
        namespace,
        ["companies"],
      ),
    ).not.toThrow();
  });

  it("still refuses a policy attached to a core table", () => {
    const namespace = derivePluginDatabaseNamespace(PLUGIN_ID, NAMESPACE_SLUG);
    // Widening the validator to allow CREATE POLICY must not let a plugin
    // attach policies to Paperclip's own tables -- that would let a plugin
    // redefine core tenant isolation rather than just its own.
    expect(() =>
      validatePluginMigrationStatement(
        `CREATE POLICY sneaky ON public.companies FOR ALL USING (true)`,
        namespace,
        ["companies"],
      ),
    ).toThrow(/cannot mutate or define objects in public\.companies/);
  });
});

describeEmbeddedPostgres("agent-memory plugin tenant isolation in Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  /** Owner (superuser here) -- schema setup, seeding, unfiltered verification. */
  let owner: Db;
  /** The non-superuser role that RLS actually applies to. */
  let app: Db;
  let namespace: string;

  const companyA = randomUUID();
  const companyB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();

  /**
   * Runs `statement` through the app role inside a transaction whose session
   * has been scoped by the PRODUCTION path: an ambient tenant context plus
   * `createDb`'s transaction wrapper, exactly as a plugin RPC gets scoped at
   * runtime (plugin-host-services.ts#ensureCompanyId +
   * plugin-loader.ts#withPerInvocationTenantContext).
   *
   * Hand-writing `set_config` here instead would have tested a convention
   * rather than the wiring -- and the wiring is the part that can break.
   */
  async function asCompany(companyId: string, statement: string) {
    return await runWithTenantContext(async () => {
      setAmbientCompanyId(companyId);
      return await app.transaction(async (tx) => await tx.execute(sql.raw(statement)));
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-memory-rls-");
    owner = createDb(tempDb.connectionString);

    const manifest = agentMemoryManifest();
    namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database?.namespaceSlug);

    await owner.insert(companies).values([
      { id: companyA, name: "Company A", issuePrefix: "AAA" },
      { id: companyB, name: "Company B", issuePrefix: "BBB" },
    ]);

    const pluginId = randomUUID();
    await owner.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });

    // The real migration directory, applied through the real host path -- so
    // 002_agent_memory_rls.sql has to survive the production validator rather
    // than a test-local copy of it.
    const repoRoot =
      path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "plugin-rh-agent-memory");
    await pluginDatabaseService(owner).applyMigrations(pluginId, manifest, packageRoot);

    // Embedded Postgres runs as the initdb bootstrap SUPERUSER, and
    // superusers bypass RLS unconditionally -- FORCE does not change that.
    // Probing as that role would make every assertion below vacuous, so the
    // suite creates a role RLS genuinely applies to.
    await owner.execute(
      sql.raw(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
            CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'
              NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
        END
        $$;`),
    );
    await owner.execute(sql.raw(`GRANT USAGE ON SCHEMA "${namespace}" TO ${APP_ROLE}`));
    await owner.execute(
      sql.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${namespace}" TO ${APP_ROLE}`,
      ),
    );

    // Seeded as the owner, which is not subject to the policy here -- so both
    // rows exist unconditionally and a later zero-row result can only mean
    // "RLS filtered it", never "nothing was written".
    await owner.execute(
      sql.raw(
        `INSERT INTO "${namespace}".agent_memory (company_id, agent_id, memory_key, value_json)
         VALUES ('${companyA}', '${agentA}', 'secret', '"company-a-value"'::jsonb),
                ('${companyB}', '${agentB}', 'secret', '"company-b-value"'::jsonb)`,
      ),
    );

    const appUrl = new URL(tempDb.connectionString);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_ROLE_PASSWORD;
    app = createDb(appUrl.toString());
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("probes as a role that row-level security applies to", async () => {
    const rows = (await app.execute(
      sql.raw(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
    )) as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
    // Guards every assertion below: a superuser or BYPASSRLS role would sail
    // straight through the policies and the suite would pass for no reason.
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it("enables and FORCEs RLS on agent_memory", async () => {
    const rows = (await owner.execute(
      sql.raw(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${namespace}' AND c.relname = 'agent_memory'`,
      ),
    )) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    // FORCE matters because Paperclip creates this schema as the same role it
    // serves traffic with, and Postgres exempts a table's owner otherwise.
    expect(rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("hides another company's memory from a query with no tenant filter at all", async () => {
    // Deliberately NO company_id or agent_id predicate. This is the query a
    // future bug writes, and the point of the backstop is that it still
    // cannot cross the tenant boundary.
    const rows = (await asCompany(
      companyA,
      `SELECT company_id, value_json FROM "${namespace}".agent_memory`,
    )) as unknown as Array<{ company_id: string; value_json: unknown }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(companyA);
    expect(rows[0]?.value_json).toBe("company-a-value");
  });

  it("returns zero rows -- not an error -- for a direct cross-tenant read", async () => {
    const rows = (await asCompany(
      companyA,
      `SELECT count(*)::int AS count FROM "${namespace}".agent_memory WHERE company_id = '${companyB}'`,
    )) as unknown as Array<{ count: number }>;
    // A USING clause filters rows out silently; it does not raise. Zero is
    // the correct expectation for a read.
    expect(rows[0]?.count).toBe(0);

    const actual = (await owner.execute(
      sql.raw(
        `SELECT count(*)::int AS count FROM "${namespace}".agent_memory WHERE company_id = '${companyB}'`,
      ),
    )) as unknown as Array<{ count: number }>;
    // Company B's row is there the whole time. This is what makes the zero
    // above meaningful rather than indistinguishable from an empty table.
    expect(actual[0]?.count).toBe(1);
  });

  it("blocks a cross-tenant overwrite -- the exact TECH-6955 failure mode", async () => {
    // The native plugin_entities bug was a cross-tenant OVERWRITE: one
    // company's write landing on another company's row. The UPDATE below
    // matches no visible row, so it changes nothing.
    await asCompany(
      companyA,
      `UPDATE "${namespace}".agent_memory SET value_json = '"hijacked"'::jsonb
        WHERE memory_key = 'secret' AND company_id = '${companyB}'`,
    );

    const rows = (await owner.execute(
      sql.raw(
        `SELECT value_json FROM "${namespace}".agent_memory WHERE company_id = '${companyB}'`,
      ),
    )) as unknown as Array<{ value_json: unknown }>;
    // Verified from the owner connection, which the policy does not filter --
    // so this confirms the row genuinely survived, not merely that it was
    // invisible to the app role.
    expect(rows[0]?.value_json).toBe("company-b-value");
  });

  it("raises on an insert into another company", async () => {
    // WITH CHECK errors rather than filtering, unlike USING. A silently
    // discarded write would leave the caller believing it succeeded.
    const error = await asCompany(
      companyA,
      `INSERT INTO "${namespace}".agent_memory (company_id, agent_id, memory_key, value_json)
       VALUES ('${companyB}', '${agentB}', 'planted', '"x"'::jsonb)`,
    ).then(
      () => null,
      (caught: unknown) => caught as Error,
    );

    expect(error).not.toBeNull();
    // drizzle wraps driver errors as `Failed query: <sql>` and keeps the real
    // Postgres error on `cause`, so asserting on the top-level message would
    // pass for ANY failing statement -- including a typo in the fixture SQL.
    // The cause is where "new row violates row-level security policy" lives.
    const cause = error?.cause as Error | undefined;
    expect(cause?.message).toMatch(/row-level security policy/i);

    const rows = (await owner.execute(
      sql.raw(
        `SELECT count(*)::int AS count FROM "${namespace}".agent_memory WHERE memory_key = 'planted'`,
      ),
    )) as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(0);
  });
});
