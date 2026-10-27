import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0378_invite_owner_handoff.sql";
const migrationSql = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite owner handoff migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("invite owner handoff migration (TECH-7952)", () => {
  it("adds the provenance columns and rejects provenance without a bound email", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-invite-owner-handoff-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // Replay 0378 against a schema that predates it.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
    await sql`ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_owner_handoff_requires_bound_email_check"`;
    await sql`ALTER TABLE "invites" DROP COLUMN IF EXISTS "owner_handoff_issued_by_user_id"`;
    await sql`ALTER TABLE "invites" DROP COLUMN IF EXISTS "bound_email"`;

    const columnsBefore = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'invites'
    `;
    expect(columnsBefore.map((row) => row.column_name)).not.toContain("bound_email");

    await applyPendingMigrations(database.connectionString);

    const columnsAfter = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'invites'
        AND column_name IN ('bound_email', 'owner_handoff_issued_by_user_id')
      ORDER BY column_name
    `;
    expect(columnsAfter).toEqual([
      { column_name: "bound_email", is_nullable: "YES", data_type: "text" },
      { column_name: "owner_handoff_issued_by_user_id", is_nullable: "YES", data_type: "text" },
    ]);

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Handoff migration', 'HOM')`;

    const insertInvite = (options: {
      boundEmail?: string | null;
      issuedBy?: string | null;
    }) => {
      const tokenHash = randomUUID().replace(/-/g, "");
      return sql`
        INSERT INTO "invites" (
          "company_id", "invite_type", "allowed_join_types", "token_hash",
          "bound_email", "owner_handoff_issued_by_user_id", "expires_at"
        ) VALUES (
          ${companyId}, 'company_join', 'human', ${tokenHash},
          ${options.boundEmail ?? null}, ${options.issuedBy ?? null}, now() + interval '1 hour'
        )
        RETURNING "id"
      `;
    };

    // A plain invite: neither column set.
    await expect(insertInvite({})).resolves.toHaveLength(1);

    // A bound email without provenance is allowed (shared-company binding).
    await expect(insertInvite({ boundEmail: "owner@example.com" })).resolves.toHaveLength(1);

    // Provenance with a bound email is the handoff shape.
    await expect(
      insertInvite({ boundEmail: "owner@example.com", issuedBy: randomUUID() }),
    ).resolves.toHaveLength(1);

    // Provenance without a bound email violates the check (SQLSTATE 23514).
    await expect(insertInvite({ issuedBy: randomUUID() })).rejects.toMatchObject({ code: "23514" });

    // The same invariant holds on update: clearing bound_email on a handoff row is refused.
    const [handoff] = await insertInvite({ boundEmail: "owner@example.com", issuedBy: randomUUID() });
    await expect(sql`
      UPDATE "invites" SET "bound_email" = NULL WHERE "id" = ${handoff!.id}
    `).rejects.toMatchObject({ code: "23514" });

    const [constraint] = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invites'::regclass AND contype = 'c'
        AND conname = 'invites_owner_handoff_requires_bound_email_check'
    `;
    expect(constraint?.conname).toBe("invites_owner_handoff_requires_bound_email_check");
  }, 90_000);

  it("is idempotent: re-running it on a database that already has the objects (e.g. applied under the old 0293 number) is a no-op", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-invite-owner-handoff-idempotent-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // The harness has already applied the migration once; run its statements twice more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        await sql.unsafe(statement);
      }
    }
    const constraints = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invites'::regclass AND conname = 'invites_owner_handoff_requires_bound_email_check'
    `;
    expect(constraints).toHaveLength(1);
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'invites' AND column_name IN ('bound_email', 'owner_handoff_issued_by_user_id')
    `;
    expect(columns).toHaveLength(2);
  }, 90_000);
});
