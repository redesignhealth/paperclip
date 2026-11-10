/**
 * OpenAI API key resolution, permission checks, and redaction tests (TECH-8191).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isPrintableNonWhitespaceAscii,
  RedactionRegistry,
  resolveCompanyOpenAiKey,
} from "../../server/src/services/company-memory-upgrade/openai-key.js";
import {
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
  insertCompanyOpenAiSecret,
  startEmbeddedPostgresTestDatabase,
} from "./memory-upgrade-sweep-helpers.js";

test("isPrintableNonWhitespaceAscii unit tests", () => {
  assert.equal(isPrintableNonWhitespaceAscii("sk-proj-123456789012345678"), true);
  // Too short (<20)
  assert.equal(isPrintableNonWhitespaceAscii("short-key-12345"), false);
  // Too long (>512)
  assert.equal(isPrintableNonWhitespaceAscii("a".repeat(513)), false);
  // Contains whitespace or control characters
  assert.equal(isPrintableNonWhitespaceAscii("sk-proj-1234 56789012345678"), false);
  assert.equal(isPrintableNonWhitespaceAscii("sk-proj-1234\t56789012345678"), false);
  assert.equal(isPrintableNonWhitespaceAscii("sk-proj-1234\n56789012345678"), false);
});

test("RedactionRegistry scrubs secrets and standard key formats", () => {
  const registry = new RedactionRegistry();
  const rawSecret = "sk-custom-secret-key-1234567890";
  registry.add(rawSecret);

  const textWithSecret = `Failed to connect with key ${rawSecret} to OpenAI endpoint.`;
  const scrubbed = registry.scrub(textWithSecret);
  assert.ok(!scrubbed.includes(rawSecret));
  assert.ok(scrubbed.includes("[REDACTED_API_KEY]"));

  // Also masks typical sk-proj-... patterns even if not explicitly added
  const textWithGenericKey = "Header was Bearer sk-proj-abcdef1234567890abcdef1234567890";
  const scrubbedGeneric = registry.scrub(textWithGenericKey);
  assert.ok(!scrubbedGeneric.includes("abcdef1234567890"));
  assert.ok(scrubbedGeneric.includes("[REDACTED_API_KEY]"));
});

test("resolveCompanyOpenAiKey from company_secrets database", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const cpFixture = await startEmbeddedPostgresTestDatabase("sweep-key-cp-");
  const cpDb = createDb(cpFixture.connectionString);

  t.after(async () => {
    await cpDb.$client?.end();
    await cpFixture.cleanup();
  });

  const [company] = await cpDb.insert(companies).values({
    name: "Key Resolution Co",
    issuePrefix: "KR",
  }).returning();

  await t.test("OPENAI_API_KEY environment variable is strictly ignored", async () => {
    const originalEnvKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-env-var-key-should-be-ignored-123456";

      // With no company secret in DB and no --openai-key-file, must throw COMPANY_OPENAI_KEY_MISSING
      await assert.rejects(
        () => resolveCompanyOpenAiKey({ controlPlaneDb: cpDb, companyId: company.id }),
        (err: any) => err.code === "COMPANY_OPENAI_KEY_MISSING",
      );
    } finally {
      if (originalEnvKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalEnvKey;
      }
    }
  });

  await t.test("successfully resolves and decrypts local_encrypted company secret", async () => {
    const expectedKey = "sk-test-valid-company-secret-key-9999999999";
    await insertCompanyOpenAiSecret(cpDb, company.id, expectedKey, "local_encrypted");

    const redaction = new RedactionRegistry();
    const resolved = await resolveCompanyOpenAiKey({
      controlPlaneDb: cpDb,
      companyId: company.id,
      redaction,
    });

    assert.equal(resolved, expectedKey);

    // Ensure redaction registry captures the resolved key
    const scrubbed = redaction.scrub(`Connecting with ${expectedKey}`);
    assert.ok(!scrubbed.includes(expectedKey));
  });

  await t.test("refuses secret with unsupported provider (e.g. aws_secrets_manager)", async () => {
    const [compAws] = await cpDb.insert(companies).values({
      name: "AWS Secret Co",
      issuePrefix: "AW",
    }).returning();

    const secId = randomUUID();
    await cpDb.insert(companySecrets).values({
      id: secId,
      companyId: compAws.id,
      scope: "company",
      key: "openai_api_key",
      name: "OpenAI Key",
      provider: "aws_secrets_manager",
      status: "active",
      latestVersion: 1,
    });
    await cpDb.insert(companySecretVersions).values({
      secretId: secId,
      version: 1,
      material: { externalRef: "arn:aws:secretsmanager:..." },
      valueSha256: "dummy-sha",
      fingerprintSha256: "dummy-fp",
      status: "current",
    });

    await assert.rejects(
      () => resolveCompanyOpenAiKey({ controlPlaneDb: cpDb, companyId: compAws.id }),
      (err: any) => {
        assert.equal(err.code, "COMPANY_OPENAI_KEY_PROVIDER_UNSUPPORTED");
        assert.ok(err.message.includes("--openai-key-file"));
        return true;
      },
    );
  });

  await t.test("refuses inactive, deleted, or revoked secret", async () => {
    const [compInactive] = await cpDb.insert(companies).values({
      name: "Inactive Secret Co",
      issuePrefix: "IN",
    }).returning();

    const secId = randomUUID();
    await cpDb.insert(companySecrets).values({
      id: secId,
      companyId: compInactive.id,
      scope: "company",
      key: "openai_api_key",
      name: "OpenAI Key",
      provider: "local_encrypted",
      status: "disabled", // inactive!
      latestVersion: 1,
    });
    await cpDb.insert(companySecretVersions).values({
      secretId: secId,
      version: 1,
      material: { plaintext: "sk-inactive-key-123456789012345678" },
      valueSha256: "dummy-sha",
      fingerprintSha256: "dummy-fp",
      status: "current",
    });

    await assert.rejects(
      () => resolveCompanyOpenAiKey({ controlPlaneDb: cpDb, companyId: compInactive.id }),
      (err: any) => err.code === "COMPANY_OPENAI_KEY_MISSING",
    );
  });

  await t.test("resolveVersion failure throws COMPANY_OPENAI_KEY_MISSING", async () => {
    const [compCorrupt] = await cpDb.insert(companies).values({
      name: "Corrupt Secret Co",
      issuePrefix: "CS",
    }).returning();

    const secId = randomUUID();
    await cpDb.insert(companySecrets).values({
      id: secId,
      companyId: compCorrupt.id,
      scope: "company",
      key: "openai_api_key",
      name: "OpenAI Key",
      provider: "local_encrypted",
      status: "active",
      latestVersion: 1,
    });
    await cpDb.insert(companySecretVersions).values({
      secretId: secId,
      version: 1,
      material: { corrupted: "bad-material-data" },
      valueSha256: "dummy-sha",
      fingerprintSha256: "dummy-fp",
      status: "current",
    });

    await assert.rejects(
      () => resolveCompanyOpenAiKey({ controlPlaneDb: cpDb, companyId: compCorrupt.id }),
      (err: any) => {
        assert.equal(err.code, "COMPANY_OPENAI_KEY_MISSING");
        assert.equal(err.message, "Failed to resolve company openai_api_key secret version.");
        return true;
      },
    );
  });
});

test("resolveCompanyOpenAiKey via --openai-key-file", async (t) => {
  const dummyDb: any = {};
  const dummyCompanyId = randomUUID();
  const validKey = "sk-external-file-key-12345678901234567890";

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openai-key-test-"));
  const safeFilePath = path.join(tmpDir, `openai-key-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(safeFilePath, `${validKey}\n`, { mode: 0o600 });

  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test("resolves trimmed valid key from external 0600 file", async () => {
    const redaction = new RedactionRegistry();
    const resolved = await resolveCompanyOpenAiKey({
      controlPlaneDb: dummyDb,
      companyId: dummyCompanyId,
      keyFilePath: safeFilePath,
      redaction,
    });

    assert.equal(resolved, validKey);
    assert.ok(redaction.scrub(`Key: ${validKey}`).includes("[REDACTED_API_KEY]"));
  });

  await t.test("refuses file located inside repository", async () => {
    const inRepoPath = "./server/src/test-secret.txt";
    await assert.rejects(
      () =>
        resolveCompanyOpenAiKey({
          controlPlaneDb: dummyDb,
          companyId: dummyCompanyId,
          keyFilePath: inRepoPath,
        }),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(err.message.includes("inside repository"));
        return true;
      },
    );
  });

  await t.test("refuses symbolic link to key file", async () => {
    const symlinkPath = path.join(tmpDir, `symlink-key-${randomUUID().slice(0, 8)}.txt`);
    try {
      symlinkSync(safeFilePath, symlinkPath);

      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: symlinkPath,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("symbolic link"));
          return true;
        },
      );
    } finally {
      if (existsSync(symlinkPath)) {
        unlinkSync(symlinkPath);
      }
    }
  });

  await t.test("refuses group or other readable permissions (fail, never chmod, mode unchanged)", async () => {
    const permissiveFile = path.join(tmpDir, `perm-key-${randomUUID().slice(0, 8)}.txt`);
    try {
      writeFileSync(permissiveFile, `${validKey}\n`, { mode: 0o644 });
      // Ensure group/other bits are set
      chmodSync(permissiveFile, 0o644);

      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: permissiveFile,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("permissions too open"));
          return true;
        },
      );

      // The implementation must NEVER chmod: mode stays exactly 0o644, unmodified.
      const modeAfter = statSync(permissiveFile).mode & 0o777;
      assert.equal(modeAfter, 0o644, "file mode must remain unchanged after a rejected read");
    } finally {
      if (existsSync(permissiveFile)) {
        unlinkSync(permissiveFile);
      }
    }
  });

  await t.test("refuses a FIFO (named pipe) at the key file path without hanging", async () => {
    const fifoPath = path.join(tmpDir, `fifo-key-${randomUUID().slice(0, 8)}`);
    try {
      execFileSync("mkfifo", ["-m", "600", fifoPath]);
    } catch {
      // mkfifo unavailable on this platform/runner: skip rather than fail the suite.
      t.skip("mkfifo unavailable");
      return;
    }

    try {
      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: fifoPath,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(!err.message.includes(fifoPath), "path must never be echoed in the error message");
          return true;
        },
      );
    } finally {
      if (existsSync(fifoPath)) {
        unlinkSync(fifoPath);
      }
    }
  });

  await t.test("refuses a key file reached through a SYMLINKED PARENT directory that resolves inside the repository", async () => {
    // The leaf file itself is a REAL file (not a symlink); the only indirection is the
    // symlinked PARENT directory. The lexical path looks external, but it actually resolves
    // inside the repository tree via repoRoot -- this must be refused by the REAL
    // (symlink-resolved) containment check, which the lexical check alone would miss.
    const fakeRepoRoot = mkdtempSync(path.join(os.tmpdir(), "fake-repo-root-"));
    const inRepoRealDir = path.join(fakeRepoRoot, `internal-dir-${randomUUID().slice(0, 8)}`);
    const symlinkToRepoDir = path.join(tmpDir, `symlink-to-repo-${randomUUID().slice(0, 8)}`);

    try {
      mkdirSync(inRepoRealDir, { recursive: true });
      symlinkSync(inRepoRealDir, symlinkToRepoDir, "dir");

      const leafPath = path.join(inRepoRealDir, "key.txt");
      writeFileSync(leafPath, `${validKey}\n`, { mode: 0o600 });
      const pathThroughSymlinkedParent = path.join(symlinkToRepoDir, "key.txt");

      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: pathThroughSymlinkedParent,
            repoRoot: fakeRepoRoot,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("inside repository"));
          return true;
        },
      );
    } finally {
      if (existsSync(symlinkToRepoDir)) unlinkSync(symlinkToRepoDir);
      rmSync(fakeRepoRoot, { recursive: true, force: true });
    }
  });

  await t.test("refuses key file exceeding 4096 bytes", async () => {
    const largeFilePath = path.join(tmpDir, `large-key-${randomUUID().slice(0, 8)}.txt`);
    try {
      writeFileSync(largeFilePath, "A".repeat(4097), { mode: 0o600 });
      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: largeFilePath,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("4096 bytes"));
          return true;
        },
      );
    } finally {
      if (existsSync(largeFilePath)) unlinkSync(largeFilePath);
    }
  });

  await t.test("fails closed if repository root cannot be resolved", async () => {
    await assert.rejects(
      () =>
        resolveCompanyOpenAiKey({
          controlPlaneDb: dummyDb,
          companyId: dummyCompanyId,
          keyFilePath: safeFilePath,
          repoRoot: "/nonexistent-repo-root-dir-that-fails-realpath-12345",
        }),
      (err: any) => {
        assert.equal(err.code, "INVALID_ARGUMENT");
        assert.ok(err.message.includes("Repository root directory could not be resolved"));
        return true;
      },
    );
  });

  await t.test("refuses key with invalid length or non-printable ASCII", async () => {
    const badKeyFile = path.join(tmpDir, `bad-key-${randomUUID().slice(0, 8)}.txt`);
    try {
      // Key with spaces / newline in middle
      writeFileSync(badKeyFile, "short-key\n", { mode: 0o600 });

      await assert.rejects(
        () =>
          resolveCompanyOpenAiKey({
            controlPlaneDb: dummyDb,
            companyId: dummyCompanyId,
            keyFilePath: badKeyFile,
          }),
        (err: any) => {
          assert.equal(err.code, "INVALID_ARGUMENT");
          assert.ok(err.message.includes("20-512"));
          return true;
        },
      );
    } finally {
      if (existsSync(badKeyFile)) {
        unlinkSync(badKeyFile);
      }
    }
  });
});
