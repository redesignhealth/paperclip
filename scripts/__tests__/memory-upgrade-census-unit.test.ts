import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  classifyMemoryNoise,
  classifyMemoryNoiseDetailed,
} from "../../server/src/services/company-memory-upgrade/classify-noise.js";
import {
  detectSensitiveFamilies,
  SENSITIVE_FAMILIES,
} from "../../server/src/services/company-memory-upgrade/sensitive-patterns.js";
import {
  createCensusAccumulator,
  accumulateCensusRow,
  finalizeCensusCounts,
  redactPayloadIdentifier,
} from "../../server/src/services/company-memory-upgrade/census.js";

describe("classifyMemoryNoise pure unit tests", () => {
  it("classifies null, undefined, empty, and whitespace as noise", () => {
    assert.equal(classifyMemoryNoise(null), true);
    assert.equal(classifyMemoryNoise(undefined), true);
    assert.equal(classifyMemoryNoise(""), true);
    assert.equal(classifyMemoryNoise("   "), true);
    assert.equal(classifyMemoryNoise("\t\n  \r"), true);
    assert.equal(classifyMemoryNoise(" . "), true);
    assert.equal(classifyMemoryNoise(" ! "), true);
    assert.equal(classifyMemoryNoise("---"), true);
    assert.equal(classifyMemoryNoise("..."), true);
  });

  it("does NOT classify short substantive tokens as noise, while preserving exact noise tokens", () => {
    // D1: Short substantive tokens like "Go", "TS", "AWS", "P0", "C#", "yo" must NOT be noise
    const substantiveShort = ["Go", "TS", "AWS", "P0", "C#", "yo", "AI", "db", "CI"];
    for (const s of substantiveShort) {
      assert.equal(classifyMemoryNoise(s), false, `Expected "${s}" NOT to be noise`);
    }

    // Exact noise tokens like "yes", "no", "hi", "ok", "bye" remain noise
    const noiseTokens = ["hi", "ok", "yes", "no", "bye", "ack", "yep", "nope"];
    for (const n of noiseTokens) {
      assert.equal(classifyMemoryNoise(n), true, `Expected exact token "${n}" to be noise`);
    }
  });

  it("does NOT classify ambiguous context-dependent tokens like none, done, empty, sure as noise", () => {
    // D2: "none", "done", "empty", "sure" are legitimate in context ("Allergies: none", "Task: done")
    const ambiguousTokens = ["none", "done", "empty", "sure", "Allergies: none", "Status: done"];
    for (const token of ambiguousTokens) {
      assert.equal(classifyMemoryNoise(token), false, `Expected "${token}" NOT to be noise`);
    }
  });

  it("classifies test and placeholder strings as noise", () => {
    const placeholders = [
      "test",
      "testing",
      "test note",
      "test memory",
      "test data",
      "test 123",
      "placeholder",
      "dummy",
      "dummy note",
      "sample",
      "sample note",
      "sample text",
      "lorem ipsum",
      "lorem ipsum dolor sit amet",
      "asdf",
      "qwerty",
      "foo",
      "baz",
      "foobar",
      "n/a",
      "null",
      "nil",
      "undefined",
      "nothing",
      "ping",
      "pong",
    ];

    for (const p of placeholders) {
      assert.equal(classifyMemoryNoise(p), true, `Expected "${p}" to be noise`);
      assert.equal(classifyMemoryNoise(`  ${p.toUpperCase()}!  `), true, `Expected uppercase punctuated "${p}" to be noise`);
    }

    assert.equal(classifyMemoryNoise("bar"), false, 'Expected "bar" NOT to be noise');
    assert.equal(classifyMemoryNoise("na"), false, 'Expected "na" NOT to be noise');
    assert.equal(classifyMemoryNoise("no"), true, 'Expected "no" to be noise');
  });

  it("classifies bare greetings and acknowledgments as noise", () => {
    const greetings = [
      "hello",
      "hello world",
      "hello there",
      "good morning",
      "good afternoon",
      "good evening",
      "good night",
      "thanks",
      "thank you",
      "thank you so much",
      "ok",
      "okay",
      "sounds good",
      "got it",
      "understood",
      "ack",
      "noted",
      "bye",
      "goodbye",
      "see you",
      "cya",
    ];

    for (const g of greetings) {
      assert.equal(classifyMemoryNoise(g), true, `Expected "${g}" to be noise`);
      assert.equal(classifyMemoryNoise(`${g}.`), true, `Expected "${g}." to be noise`);
    }
  });

  it("NEVER classifies substantive preferences, facts, or instructions as noise", () => {
    const substantive = [
      "User prefers dark mode",
      "Deploy to prod on Tuesdays only",
      "Always use TypeScript for new services",
      "Dan's birthday is June 5",
      "Call me Dan",
      "Client requested a 20% discount on renewal",
      "Auth token expires in 1 hour",
      "Postgres connection pooling maxConnections is 5",
      "API keys are stored in HashiCorp Vault",
      "Never use floating point numbers for financial amounts",
      "Customer contact email is ops@example.com",
    ];

    for (const s of substantive) {
      assert.equal(classifyMemoryNoise(s), false, `Substantive text "${s}" must not be noise`);
      const detailed = classifyMemoryNoiseDetailed(s);
      assert.equal(detailed.isNoise, false);
      assert.equal(detailed.reason, undefined);
    }
  });
});

