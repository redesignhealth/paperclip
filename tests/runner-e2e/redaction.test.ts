import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSecretFree,
  childSecretValues,
  extractDsnSecrets,
  findSecretLeak,
  findSecretLeakInDirectory,
  findSecretLeakMatch,
  normalizedSecrets,
  sanitizeJson,
  secretScanFailureEvidence,
} from "./redaction.js";
import {
  attemptSecretValues,
  campaignSecretValues,
  hasMemoryRecallExecution,
  prepareAttemptChildEnvironment,
} from "./launch.js";
import type { MatrixExecution } from "./types.js";

const tokens = {
  account_id: "identity-canary-private-90123",
  access_token: "access-canary-private-23456",
  refresh_token: "refresh-canary-private-56789",
  id_token: "id-canary-private-89012",
};
const sources = { CODEX_AUTH_JSON: JSON.stringify({ tokens }) };
const secrets = normalizedSecrets(Object.values(sources));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(Object.keys(tokens) as Array<keyof typeof tokens>)("classifies %s without returning its value", key => {
  const match = findSecretLeakMatch(`provider state: ${tokens[key]}`, secrets, { sources });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: `CODEX_AUTH_JSON.tokens.${key}` });
  for (const value of secrets) expect(JSON.stringify(match)).not.toContain(value);
  expect(findSecretLeak(tokens[key], secrets)).toBe("exact secret value");
});

it("attributes plain environment credentials and keeps unknown source names private", () => {
  const value = "environment-canary-private-12345";
  expect(findSecretLeakMatch(value, [value], { sources: { OPENAI_API_KEY: value } })).toEqual({
    reason: "exact secret value", matchCategory: "OPENAI_API_KEY",
  });
  expect(
    findSecretLeakMatch(value, [value], {
      sources: { PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: value },
    }),
  ).toEqual({
    reason: "exact secret value",
    matchCategory: "PAPERCLIP_MEMORY_ADMIN_DATABASE_URL",
  });
  const match = findSecretLeakMatch(value, [value], { sources: { [value]: value } });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: "other credential" });
  expect(JSON.stringify(match)).not.toContain(value);
});

it("never echoes account dictionary keys or unknown JSON field names in categories", () => {
  const identity = "account-dictionary-canary-private-09876";
  const key = `${identity}::work`;
  const raw = JSON.stringify({ accounts: { [key]: { [identity]: "nested-token-canary-private-76543" } } });
  const values = normalizedSecrets([raw]);
  const match = findSecretLeakMatch(key, values, { sources: { GROK_AUTH_JSON: raw } });
  expect(match).toEqual({ reason: "exact secret value", matchCategory: "GROK_AUTH_JSON.accounts.[key]" });
  const nested = findSecretLeakMatch("nested-token-canary-private-76543", values, { sources: { GROK_AUTH_JSON: raw } });
  expect(nested?.matchCategory).toBe("GROK_AUTH_JSON.accounts.[field].[field]");
  for (const value of [identity, ...values]) expect(JSON.stringify([match, nested])).not.toContain(value);
});

it("retains attribution across streamed chunks and continues to reject session rollouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "secret-category-scan-")); directories.push(root);
  const file = path.join(root, "codex-home", "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([Buffer.alloc(65_530, "x"), Buffer.from(tokens.account_id), Buffer.alloc(32, "y")]));
  const leak = await findSecretLeakInDirectory(root, secrets, { includeShapes: false, sources });
  expect(leak).toEqual({ file, reason: "exact secret value", matchCategory: "CODEX_AUTH_JSON.tokens.account_id" });
  for (const value of secrets) expect(JSON.stringify(leak)).not.toContain(value);
  // Existing callers retain their reason/shape contract and still fail closed.
  expect(await findSecretLeakInDirectory(root, secrets, { includeShapes: false })).toEqual({ file, reason: "exact secret value" });
});

