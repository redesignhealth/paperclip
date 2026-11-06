import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectEnvironmentSecrets,
  hasFlag,
  parseFlag,
  redactSampleData,
  sampleMem0MemoryContent,
  validateAndResolveTableIdentifier,
  validateOutputPath,
  validateRedactPrefixChars,
  main,
} from "../sample-mem0-memory-content.js";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../packages/db/src/index.js";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { sql } = require("drizzle-orm");

describe("sample-mem0-memory-content unit & contract tests", () => {
  it("parses CLI flags correctly", () => {
    const argv = ["node", "script.js", "--out", "/tmp/out.json", "--limit", "25", "--table", "custom_table"];
    assert.equal(parseFlag("--out", argv), "/tmp/out.json");
    assert.equal(parseFlag("--limit", argv), "25");
    assert.equal(parseFlag("--table", argv), "custom_table");
    assert.equal(parseFlag("--agent", argv), null);
    assert.equal(hasFlag("--company", argv), false);
    assert.equal(hasFlag("--limit", argv), true);
  });

  it("validates and resolves bare and schema-qualified table identifiers", () => {
    // Bare valid identifier
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("mem0_memories", sql));
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("custom_memories_v2", sql));

    // Schema-qualified valid identifier
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("public.mem0_memories", sql));
    assert.doesNotThrow(() => validateAndResolveTableIdentifier("tenant_01.mem0_memories", sql));

    // Invalid identifiers should be rejected
    assert.throws(
      () => validateAndResolveTableIdentifier("mem0; DROP TABLE users;--", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("public.mem0.extra", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("123invalid", sql),
      /Invalid --table value/,
    );
    assert.throws(
      () => validateAndResolveTableIdentifier("has space", sql),
      /Invalid --table value/,
    );
  });

  it("validates redact prefix character counts", () => {
    assert.equal(validateRedactPrefixChars(null), 16);
    assert.equal(validateRedactPrefixChars("0"), 0);
    assert.equal(validateRedactPrefixChars("24"), 24);

    assert.throws(() => validateRedactPrefixChars("-1"), /Must be a non-negative integer/);
    assert.throws(() => validateRedactPrefixChars("foo"), /Must be a non-negative integer/);
    assert.throws(() => validateRedactPrefixChars("3.14"), /Must be a non-negative integer/);
  });

  it("masks prefixes and scrubs environment secrets", () => {
    const secrets = ["super_secret_token", "db_password_xyz"];

    // Standard prefix masking
    const res1 = redactSampleData("User preference is dark mode", secrets, 16);
    assert.equal(res1, "[REDACTED_16_CHARS]is dark mode");

    // Short data smaller than prefix
    const res2 = redactSampleData("Short", secrets, 16);
    assert.equal(res2, "[REDACTED_5_CHARS]");

    // Zero prefix: no prefix characters masked, but secrets scrubbed
    const res3 = redactSampleData("User token is super_secret_token for auth", secrets, 0);
    assert.equal(res3, "User token is ***REDACTED*** for auth");

    // Masking plus secret scrubbing
    const res4 = redactSampleData("The password was db_password_xyz confirmed", secrets, 12);
    assert.ok(res4.startsWith("[REDACTED_12_CHARS]"));
    assert.ok(!res4.includes("db_password_xyz"));
    assert.ok(res4.includes("***REDACTED***"));

    // Empty data returns empty
    assert.equal(redactSampleData("", secrets, 16), "");
  });

  it("collects secrets and extracts password components from connection URLs", () => {
    const fakeEnv = {
      API_KEY: "secret_api_key_12345",
      AUTH_TOKEN: "jwt_bearer_token_9999",
      SERVICE_PASSWORD: "plain_password_xyz",
      DATABASE_URL: "postgres://user:url_password_secret@localhost:5432/db",
      COMPANY_MEMORY_DATABASE_URL: "postgres://tenant:company_db_secret@localhost:5432/mem",
      PUBLIC_WEB_URL: "https://example.com/api",
      SHORT: "abc", // < 4 chars, ignored
    };

    const secrets = collectEnvironmentSecrets(fakeEnv);
    assert.ok(secrets.includes("secret_api_key_12345"));
    assert.ok(secrets.includes("jwt_bearer_token_9999"));
    assert.ok(secrets.includes("plain_password_xyz"));
    assert.ok(secrets.includes("url_password_secret"));
    assert.ok(secrets.includes("company_db_secret"));
    assert.ok(!secrets.includes("https://example.com/api"));
    assert.ok(!secrets.includes("abc"));
  });

  it("refuses output paths inside the repository worktree, missing parents, and symlinked parents into the repo", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

    // Relative inside repo
    assert.throws(
      () => validateOutputPath("sample-export.json", repoRoot),
      /Refusing to write output inside repository/,
    );

    // Absolute inside repo
    const insidePath = path.join(repoRoot, "scripts", "out.json");
    assert.throws(
      () => validateOutputPath(insidePath, repoRoot),
      /Refusing to write output inside repository/,
    );

    // Missing parent directory rejected
    const missingParentOut = path.join(
      os.tmpdir(),
      `nonexistent-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "out.json",
    );
    assert.throws(
      () => validateOutputPath(missingParentOut, repoRoot),
      /Parent directory does not exist/,
    );

    // Parent directory that is a symlink into the repo rejected
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-symlink-test-"));
    try {
      const symlinkParent = path.join(tmpDir, "repo-link");
      fs.symlinkSync(repoRoot, symlinkParent, "dir");
      assert.throws(
        () => validateOutputPath(path.join(symlinkParent, "out.json"), repoRoot),
        /Refusing to write output inside repository via symlinked parent/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Normal temp dir accepted
    const validOut = path.join(os.tmpdir(), `mem0-test-${Date.now()}.json`);
    const resolved = validateOutputPath(validOut, repoRoot);
    assert.equal(resolved, path.resolve(validOut));
  });

  it("CLI main() rejects --company selector", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;

    try {
      await main(["node", "script.js", "--company", "comp_01"]);
      assert.ok(errorLogged.includes("The --company selector has been removed"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
  });

  it("CLI main() rejects missing --out and --limit flags", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;

    try {
      await main(["node", "script.js"]);
      assert.ok(errorLogged.includes("Refuses to run without explicit --out and --limit"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
    }
  });

  it("CLI main() rejects missing database URL without control-plane fallback", async () => {
    let errorLogged = "";
    const origError = console.error;
    console.error = (msg: string) => {
      errorLogged += msg;
    };
    const origExitCode = process.exitCode;
    const origEnv = process.env.COMPANY_MEMORY_DATABASE_URL;
    delete process.env.COMPANY_MEMORY_DATABASE_URL;

    try {
      await main(["node", "script.js", "--out", "/tmp/test.json", "--limit", "10"]);
      assert.ok(errorLogged.includes("Refuses to run without explicit per-company --database-url"));
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = origError;
      process.exitCode = origExitCode;
      if (origEnv !== undefined) process.env.COMPANY_MEMORY_DATABASE_URL = origEnv;
    }
  });
});

describe("sample-mem0-memory-content integration test against fixture table", () => {
  it("queries real Mem0 table shape, respects read-only transaction, orders by payload created_at, applies agent filter, and cleans up connection", async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) {
      console.warn("Embedded Postgres not supported in this environment; skipping integration test");
      return;
    }

    const fixture = await startEmbeddedPostgresTestDatabase("test_mem0_sampler");
    const db = createDb(fixture.connectionString);

    try {
      // Create table matching exact Mem0 pgvector collection table shape: id, vector, payload
      // created_at is strictly in payload->>'created_at'
      await db.execute(sql`
        CREATE TABLE mem0_memories (
          id TEXT PRIMARY KEY,
          vector TEXT,
          payload JSONB NOT NULL
        );
      `);

      // Seed test memories
      await db.execute(sql`
        INSERT INTO mem0_memories (id, vector, payload) VALUES
        ('mem-1', '[]', '{"agent_id": "agent-alpha", "user_id": "company", "data": "Alpha note 1 with secret_key_secret123", "created_at": "2026-11-05T10:00:00.000Z"}'::jsonb),
        ('mem-2', '[]', '{"agent_id": "agent-alpha", "user_id": "company", "data": "Alpha note 2 newest entry", "created_at": "2026-11-05T12:00:00.000Z"}'::jsonb),
        ('mem-3', '[]', '{"agent_id": "agent-beta", "user_id": "company", "data": "Beta note middle entry", "created_at": "2026-11-05T11:00:00.000Z"}'::jsonb),
        ('mem-4', '[]', '{"agent_id": null, "user_id": "company", "data": "Unassigned note without timestamp", "created_at": null}'::jsonb);
      `);

      const testOutPath = path.join(os.tmpdir(), `mem0-e2e-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

      // 1. Unscoped sampling (all agents) with transaction hook asserting read-only from inside sampler tx
      let hookTxReadOnly: string | undefined;
      const result = await sampleMem0MemoryContent({
        outPath: testOutPath,
        limit: 10,
        databaseUrl: fixture.connectionString,
        tableName: "mem0_memories",
        agentFilter: null,
        redactPrefixChars: 16,
        env: {
          ...process.env,
          TEST_SECRET_KEY: "secret_key_secret123",
        },
        onTransaction: async (tx) => {
          const check = (await tx.execute(sql`SHOW transaction_read_only;`)) as unknown as Array<{
            transaction_read_only: string;
          }>;
          hookTxReadOnly = check[0]?.transaction_read_only;
        },
      });

      assert.equal(hookTxReadOnly, "on");
      assert.equal(result.transactionReadOnly, "on");
      assert.equal(result.totalCount, 4);
      assert.equal(result.sampleCount, 4);
      assert.ok(fs.existsSync(testOutPath));

      // Verify file mode 0600 (owner read/write only)
      const stat = fs.statSync(testOutPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600);

      // Verify file contents
      const content = JSON.parse(fs.readFileSync(testOutPath, "utf8"));
      assert.equal(content.metadata.table, "mem0_memories");
      assert.equal(content.metadata.totalCount, 4);
      assert.equal(content.metadata.agentFilter, null);

      // Agent breakdown checks (snake_case and '(none)' sentinel)
      const alphaBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "agent-alpha");
      const betaBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "agent-beta");
      const unassignedBreakdown = content.metadata.agentBreakdown.find((r: any) => r.agent_id === "(none)");
      assert.equal(alphaBreakdown?.count, 2);
      assert.equal(betaBreakdown?.count, 1);
      assert.equal(unassignedBreakdown?.count, 1);

      // Sample ordering check: payload->>'created_at' DESC NULLS LAST
      // Expected order: mem-2 (12:00), mem-3 (11:00), mem-1 (10:00), mem-4 (null)
      assert.equal(content.samples[0].id, "mem-2");
      assert.equal(content.samples[0].createdAt, "2026-11-05T12:00:00.000Z");
      assert.equal(content.samples[1].id, "mem-3");
      assert.equal(content.samples[1].createdAt, "2026-11-05T11:00:00.000Z");
      assert.equal(content.samples[2].id, "mem-1");
      assert.equal(content.samples[2].createdAt, "2026-11-05T10:00:00.000Z");
      assert.equal(content.samples[3].id, "mem-4");
      assert.equal(content.samples[3].createdAt, null);
      assert.equal(content.samples[3].agentId, null);

      // Redaction check on mem-1: secret_key_secret123 scrubbed and prefix masked
      assert.ok(!content.samples[2].dataRedacted.includes("secret_key_secret123"));
      assert.ok(content.samples[2].dataRedacted.startsWith("[REDACTED_16_CHARS]"));

      // 2. Exclusive creation: writing again to testOutPath must fail with EEXIST (wx flag)
      await assert.rejects(
        () =>
          sampleMem0MemoryContent({
            outPath: testOutPath,
            limit: 5,
            databaseUrl: fixture.connectionString,
          }),
        (err: any) => err.code === "EEXIST",
      );

      fs.unlinkSync(testOutPath);

      // 3. Scoped agent filter test: --agent agent-alpha
      const agentOutPath = path.join(os.tmpdir(), `mem0-agent-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      const agentResult = await sampleMem0MemoryContent({
        outPath: agentOutPath,
        limit: 10,
        databaseUrl: fixture.connectionString,
        tableName: "mem0_memories",
        agentFilter: "agent-alpha",
        redactPrefixChars: 16,
      });

      assert.equal(agentResult.totalCount, 2);
      assert.equal(agentResult.sampleCount, 2);
      const agentContent = JSON.parse(fs.readFileSync(agentOutPath, "utf8"));
      assert.equal(agentContent.metadata.agentFilter, "agent-alpha");
      assert.equal(agentContent.metadata.totalCount, 2);
      assert.equal(agentContent.metadata.agentBreakdown.length, 1);
      assert.equal(agentContent.metadata.agentBreakdown[0].agent_id, "agent-alpha");
      assert.equal(agentContent.samples.length, 2);
      assert.ok(agentContent.samples.every((s: any) => s.agentId === "agent-alpha"));

      fs.unlinkSync(agentOutPath);

      // 4. Verify read-only transaction from inside the sampler's actual transaction:
      // an attempted mutation inside the sampler's transaction fails closed.
      const rejectOutPath = path.join(
        os.tmpdir(),
        `mem0-reject-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      await assert.rejects(
        () =>
          sampleMem0MemoryContent({
            outPath: rejectOutPath,
            limit: 5,
            databaseUrl: fixture.connectionString,
            tableName: "mem0_memories",
            onTransaction: async (tx) => {
              await tx.execute(
                sql`INSERT INTO mem0_memories (id, vector, payload) VALUES ('mem-fail', '[]', '{}'::jsonb);`,
              );
            },
          }),
        (err: any) => {
          const msg = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
          return msg.includes("cannot execute INSERT in a read-only transaction");
        },
      );
      assert.ok(!fs.existsSync(rejectOutPath), "output file must not be created when transaction fails");
    } finally {
      await db.$client.end({ timeout: 1 }).catch(() => {});
      await fixture.cleanup();
    }
  });
});