describe("detectSensitiveFamilies unit tests", () => {
  it("detects sensitive patterns across all supported regex families without leaking matched text", () => {
    // 1. Private key header
    const privKey = detectSensitiveFamilies("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...");
    assert.equal(privKey.isSensitive, true);
    assert.equal(privKey.matches.privateKey, true);
    assert.equal(privKey.matches.apiKey, false);

    // 2. Bearer token
    const bearer = detectSensitiveFamilies("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz1234567890abcdef");
    assert.equal(bearer.isSensitive, true);
    assert.equal(bearer.matches.bearerToken, true);

    // 3. API key (OpenAI sk- / GitHub ghp_)
    const apiKey1 = detectSensitiveFamilies("API key is sk-1234567890abcdef1234567890abcdef for project");
    assert.equal(apiKey1.isSensitive, true);
    assert.equal(apiKey1.matches.apiKey, true);

    const apiKey2 = detectSensitiveFamilies("Use token ghp_abcdef1234567890abcdef1234567890 to pull");
    assert.equal(apiKey2.isSensitive, true);
    assert.equal(apiKey2.matches.apiKey, true);

    // 4. SSN
    const ssn = detectSensitiveFamilies("Applicant SSN is 123-45-6789 for tax forms");
    assert.equal(ssn.isSensitive, true);
    assert.equal(ssn.matches.ssn, true);

    // 5. Credit card
    const cc = detectSensitiveFamilies("Payment card 4111 2222 3333 4444 on file");
    assert.equal(cc.isSensitive, true);
    assert.equal(cc.matches.creditCard, true);

    // 6. Password assignment
    const pw = detectSensitiveFamilies("Temporary admin password: superSecretPassword123!");
    assert.equal(pw.isSensitive, true);
    assert.equal(pw.matches.passwordAssignment, true);
  });

  it("returns isSensitive false for clean memory text", () => {
    const clean = detectSensitiveFamilies("User prefers monospace font in the editor interface.");
    assert.equal(clean.isSensitive, false);
    for (const val of Object.values(clean.matches)) {
      assert.equal(val, false);
    }
  });

  it("has exactly six supported sensitive families in SENSITIVE_FAMILIES", () => {
    assert.deepEqual(Object.keys(SENSITIVE_FAMILIES).sort(), [
      "apiKey",
      "bearerToken",
      "creditCard",
      "passwordAssignment",
      "privateKey",
      "ssn",
    ]);
  });
});

describe("redactPayloadIdentifier unit tests", () => {
  it("returns null for null, undefined, empty, or whitespace-only inputs", () => {
    assert.equal(redactPayloadIdentifier(null), null);
    assert.equal(redactPayloadIdentifier(undefined), null);
    assert.equal(redactPayloadIdentifier(""), null);
    assert.equal(redactPayloadIdentifier("   "), null);
    assert.equal(redactPayloadIdentifier("\t\n"), null);
  });

  it("returns literal (none) for (none)", () => {
    assert.equal(redactPayloadIdentifier("(none)"), "(none)");
    assert.equal(redactPayloadIdentifier("  (none)  "), "(none)");
    assert.equal(redactPayloadIdentifier("(none)", true), "(none)");
  });

  it("preserves valid UUIDs in normalized lowercase", () => {
    const uuidUpper = "00000000-0000-4000-8000-000000000001".toUpperCase();
    const uuidExpected = "00000000-0000-4000-8000-000000000001";
    assert.equal(redactPayloadIdentifier(uuidUpper, false), uuidExpected);
    assert.equal(redactPayloadIdentifier(uuidUpper, true), uuidExpected);
    assert.equal(redactPayloadIdentifier(uuidExpected, false), uuidExpected);
  });

  it("preserves literal company only when allowCompany is true", () => {
    assert.equal(redactPayloadIdentifier("company", true), "company");
    assert.equal(redactPayloadIdentifier("COMPANY", true), "company");
    assert.equal(redactPayloadIdentifier("  company  ", true), "company");

    // When allowCompany is false, "company" must be redacted like any non-UUID
    const redactedWithoutCompany = redactPayloadIdentifier("company", false);
    const expectedHash = createHash("sha256").update("company").digest("hex").slice(0, 12);
    assert.equal(redactedWithoutCompany, `sha256:${expectedHash} (len 7)`);
  });

  it("redacts non-UUID identifiers with sha256 prefix and length without leaking content", () => {
    const rawTokens = ["user@example.com", "admin-service-account", "malformed-agent-id-123"];
    for (const raw of rawTokens) {
      const redacted = redactPayloadIdentifier(raw, false);
      const expectedHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
      assert.equal(redacted, `sha256:${expectedHash} (len ${raw.length})`);
      assert.ok(!redacted!.includes(raw));
    }
  });
});