it("preserves the original provider failure as sanitized scan provenance", () => {
  const evidence = secretScanFailureEvidence({
    scanError: "Secret leak in persisted state: exact secret value (CODEX_AUTH_JSON.tokens.account_id)",
    finding: { file: "codex-home/sessions/rollout.jsonl", stateArea: "Paperclip home", reason: "exact secret value",
      matchCategory: "CODEX_AUTH_JSON.tokens.account_id" },
    originalResult: { status: "failed", failureClass: "transient_infrastructure", error: `HTTP 429 provider unavailable: ${tokens.access_token}` },
  }, secrets) as Record<string, any>;
  expect(evidence.originalResult).toMatchObject({ status: "failed", failureClass: "transient_infrastructure" });
  expect(evidence.originalResult.error).toContain("HTTP 429 provider unavailable");
  expect(evidence.finding.matchCategory).toBe("CODEX_AUTH_JSON.tokens.account_id");
  expect(findSecretLeak(JSON.stringify(evidence), secrets)).toBeNull();
  for (const value of secrets) expect(JSON.stringify(evidence)).not.toContain(value);
});

describe("extractDsnSecrets", () => {
  it("extracts plain and URL-encoded passwords from standard DSN URLs", () => {
    const dsn = "postgres://pg_user:mySecretPass123!@localhost:5432/test_db";
    expect(extractDsnSecrets(dsn)).toEqual(["mySecretPass123!"]);

    const encodedDsn = "postgres://pg_user:secret%23pass%21@localhost:5432/test_db";
    const extracted = extractDsnSecrets(encodedDsn);
    expect(extracted).toContain("secret%23pass%21");
    expect(extracted).toContain("secret#pass!");
  });

  it("handles non-standard URLs and passwords containing @ characters via fallback", () => {
    // URL parser might fail on custom/invalid schemes or unencoded @ in userinfo
    const complexDsn = "custom-db://admin:pass%40word_secret@internal-db:5432/data";
    const extracted = extractDsnSecrets(complexDsn);
    expect(extracted).toContain("pass%40word_secret");
    expect(extracted).toContain("pass@word_secret");
  });

  it("returns empty array for empty, undefined, password-less, or very short passwords", () => {
    expect(extractDsnSecrets(undefined)).toEqual([]);
    expect(extractDsnSecrets("")).toEqual([]);
    expect(extractDsnSecrets("postgres://localhost:5432/test_db")).toEqual([]);
    expect(extractDsnSecrets("postgres://user@localhost:5432/test_db")).toEqual([]);
    expect(extractDsnSecrets("postgres://user:12@localhost:5432/test_db")).toEqual([]); // < 4 chars
  });

  it("extracts DSN secrets and normalizes password variants", () => {
    const dsn = "postgresql://eval_admin:superSecretDsnPass987@db.internal:5432/postgres?sslmode=require";
    const dsnSecrets = extractDsnSecrets(dsn);
    expect(dsnSecrets).toContain("superSecretDsnPass987");
  });
});

