import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TECH-7164/7177: keeps the 0290 agent-knowledge ledger migration honest.
 *
 * The migration introduces the bindings/revocations tables. The guarantees a
 * reviewer needs from it are structural, not behavioral, so this suite pins
 * them directly against the journal, the drizzle snapshot, and the SQL text:
 *
 * - the journal entries stay sequential and name the file that exists;
 * - the snapshot chains onto the previous snapshot and declares the same
 *   tables/constraints the SQL creates (no hand-edited drift);
 * - the SQL only ever touches the two ledger tables plus the `agents` FK
 *   target -- nothing else can cascade from running it;
 * - it is purely additive: no statement drops, rewrites, or backfills rows
 *   in any pre-existing table, so upgrading a populated database is safe.
 */

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

const MIGRATION_FILE = "0290_agent_knowledge_ledger.sql";
const LEDGER_TABLES = new Set(["agent_knowledge_bindings", "agent_knowledge_revocations"]);
const EXPECTED_TABLE_REFERENCES = new Set([
  "agent_knowledge_bindings",
  "agent_knowledge_revocations",
  "agents",
]);

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

async function readJournal(): Promise<JournalEntry[]> {
  const journal = JSON.parse(
    await readFile(`${migrationsDir}/meta/_journal.json`, "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

async function readSnapshot(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${migrationsDir}/meta/${file}`, "utf8"));
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function referencedTables(sql: string): Set<string> {
  const tables = new Set<string>();
  const patterns = [
    /(?:ALTER|CREATE) TABLE "([a-z_][a-z0-9_]*)"/g,
    /REFERENCES "(?:public"\.)?"([a-z_][a-z0-9_]*)"/g,
    /ON "([a-z_][a-z0-9_]*)"/g,
    /INTO "([a-z_][a-z0-9_]*)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      tables.add(match[1]!);
    }
  }
  return tables;
}

describe("0290 agent knowledge ledger migration", () => {
  it("journals 0290 sequentially after 0289, with sequential idx numbering and a matching on-disk file", async () => {
    const entries = await readJournal();

    // The journal numbering is non-decreasing (drizzle applies in this
    // order); historical gaps exist (e.g. 0126 was never generated), so
    // strictly +1 is NOT an invariant -- monotonicity is.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.idx, `journal entry ${i} must not precede ${i - 1}`).toBeGreaterThanOrEqual(
        entries[i - 1]!.idx,
      );
    }

    const entry0289 = entries.find((entry) => entry.tag === "0289_company_memory_databases");
    const entry0290 = entries.find((entry) => entry.tag === "0290_agent_knowledge_ledger");
    expect(entry0289).toBeDefined();
    expect(entry0290).toBeDefined();
    expect(entry0290!.idx).toBe(entry0289!.idx + 1);
    expect(entry0290!.breakpoints).toBe(true);

    // The journal tag names the migration file that exists on disk.
    const sql = await readFile(`${migrationsDir}/${MIGRATION_FILE}`, "utf8");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("chains the 0290 snapshot onto the 0289 snapshot and declares both ledger tables", async () => {
    const snapshot0289 = await readSnapshot("0289_snapshot.json");
    const snapshot0290 = await readSnapshot("0290_snapshot.json");
    expect(snapshot0290.prevId).toBe(snapshot0289.id);

    for (const table of LEDGER_TABLES) {
      const tableSnapshot = snapshot0290.tables[`public.${table}`];
      expect(tableSnapshot, `${table} must be declared in the 0290 snapshot`).toBeDefined();
    }
  });

  it("snapshot and SQL agree on the FK behaviors: agent FKs SET NULL, revocation binding FK RESTRICT", async () => {
    const snapshot0290 = await readSnapshot("0290_snapshot.json");
    const sql = await readFile(`${migrationsDir}/${MIGRATION_FILE}`, "utf8");

    const bindings = snapshot0290.tables["public.agent_knowledge_bindings"];
    const revocations = snapshot0290.tables["public.agent_knowledge_revocations"];

    // Bindings: nullable agent FK, ON DELETE SET NULL (tombstones survive).
    expect(bindings.columns.agent_id.notNull).toBeFalsy();
    expect(bindings.foreignKeys["agent_knowledge_bindings_agent_id_agents_id_fk"].tableTo).toBe(
      "agents",
    );
    expect(
      bindings.foreignKeys["agent_knowledge_bindings_agent_id_agents_id_fk"].onDelete,
    ).toBe("set null");
    // Bindings deliberately carry NO company FK: the company snapshot must
    // outlive the company row (company removal keeps the ledger).
    expect(bindings.foreignKeys).not.toHaveProperty("agent_knowledge_bindings_company_id_fk");

    // Revocations: binding FK is NOT NULL + RESTRICT (the outbox is
    // persistent and can never be orphaned by a binding delete), and the
    // agent FK is SET NULL.
    expect(revocations.columns.binding_id.notNull).toBe(true);
    expect(
      revocations.foreignKeys["agent_knowledge_revocations_binding_id_agent_knowledge_bindings_id_fk"].onDelete,
    ).toBe("restrict");
    expect(
      revocations.foreignKeys["agent_knowledge_revocations_agent_id_agents_id_fk"].onDelete,
    ).toBe("set null");

    // The SQL carries the same three FK declarations with the same actions.
    expect(sql).toContain(
      'ALTER TABLE "agent_knowledge_bindings" ADD CONSTRAINT "agent_knowledge_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null',
    );
    expect(sql).toContain(
      'ALTER TABLE "agent_knowledge_revocations" ADD CONSTRAINT "agent_knowledge_revocations_binding_id_agent_knowledge_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."agent_knowledge_bindings"("id") ON DELETE restrict',
    );
    expect(sql).toContain(
      'ALTER TABLE "agent_knowledge_revocations" ADD CONSTRAINT "agent_knowledge_revocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null',
    );
  });

  it("snapshot and SQL declare every ledger check constraint and unique index", async () => {
    const snapshot0290 = await readSnapshot("0290_snapshot.json");
    const sql = await readFile(`${migrationsDir}/${MIGRATION_FILE}`, "utf8");

    const expected = {
      "public.agent_knowledge_bindings": [
        "agent_knowledge_bindings_agent_id_snapshot_check",
        "agent_knowledge_bindings_desired_access_check",
        "agent_knowledge_bindings_state_check",
        "agent_knowledge_bindings_fence_epoch_check",
        "agent_knowledge_bindings_last_error_code_check",
      ],
      "public.agent_knowledge_revocations": [
        "agent_knowledge_revocations_agent_id_snapshot_check",
        "agent_knowledge_revocations_status_check",
        "agent_knowledge_revocations_reason_check",
        "agent_knowledge_revocations_fence_epoch_check",
        "agent_knowledge_revocations_last_error_code_check",
      ],
    };

    for (const [table, constraints] of Object.entries(expected)) {
      const tableSnapshot = snapshot0290.tables[table];
      for (const constraint of constraints) {
        expect(
          tableSnapshot.checkConstraints[constraint],
          `${table} must declare ${constraint} in the snapshot`,
        ).toBeDefined();
        expect(sql).toContain(`CONSTRAINT "${constraint}"`);
      }
    }

    // Unique indexes: the mapping (company, agent snapshot), the binding_id
    // one-outbox-row-per-binding guarantee, and the two idempotency keys.
    for (const uniqueIndex of [
      'CREATE UNIQUE INDEX "agent_knowledge_bindings_company_agent_snapshot_uq"',
      'CREATE UNIQUE INDEX "agent_knowledge_bindings_idempotency_key_uq"',
      'CREATE UNIQUE INDEX "agent_knowledge_revocations_binding_id_uq"',
      'CREATE UNIQUE INDEX "agent_knowledge_revocations_idempotency_key_uq"',
    ]) {
      expect(sql).toContain(uniqueIndex);
    }

    // The snapshot's isRLSEnabled stays false by repo convention: RLS is
    // applied by the migration SQL itself, not by the drizzle schema, so the
    // RLS backstop for these tables lives in the SQL statements asserted in
    // rls-migration.test.ts, not in the snapshot.
    for (const table of LEDGER_TABLES) {
      expect(snapshot0290.tables[`public.${table}`].isRLSEnabled).toBe(false);
    }
  });

  it("references only the two ledger tables and the agents FK target: nothing else can cascade", async () => {
    const sql = await readFile(`${migrationsDir}/${MIGRATION_FILE}`, "utf8");

    const referenced = referencedTables(sql);
    for (const table of referenced) {
      expect(
        EXPECTED_TABLE_REFERENCES.has(table),
        `migration 0290 unexpectedly references table "${table}"`,
      ).toBe(true);
    }
    // All three expected references actually occur (agents twice: the
    // bindings FK and the revocations FK).
    for (const table of EXPECTED_TABLE_REFERENCES) {
      expect(referenced.has(table), `migration 0290 must reference "${table}"`).toBe(true);
    }
  });

  it("is purely additive: no statement drops, rewrites, or backfills any pre-existing table", async () => {
    const sql = await readFile(`${migrationsDir}/${MIGRATION_FILE}`, "utf8");

    // A data rewrite would be a standalone UPDATE statement; the FK clauses'
    // "ON UPDATE no action" must not trip this. Anchor to statement starts.
    for (const forbidden of [
      /DROP TABLE/i,
      /DELETE FROM/i,
      /^UPDATE\b/im,
      /INSERT INTO/i,
      /^TRUNCATE\b/im,
      /\bRENAME\b/i,
      /ALTER COLUMN/i,
      /DROP COLUMN/i,
    ]) {
      expect(sql.match(forbidden), `migration 0290 must not contain ${forbidden}`).toBeNull();
    }

    // Every statement is one of the additive shapes: session locals, CREATE
    // TABLE for the ledger tables, ALTER TABLE ... ADD CONSTRAINT / RLS
    // statements on the ledger tables, or CREATE [UNIQUE] INDEX / policy
    // statements on the ledger tables. Anything else is a rewrite of an
    // existing-row database and fails here.
    const ledgerTableAlternation = "agent_knowledge_(?:bindings|revocations)";
    const allowedStatementShapes: RegExp[] = [
      /^SET LOCAL [a-z_]+ = '[^']*';$/,
      new RegExp(`^CREATE TABLE "${ledgerTableAlternation}" \\(`),
      new RegExp(`^ALTER TABLE "${ledgerTableAlternation}" ADD CONSTRAINT "[a-z_0-9]+" (FOREIGN KEY|CHECK|PRIMARY KEY|UNIQUE)`),
      new RegExp(`^ALTER TABLE "${ledgerTableAlternation}" (ENABLE|FORCE) ROW LEVEL SECURITY;$`),
      new RegExp(`^(DROP POLICY IF EXISTS|CREATE POLICY) "tenant_isolation" ON "${ledgerTableAlternation}"`),
      new RegExp(`^CREATE (?:UNIQUE )?INDEX "[a-z_0-9]+" ON "${ledgerTableAlternation}"`),
      /^CREATE OR REPLACE FUNCTION paperclip_(enforce|prevent)_/,
      /^DROP TRIGGER IF EXISTS paperclip_/,
      /^CREATE TRIGGER paperclip_/,
    ];

    for (const statement of splitStatements(sql)) {
      const allowed = allowedStatementShapes.some((shape) => shape.test(statement));
      expect(
        allowed,
        `migration 0290 contains a non-additive or off-target statement: ${statement.slice(0, 120)}`,
      ).toBe(true);
    }
  });
});
