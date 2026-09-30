import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { postgres } from "@paperclipai/db";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createPostgresCompanyMemoryDatabaseService,
  deriveCompanyMemoryDatabaseNames,
} from "./company-memory-databases.js";
import {
  companies,
  companySecrets,
  companySecretVersions,
  companyMemoryDatabases,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";

const runIntegration = process.env.PAPERCLIP_RUN_DOCKER_PGVECTOR_TESTS === "true";

describe.skipIf(!runIntegration)("company-memory-databases live PG17+pgvector Docker integration", () => {
  let containerName: string;
  let hostPort: number;
  let adminDsn: string;
  let adminClient: postgres.Sql;
  let db: any;
  let service: ReturnType<typeof createPostgresCompanyMemoryDatabaseService>;

  const companyA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const companyB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  beforeAll(async () => {
    containerName = `paperclip-test-pgvector-${randomBytes(4).toString("hex")}`;
    hostPort = 54330 + Math.floor(Math.random() * 100);

    // 1. Start disposable PG17 + pgvector container with log_statement=all and log_min_error_statement=error
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      "POSTGRES_PASSWORD=admin_super_secret_pw",
      "-p",
      `${hostPort}:5432`,
      "pgvector/pgvector:pg17",
      "-c",
      "log_statement=all",
      "-c",
      "log_min_error_statement=error",
    ]);

    // 2. Poll until PostgreSQL is ready
    let attempts = 0;
    const initialPlainDsn = `postgres://postgres:admin_super_secret_pw@127.0.0.1:${hostPort}/postgres?sslmode=disable`;
    while (attempts < 30) {
      try {
        const probeClient = postgres(initialPlainDsn, { max: 1, timeout: 2 });
        await probeClient`SELECT 1`;
        await probeClient.end();
        break;
      } catch {
        attempts++;
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 3. Configure SSL on container for strict sslmode=require enforcement
    execFileSync("docker", [
      "exec",
      containerName,
      "sh",
      "-c",
      "openssl req -new -x509 -days 365 -nodes -text -out /var/lib/postgresql/server.crt -keyout /var/lib/postgresql/server.key -subj '/CN=localhost' && chmod 600 /var/lib/postgresql/server.key && chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt",
    ]);

    execFileSync("docker", [
      "exec",
      containerName,
      "su",
      "-",
      "postgres",
      "-c",
      "psql -U postgres -c 'ALTER SYSTEM SET ssl = on;' -c 'ALTER SYSTEM SET ssl_cert_file = \"/var/lib/postgresql/server.crt\";' -c 'ALTER SYSTEM SET ssl_key_file = \"/var/lib/postgresql/server.key\";' -c 'SELECT pg_reload_conf();'",
    ]);

    adminDsn = `postgres://postgres:admin_super_secret_pw@127.0.0.1:${hostPort}/postgres?sslmode=require`;
    adminClient = postgres(adminDsn, { max: 1, idle_timeout: 10, ssl: { rejectUnauthorized: false } });

    // 4. Cluster Hardening: preinstall vector in template1, revoke PUBLIC CONNECT cluster-wide
    // Connect to template1 as admin to install vector extension
    const template1Client = postgres(`postgres://postgres:admin_super_secret_pw@127.0.0.1:${hostPort}/template1?sslmode=require`, {
      max: 1,
      idle_timeout: 10,
      ssl: { rejectUnauthorized: false },
    });
    await template1Client`CREATE EXTENSION IF NOT EXISTS vector;`;
    await template1Client`REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;`;
    await template1Client.end();

    await adminClient`REVOKE CONNECT ON DATABASE template0 FROM PUBLIC;`;
    await adminClient`REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;`;

    // 5. Create dedicated NON-SUPERUSER provisioner role with CREATEDB and CREATEROLE
    await adminClient`CREATE ROLE paperclip_provisioner WITH LOGIN NOINHERIT NOSUPERUSER CREATEDB CREATEROLE PASSWORD 'prov_pass_123';`;
    await adminClient`GRANT CONNECT ON DATABASE postgres TO paperclip_provisioner;`;

    // 6. Create control-plane tables for test on postgres database
    await adminClient.unsafe(`
      CREATE TABLE IF NOT EXISTS companies (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_secrets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        scope text DEFAULT 'company' NOT NULL,
        owner_user_id text,
        user_secret_definition_id uuid,
        key text NOT NULL,
        name text NOT NULL,
        provider text DEFAULT 'local_encrypted' NOT NULL,
        status text DEFAULT 'active' NOT NULL,
        managed_mode text DEFAULT 'paperclip_managed' NOT NULL,
        external_ref text,
        provider_config_id uuid,
        provider_metadata jsonb,
        latest_version integer DEFAULT 1 NOT NULL,
        description text,
        last_resolved_at timestamptz,
        last_rotated_at timestamptz,
        deleted_at timestamptz,
        created_by_agent_id uuid,
        created_by_user_id text,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_secret_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        secret_id uuid NOT NULL REFERENCES company_secrets(id) ON DELETE CASCADE,
        version integer NOT NULL,
        material jsonb NOT NULL,
        value_sha256 text NOT NULL,
        provider_version_ref text,
        status text DEFAULT 'current' NOT NULL,
        fingerprint_sha256 text NOT NULL,
        rotation_job_id text,
        created_by_agent_id uuid,
        created_by_user_id text,
        created_at timestamptz DEFAULT now() NOT NULL,
        revoked_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS company_memory_databases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
        database_name text NOT NULL UNIQUE,
        database_role text NOT NULL UNIQUE,
        host text NOT NULL,
        port integer DEFAULT 5432 NOT NULL,
        sslmode text DEFAULT 'require' NOT NULL,
        collection_name text DEFAULT 'mem0_memories' NOT NULL,
        embedding_model text DEFAULT 'text-embedding-3-small' NOT NULL,
        embedding_dimensions integer DEFAULT 1536 NOT NULL,
        secret_id uuid REFERENCES company_secrets(id) ON DELETE SET NULL,
        secret_version integer,
        status text DEFAULT 'pending' NOT NULL,
        last_provisioned_at timestamptz,
        last_rotated_at timestamptz,
        last_error text,
        operation text DEFAULT 'idle' NOT NULL,
        lease_token text,
        lease_owner text,
        lease_acquired_at timestamptz,
        lease_expires_at timestamptz,
        attempts integer DEFAULT 0 NOT NULL,
        backoff_until timestamptz,
        credential_epoch integer DEFAULT 1 NOT NULL,
        pending_secret_id uuid REFERENCES company_secrets(id) ON DELETE SET NULL,
        pending_secret_version integer,
        pending_scram_salt text,
        pending_scram_iterations integer,
        pending_scram_verifier text,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );

      GRANT ALL ON TABLE companies, company_secrets, company_secret_versions, company_memory_databases TO paperclip_provisioner;
    `);

    // Seed companies
    await adminClient`
      INSERT INTO companies (id, name) VALUES (${companyA}, 'Company A'), (${companyB}, 'Company B')
      ON CONFLICT (id) DO NOTHING;
    `;

    // 7. Connect provisioner client and initialize service strictly with non-superuser credentials
    const provisionerDsn = `postgres://paperclip_provisioner:prov_pass_123@127.0.0.1:${hostPort}/postgres?sslmode=require`;
    const provisionerDbClient = postgres(provisionerDsn, { max: 5, idle_timeout: 10, ssl: { rejectUnauthorized: false } });

    db = drizzle(provisionerDbClient);
    service = createPostgresCompanyMemoryDatabaseService(db, {
      enabled: true,
      adminDatabaseUrl: provisionerDsn,
      pilotCompanyIds: [companyA, companyB],
    });
  }, 30_000);

  afterAll(async () => {
    if (adminClient) {
      await adminClient.end().catch(() => {});
    }
    if (containerName) {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    }
  });

  it("provisions ready database and role, proving plaintext absent and verifier in DB logs", async () => {
    // Assert dedicated provisioner is NON-SUPERUSER with CREATEDB and CREATEROLE
    const checkSuper = await adminClient`
      SELECT rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles
      WHERE rolname = 'paperclip_provisioner';
    `;
    expect(checkSuper[0].rolsuper).toBe(false);
    expect(checkSuper[0].rolcreatedb).toBe(true);
    expect(checkSuper[0].rolcreaterole).toBe(true);

    const row = await service.ensureProvisioned(companyA);
    expect(row.status).toBe("ready");

    const runtime = await service.resolveRuntimeConfig(companyA);
    expect(runtime).not.toBeNull();
    const plaintextPassword = runtime!.password;

    // Assert provisioner does NOT retain CONNECT on tenant target database
    const provConnect = await adminClient`
      SELECT has_database_privilege('paperclip_provisioner', ${runtime!.dbname}, 'CONNECT') as has_connect;
    `;
    expect(provConnect[0].has_connect).toBe(false);

    // Allow Docker daemon to flush log buffer
    await new Promise((r) => setTimeout(r, 500));

    // Verify docker logs (capturing both stdout and stderr where Postgres emits query logs)
    const proc = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
    const dockerLogs = (proc.stdout ?? "") + "\n" + (proc.stderr ?? "");

    // CRITICAL: Plaintext password must NOT appear in Postgres logs
    expect(dockerLogs).not.toContain(plaintextPassword);

    // Documented residual: SCRAM-SHA-256 verifier IS present in DDL logs
    expect(dockerLogs).toContain("SCRAM-SHA-256$4096:");
  });

  it("verifies vector extension is inherited from template1 and usable by tenant", async () => {
    const runtime = await service.resolveRuntimeConfig(companyA);
    expect(runtime).not.toBeNull();

    const tenantUrl = `postgres://${runtime!.user}:${runtime!.password}@127.0.0.1:${hostPort}/${runtime!.dbname}?sslmode=require`;
    const tenantClient = postgres(tenantUrl, { max: 1, ssl: { rejectUnauthorized: false } });

    try {
      // Check extension exists
      const ext = await tenantClient`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      expect(ext.length).toBe(1);

      // Perform real vector operations
      await tenantClient`CREATE TABLE items (id serial primary key, vec vector(3));`;
      await tenantClient`INSERT INTO items (vec) VALUES ('[1,2,3]'), ('[4,5,6]');`;
      const nearest = await tenantClient`SELECT id FROM items ORDER BY vec <-> '[1,2,3]' LIMIT 1;`;
      expect(nearest[0].id).toBe(1);
    } finally {
      await tenantClient.end().catch(() => {});
    }
  });

  it("enforces that PUBLIC and tenant A cannot connect to non-target databases", async () => {
    const runtimeA = await service.resolveRuntimeConfig(companyA);
    await service.ensureProvisioned(companyB);
    const runtimeB = await service.resolveRuntimeConfig(companyB);

    const clientAToPostgres = postgres(`postgres://${runtimeA!.user}:${runtimeA!.password}@127.0.0.1:${hostPort}/postgres?sslmode=require`, {
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
    await expect(clientAToPostgres`SELECT 1`).rejects.toThrow(/permission denied/i);
    await clientAToPostgres.end().catch(() => {});

    const clientAToTemplate1 = postgres(`postgres://${runtimeA!.user}:${runtimeA!.password}@127.0.0.1:${hostPort}/template1?sslmode=require`, {
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
    await expect(clientAToTemplate1`SELECT 1`).rejects.toThrow(/permission denied/i);
    await clientAToTemplate1.end().catch(() => {});

    // Company A CANNOT connect to Company B's database
    const clientAToB = postgres(`postgres://${runtimeA!.user}:${runtimeA!.password}@127.0.0.1:${hostPort}/${runtimeB!.dbname}?sslmode=require`, {
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
    await expect(clientAToB`SELECT 1`).rejects.toThrow(/permission denied/i);
    await clientAToB.end().catch(() => {});
  });

  it("rotates credentials: old password fails and new password works", async () => {
    const runtimeBefore = await service.resolveRuntimeConfig(companyA);
    const oldPassword = runtimeBefore!.password;

    const rotated = await service.rotateCredential(companyA);
    expect(rotated.secretVersion).toBe(2);

    const runtimeAfter = await service.resolveRuntimeConfig(companyA);
    const newPassword = runtimeAfter!.password;
    expect(newPassword).not.toBe(oldPassword);

    // Old password connection must now fail
    const oldClient = postgres(`postgres://${runtimeBefore!.user}:${oldPassword}@127.0.0.1:${hostPort}/${runtimeBefore!.dbname}?sslmode=require`, {
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
    await expect(oldClient`SELECT 1`).rejects.toThrow(/authentication failed|password authentication/i);
    await oldClient.end().catch(() => {});

    // New password connection must succeed
    const newClient = postgres(`postgres://${runtimeAfter!.user}:${newPassword}@127.0.0.1:${hostPort}/${runtimeAfter!.dbname}?sslmode=require`, {
      max: 1,
      ssl: { rejectUnauthorized: false },
    });
    const res = await newClient`SELECT 1 as ok`;
    expect(res[0].ok).toBe(1);
    await newClient.end().catch(() => {});
  });

  it("handles lifecycle: archive forcefully disconnects active sessions and blocks new ones, unarchive restores connection, delete drops DB/role", async () => {
    const runtime = await service.resolveRuntimeConfig(companyA);
    expect(runtime).not.toBeNull();

    // Open active connection before archive
    const activeTenantConn = postgres(
      `postgres://${runtime!.user}:${runtime!.password}@127.0.0.1:${hostPort}/${runtime!.dbname}?sslmode=require`,
      { max: 1, ssl: { rejectUnauthorized: false } },
    );
    const activeRes = await activeTenantConn`SELECT 1 as connected`;
    expect(activeRes[0].connected).toBe(1);

    // 1. Archive company memory (must terminate active sessions and block new ones)
    await service.archiveCompanyMemory(companyA);

    const checkArchived = await db
      .select({ status: companyMemoryDatabases.status })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyA))
      .then((rows: any[]) => rows[0] ?? null);
    expect(checkArchived?.status).toBe("archived");

    // Existing active connection must be forcefully terminated
    await expect(activeTenantConn`SELECT 1`).rejects.toThrow();
    await activeTenantConn.end().catch(() => {});

    // New connection must also be denied while archived
    const clientWhileArchived = postgres(
      `postgres://${runtime!.user}:${runtime!.password}@127.0.0.1:${hostPort}/${runtime!.dbname}?sslmode=require`,
      { max: 1, ssl: { rejectUnauthorized: false } },
    );
    await expect(clientWhileArchived`SELECT 1`).rejects.toThrow();
    await clientWhileArchived.end().catch(() => {});

    // 2. Unarchive company memory
    await service.unarchiveCompanyMemory(companyA);

    const checkUnarchived = await db
      .select({ status: companyMemoryDatabases.status })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyA))
      .then((rows: any[]) => rows[0] ?? null);
    expect(checkUnarchived?.status).toBe("ready");

    // Connection must succeed after unarchive
    const clientAfterUnarchive = postgres(
      `postgres://${runtime!.user}:${runtime!.password}@127.0.0.1:${hostPort}/${runtime!.dbname}?sslmode=require`,
      { max: 1, ssl: { rejectUnauthorized: false } },
    );
    const okRes = await clientAfterUnarchive`SELECT 1 as ok`;
    expect(okRes[0].ok).toBe(1);
    await clientAfterUnarchive.end().catch(() => {});

    // 3. Delete company memory
    await service.deleteCompanyMemory(companyA);

    // Verify DB is dropped
    const remainingDb = await adminClient`SELECT 1 FROM pg_database WHERE datname = ${runtime!.dbname}`;
    expect(remainingDb.length).toBe(0);

    // Verify Role is dropped
    const remainingRole = await adminClient`SELECT 1 FROM pg_roles WHERE rolname = ${runtime!.user}`;
    expect(remainingRole.length).toBe(0);

    // Verify tombstone row in mapping table is retained with status deprovisioned
    const tombstone = await db
      .select({ status: companyMemoryDatabases.status })
      .from(companyMemoryDatabases)
      .where(eq(companyMemoryDatabases.companyId, companyA))
      .then((rows: any[]) => rows[0] ?? null);
    expect(tombstone?.status).toBe("deprovisioned");
  });

  it("recovers from simulated rotation crash where ALTER ROLE executed before secret activation", async () => {
    // 1. Ensure companyB is provisioned and ready
    const row = await service.ensureProvisioned(companyB);
    expect(row.status).toBe("ready");
    const runtimeB = await service.resolveRuntimeConfig(companyB);
    const oldPassword = runtimeB!.password;

    // 2. Simulate crash during rotation:
    // Generate new password, prepare secret, save pending metadata, run ALTER ROLE, then simulate crash (leave pending version disabled and mapping status failed)
    const { databaseRole } = deriveCompanyMemoryDatabaseNames(companyB);
    const crashNewPassword = "crash_recovery_password_99999!";
    const { generateScramVerifier } = await import("./scram-verifier.js");
    const scram = generateScramVerifier(crashNewPassword);

    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, row.secretId!))
      .then((rows: any[]) => rows[0]);
    const pendingVersion = secret.latestVersion + 1;

    const { getSecretProvider } = await import("../secrets/provider-registry.js");
    const prepared = await getSecretProvider("local_encrypted").createSecret({ value: crashNewPassword });

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: pendingVersion,
      status: "disabled",
      material: prepared.material,
      valueSha256: prepared.valueSha256,
      fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
      providerVersionRef: null,
    });

    // Update mapping with pending metadata and simulate failed status from interrupted run
    await db
      .update(companyMemoryDatabases)
      .set({
        status: "failed",
        operation: "idle",
        pendingSecretId: secret.id,
        pendingSecretVersion: pendingVersion,
        pendingScramSalt: scram.saltBase64,
        pendingScramIterations: scram.iterations,
        pendingScramVerifier: scram.verifier,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(companyMemoryDatabases.id, row.id));

    // Execute ALTER ROLE so the database role has the new password, but Paperclip crashed before activating it
    const { quoteIdentifier } = await import("./company-memory-databases.js");
    await adminClient.unsafe(
      `ALTER ROLE ${quoteIdentifier(databaseRole)} WITH PASSWORD '${scram.verifier}';`,
    );

    // 3. Resolve runtime config on companyB — must detect pending rotation, recover it, and return the new password
    const recovered = await service.resolveRuntimeConfig(companyB);
    expect(recovered).not.toBeNull();
    expect(recovered!.password).toBe(crashNewPassword);
    expect(recovered!.password).not.toBe(oldPassword);

    // Verify connecting with the recovered password succeeds
    const recoveredClient = postgres(
      `postgres://${recovered!.user}:${recovered!.password}@127.0.0.1:${hostPort}/${recovered!.dbname}?sslmode=require`,
      { max: 1, ssl: { rejectUnauthorized: false } },
    );
    const res = await recoveredClient`SELECT 1 as ok`;
    expect(res[0].ok).toBe(1);
    await recoveredClient.end().catch(() => {});
  });

  it("handles concurrent ensure provisioning calls safely without unique constraint collision", async () => {
    // Run two concurrent ensureProvisioned calls on companyB
    const [res1, res2] = await Promise.all([
      service.ensureProvisioned(companyB),
      service.ensureProvisioned(companyB),
    ]);

    expect(res1.status).toBe("ready");
    expect(res2.status).toBe("ready");
    expect(res1.databaseName).toBe(res2.databaseName);
  });
});