describe("childSecretValues", () => {
  const dsn =
    "postgresql://eval_admin:superSecretDsnPass987@db.internal:5432/postgres?sslmode=require";
  const credentials = {
    OPENAI_API_KEY: "sk-test-canary-private-12345",
  };

  it("builds secret set with credentials, exact full DSN, and extracted password", () => {
    const secrets = childSecretValues(credentials, dsn);
    expect(secrets).toContain(credentials.OPENAI_API_KEY);
    expect(secrets).toContain(dsn);
    expect(secrets).toContain("superSecretDsnPass987");
    // Does NOT broaden username or host independently into secrets
    expect(secrets).not.toContain("eval_admin");
    expect(secrets).not.toContain("db.internal");
  });

  it("redacts exact full DSN and partial DSN password, but not isolated username or host", () => {
    const secrets = childSecretValues(credentials, dsn);

    // 1. Exact full DSN is redacted
    const fullDsnLeak = `Error connecting to database: ${dsn}`;
    expect(() => assertSecretFree(fullDsnLeak, secrets, "full-dsn.log")).toThrow(
      /Secret leak in full-dsn\.log/,
    );
    const sanitizedFull = sanitizeJson({ err: fullDsnLeak }, secrets) as { err: string };
    expect(sanitizedFull.err).not.toContain(dsn);
    expect(sanitizedFull.err).toContain("[REDACTED]");

    // 2. Partial DSN password is independently redacted
    const partialPasswordLeak = "Auth failure: password=superSecretDsnPass987 expired";
    expect(() => assertSecretFree(partialPasswordLeak, secrets, "partial.log")).toThrow(
      /Secret leak in partial\.log/,
    );
    const sanitizedPartial = sanitizeJson({ err: partialPasswordLeak }, secrets) as { err: string };
    expect(sanitizedPartial.err).not.toContain("superSecretDsnPass987");
    expect(sanitizedPartial.err).toContain("[REDACTED]");

    // 3. Isolated username or host fragments are NOT treated as independent secrets
    const unredactedFragments = "Connection error for user eval_admin on host db.internal";
    expect(() => assertSecretFree(unredactedFragments, secrets, "clean.log")).not.toThrow();
    const sanitizedClean = sanitizeJson({ info: unredactedFragments }, secrets) as { info: string };
    expect(sanitizedClean.info).toContain("eval_admin");
    expect(sanitizedClean.info).toContain("db.internal");
    expect(sanitizedClean.info).not.toContain("[REDACTED]");
  });

  it("handles undefined, empty, or passwordless admin DSN cleanly", () => {
    const secretsUndefined = childSecretValues(credentials, undefined);
    expect(secretsUndefined).toContain(credentials.OPENAI_API_KEY);
    expect(secretsUndefined).not.toContain(undefined);

    const secretsEmpty = childSecretValues(credentials, "   ");
    expect(secretsEmpty).toContain(credentials.OPENAI_API_KEY);

    const noPassDsn = "postgresql://eval_admin@db.internal:5432/postgres";
    const secretsNoPass = childSecretValues(credentials, noPassDsn);
    expect(secretsNoPass).toContain(noPassDsn);
    expect(secretsNoPass).not.toContain("eval_admin");
  });
});