describe("pure census accumulator unit tests (database-free)", () => {
  it("accumulates rows and computes all aggregates, percentiles, hygiene, and disjoint quality signals", () => {
    const acc = createCensusAccumulator(50);

    const validAgent1 = "11111111-1111-4111-8111-111111111111";
    const validAgent2 = "22222222-2222-4222-8222-222222222222";

    const rows = [
      // Substantive rows for agent 1
      {
        id: "1",
        agent_id: validAgent1,
        user_id: "user-1",
        data: "Remember that the user likes dark mode in their editor configuration.",
        created_at: "2026-01-15T10:00:00.000Z",
      },
      // Duplicate of row 1 (normalized identical)
      {
        id: "2",
        agent_id: validAgent1,
        user_id: "user-1",
        data: "  remember that the user likes dark mode in their editor configuration.  ",
        created_at: "2026-01-20T12:00:00.000Z",
      },
      // Noise row for agent 1 (should NOT be counted in duplicate surplus)
      {
        id: "3",
        agent_id: validAgent1,
        user_id: "user-2",
        data: "test",
        created_at: "2026-02-01T08:00:00.000Z",
      },
      // Another identical noise row for agent 1 (still noise, not duplicate surplus)
      {
        id: "4",
        agent_id: validAgent1,
        user_id: "user-2",
        data: "test",
        created_at: "2026-02-05T09:00:00.000Z",
      },
      // Sensitive pattern row (API key)
      {
        id: "5",
        agent_id: validAgent2,
        user_id: "user-2",
        data: "Production API key is sk-1234567890abcdef1234567890abcdef for OpenAI.",
        created_at: "2026-03-01T15:00:00.000Z",
      },
      // Malformed agent ID
      {
        id: "6",
        agent_id: "malformed-agent-id",
        user_id: "user-3",
        data: "Some note from malformed agent.",
        created_at: "2026-03-10T16:00:00.000Z",
      },
      // Blank agent ID
      {
        id: "7",
        agent_id: "   ",
        user_id: "user-3",
        data: "Another note with blank agent ID.",
        created_at: "invalid-date",
      },
      // Null agent ID
      {
        id: "8",
        agent_id: null,
        user_id: null,
        data: "Note with null agent and null user.",
        created_at: null,
      },
    ];

    for (const r of rows) {
      accumulateCensusRow(acc, r);
    }

    const counts = finalizeCensusCounts(acc, rows.length);

    assert.equal(counts.totalRows, 8);
    assert.equal(counts.distinctUserIds, 4); // user-1, user-2, user-3, (none)
    assert.equal(counts.distinctAgentIds, 4); // validAgent1, validAgent2, malformed-agent-id, (none)

    // Hygiene
    assert.equal(counts.agentIdHygiene.missingOrBlankCount, 2); // rows 7, 8
    assert.equal(counts.agentIdHygiene.nonUuidCount, 1); // row 6
    assert.equal(counts.agentIdHygiene.totalMalformedOrMissingCount, 3);

    // Histogram
    assert.equal(counts.createdAtHistogram["2026-01"], 2);
    assert.equal(counts.createdAtHistogram["2026-02"], 2);
    assert.equal(counts.createdAtHistogram["2026-03"], 2);
    assert.equal(counts.createdAtHistogram["unparseable"], 2); // invalid-date, null

    // Quality signals
    assert.equal(counts.noise.candidateCount, 2); // rows 3, 4 ("test")
    // Duplicate surplus: row 1 and 2 are identical normalized substantive rows -> 1 group, 1 surplus
    // Noise rows 3 and 4 must NOT be added to duplicate surplus
    assert.equal(counts.duplicates.duplicateGroups, 1);
    assert.equal(counts.duplicates.surplusRows, 1);

    // Sensitive
    assert.equal(counts.sensitive.candidateCount, 1);
    assert.equal(counts.sensitive.familyBreakdown.apiKey, 1);

    // Length
    assert.ok(counts.contentLength.average > 0);
    assert.ok(counts.contentLength.median > 0);
    assert.ok(counts.contentLength.p95 > 0);
    assert.equal(counts.contentLength.threshold, 50);
    assert.ok(counts.contentLength.longerThanThresholdCount > 0);
  });
});