describe("campaignSecretValues and attemptSecretValues", () => {
  const dsn =
    "postgresql://eval_admin:superSecretDsnPass987@db.internal:5432/postgres?sslmode=require";
  const envWithDsn: NodeJS.ProcessEnv = {
    PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: dsn,
    OPENAI_API_KEY: "sk-test-canary-private-12345",
  };

  const nonMemoryExecutions = [
    {
      id: "stock-harness.legacy-codex.local.ordered-comment-continuation",
      suite: { id: "stock-harness", manualOnly: false },
      task: { id: "ordered-comment-continuation", flow: "context_integrity" },
    },
  ] as unknown as MatrixExecution[];

  const memoryExecutions = [
    {
      id: "memory-recall.memory-hermes-local.local.save-then-fresh-recall-rep-1",
      suite: { id: "memory-recall", manualOnly: true },
      task: { id: "save-then-fresh-recall-rep-1", flow: "memory_recall" },
    },
  ] as unknown as MatrixExecution[];

  it("(a) a batch with no memory-recall suite redacts the full DSN and password at attempt scope", () => {
    const secrets = attemptSecretValues(envWithDsn, nonMemoryExecutions);
    expect(secrets).toContain(dsn);
    expect(secrets).toContain("superSecretDsnPass987");

    const raw = `State dump error connecting to ${dsn} for non-memory task`;
    expect(() => assertSecretFree(raw, secrets, "attempt-error.log")).toThrow(
      /Secret leak in attempt-error\.log/,
    );

    const sanitized = sanitizeJson({ error: raw }, secrets) as { error: string };
    expect(sanitized.error).not.toContain(dsn);
    expect(sanitized.error).not.toContain("superSecretDsnPass987");
    // Username and host inside the full DSN were redacted along with the full DSN string
    expect(sanitized.error).not.toContain("eval_admin");
    expect(sanitized.error).not.toContain("db.internal");
    expect(sanitized.error).toContain("[REDACTED]");
    expect(() =>
      assertSecretFree(JSON.stringify(sanitized), secrets, "attempt.json"),
    ).not.toThrow();
  });

  it("(b) a memory-recall batch redacts the full DSN and password at attempt scope", () => {
    const secrets = attemptSecretValues(envWithDsn, memoryExecutions);
    expect(secrets).toContain(dsn);
    expect(secrets).toContain("superSecretDsnPass987");

    const raw = `Memory connection string: ${dsn}`;
    expect(() => assertSecretFree(raw, secrets, "attempt-memory.log")).toThrow(
      /Secret leak in attempt-memory\.log/,
    );

    const sanitized = sanitizeJson({ log: raw }, secrets) as { log: string };
    expect(sanitized.log).not.toContain(dsn);
    expect(sanitized.log).not.toContain("superSecretDsnPass987");
    expect(sanitized.log).toContain("[REDACTED]");
    expect(() =>
      assertSecretFree(JSON.stringify(sanitized), secrets, "attempt.json"),
    ).not.toThrow();
  });

  it("(c) asserts the full DSN string (not just the password) is redacted from campaign outputs", () => {
    const campaignSecrets = campaignSecretValues(envWithDsn);
    expect(campaignSecrets).toContain(dsn);
    expect(campaignSecrets).toContain("superSecretDsnPass987");

    const campaignData = {
      campaignId: "campaign-test-123",
      results: [
        {
          error: `Connection failed to ${dsn}`,
        },
      ],
    };

    const rawJson = JSON.stringify(campaignData, null, 2);
    expect(() => assertSecretFree(rawJson, campaignSecrets, "campaign.json")).toThrow(
      /Secret leak in campaign\.json/,
    );

    const safeCampaign = sanitizeJson(campaignData, campaignSecrets);
    const safeJson = JSON.stringify(safeCampaign, null, 2);
    expect(() => assertSecretFree(safeJson, campaignSecrets, "campaign.json")).not.toThrow();
    // The exact full DSN string is redacted as a whole (removing the entire DSN which contained
    // username, password, host, and database), and the password is independently redacted.
    // Isolated username or host fragments appearing on their own are not independent secrets.
    expect(safeJson).not.toContain(dsn);
    expect(safeJson).not.toContain("superSecretDsnPass987");
    expect(safeJson).not.toContain("eval_admin");
    expect(safeJson).not.toContain("db.internal");
    expect(safeJson).toContain("[REDACTED]");

    // Verify isolated username or host fragments are NOT redacted when appearing on their own
    const isolatedMsg = { error: "Connected as user eval_admin to host db.internal" };
    const safeIsolated = sanitizeJson(isolatedMsg, campaignSecrets) as { error: string };
    expect(safeIsolated.error).toBe("Connected as user eval_admin to host db.internal");
  });

  it("gating rule: strips admin DSN from childEnv when !hasMemoryRecall, retains when hasMemoryRecall", () => {
    const nonMemoryEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://strip-me",
      DATABASE_MIGRATION_URL: "postgres://strip-me-too",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: dsn,
      SOME_OTHER_VAR: "keep-me",
    };
    prepareAttemptChildEnvironment(nonMemoryEnv, false);
    expect(nonMemoryEnv.DATABASE_URL).toBeUndefined();
    expect(nonMemoryEnv.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(nonMemoryEnv.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL).toBeUndefined();
    expect(nonMemoryEnv.SOME_OTHER_VAR).toBe("keep-me");

    const memoryEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://strip-me",
      DATABASE_MIGRATION_URL: "postgres://strip-me-too",
      PAPERCLIP_MEMORY_ADMIN_DATABASE_URL: dsn,
      SOME_OTHER_VAR: "keep-me",
    };
    prepareAttemptChildEnvironment(memoryEnv, true);
    expect(memoryEnv.DATABASE_URL).toBeUndefined();
    expect(memoryEnv.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(memoryEnv.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL).toBe(dsn);
    expect(memoryEnv.SOME_OTHER_VAR).toBe("keep-me");
  });

  it("identifies memory-recall executions accurately", () => {
    expect(hasMemoryRecallExecution([])).toBe(false);
    expect(hasMemoryRecallExecution(nonMemoryExecutions)).toBe(false);
    expect(hasMemoryRecallExecution(memoryExecutions)).toBe(true);
    expect(
      hasMemoryRecallExecution([
        {
          id: "test",
          suite: { id: "other-suite" },
          task: { flow: "memory_recall" },
        } as any,
      ]),
    ).toBe(true);
  });
});
