/**
 * Converter contract, schema, prompt pin, and payload building unit tests (TECH-8191).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTargetPayload,
  computeConverterContractSha256,
  computeRecordDataSha256,
  CONVERSION_JSON_SCHEMA,
  CONVERSION_REJECT_CODES,
  CONVERSION_SYSTEM_PROMPT,
  CONVERTER_CONTRACT_SHA256,
  CONVERTER_ID,
  CONVERTER_VERSION,
  formatPgVectorLiteral,
  MEMORY_TYPES,
  SUPPORTED_CONVERTER_MODELS,
  validateConversionOutput,
} from "../../server/src/services/company-memory-upgrade/converter-contract.js";
import {
  buildInitialConversionMessages,
  buildRepairConversionMessages,
} from "../../server/src/services/company-memory-upgrade/llm-converter.js";

test("converter contract invariants and pins", async (t) => {
  await t.test("contract IDs, models, and types", () => {
    assert.equal(CONVERTER_ID, "paperclip.memory-upgrade.atomic-converter");
    assert.equal(CONVERTER_VERSION, 1);
    assert.deepEqual(SUPPORTED_CONVERTER_MODELS, ["gpt-5.4-mini"]);
    assert.deepEqual(MEMORY_TYPES, ["preference", "decision", "lesson", "fact", "procedure"]);
  });

  await t.test("pinned CONVERTER_CONTRACT_SHA256 matches computed sha256", () => {
    const computed = computeConverterContractSha256();
    assert.equal(
      CONVERTER_CONTRACT_SHA256,
      computed,
      "CONVERTER_CONTRACT_SHA256 must match computed sha256. Any prompt/schema changes require bumping CONVERTER_VERSION and repinning.",
    );
    assert.equal(
      CONVERTER_CONTRACT_SHA256,
      "d27300ce3e11473d517a4a4e80b411fa44632ab25c904b6e44cfbf3ad7ce88c9",
      "Frozen contract pin must match historical sha256",
    );
  });

  await t.test("strict JSON schema conforms to OpenAI requirements", () => {
    assert.equal(CONVERSION_JSON_SCHEMA.type, "object");
    assert.equal(CONVERSION_JSON_SCHEMA.additionalProperties, false);
    assert.deepEqual(CONVERSION_JSON_SCHEMA.required, ["decision", "records"]);
    assert.equal(CONVERSION_JSON_SCHEMA.properties.records.items.additionalProperties, false);
    assert.deepEqual(CONVERSION_JSON_SCHEMA.properties.records.items.required, [
      "data",
      "type",
      "subject",
      "confidence",
    ]);
  });
});

test("validateConversionOutput happy path and drop decisions", async (t) => {
  await t.test("valid convert decision with 1..6 records", () => {
    const validRaw = {
      decision: "convert",
      records: [
        {
          data: "The engineering team deploys migrations during the low-traffic window.",
          type: "procedure",
          subject: "migration deployment window",
          confidence: 0.95,
        },
      ],
    };

    const res = validateConversionOutput(validRaw);
    assert.equal(res.ok, true);
    if (res.ok && res.decision === "convert") {
      assert.equal(res.records.length, 1);
      assert.equal(res.records[0].data, "The engineering team deploys migrations during the low-traffic window.");
      assert.equal(res.records[0].type, "procedure");
      assert.equal(res.records[0].subject, "migration deployment window");
      assert.equal(res.records[0].confidence, 0.95);
    }

    // Accepts JSON string
    const stringRes = validateConversionOutput(JSON.stringify(validRaw));
    assert.equal(stringRes.ok, true);
  });

  await t.test("valid convert decision with exactly 6 records accepted and produces 6 validated records", () => {
    const validRaw = {
      decision: "convert",
      records: [
        { data: "First valid atomic fact recorded here.", type: "fact", subject: "subject one", confidence: 0.9 },
        { data: "Second valid atomic fact recorded here.", type: "fact", subject: "subject two", confidence: 0.9 },
        { data: "Third valid atomic fact recorded here.", type: "fact", subject: "subject three", confidence: 0.9 },
        { data: "Fourth valid atomic fact recorded here.", type: "fact", subject: "subject four", confidence: 0.9 },
        { data: "Fifth valid atomic fact recorded here.", type: "fact", subject: "subject five", confidence: 0.9 },
        { data: "Sixth valid atomic fact recorded here.", type: "fact", subject: "subject six", confidence: 0.9 },
      ],
    };

    const res = validateConversionOutput(validRaw);
    assert.equal(res.ok, true);
    if (res.ok && res.decision === "convert") {
      assert.equal(res.records.length, 6);
      for (let i = 0; i < 6; i++) {
        assert.equal(res.records[i].data, validRaw.records[i].data);
        assert.equal(res.records[i].type, validRaw.records[i].type);
        assert.equal(res.records[i].subject, validRaw.records[i].subject);
        assert.equal(res.records[i].confidence, validRaw.records[i].confidence);
      }
    }
  });

  await t.test("valid drop_noise and drop_sensitive decisions with empty records", () => {
    const noiseRes = validateConversionOutput({
      decision: "drop_noise",
      records: [],
    });
    assert.equal(noiseRes.ok, true);
    if (noiseRes.ok) {
      assert.equal(noiseRes.decision, "drop_noise");
      assert.deepEqual(noiseRes.records, []);
    }

    const sensRes = validateConversionOutput({
      decision: "drop_sensitive",
      records: [],
    });
    assert.equal(sensRes.ok, true);
    if (sensRes.ok) {
      assert.equal(sensRes.decision, "drop_sensitive");
      assert.deepEqual(sensRes.records, []);
    }
  });
});

test("validateConversionOutput reject codes table", async (t) => {
  const cases: Array<{
    name: string;
    raw: unknown;
    expectedCode: (typeof CONVERSION_REJECT_CODES)[number];
    expectedSensitiveFamily?: string;
  }> = [
    {
      name: "not_json",
      raw: "{ malformed json [",
      expectedCode: "not_json",
    },
    {
      name: "not_object (array)",
      raw: [],
      expectedCode: "not_object",
    },
    {
      name: "not_object (null)",
      raw: null,
      expectedCode: "not_object",
    },
    {
      name: "not_object (number)",
      raw: 42,
      expectedCode: "not_object",
    },
    {
      name: "decision_invalid",
      raw: { decision: "unknown_decision", records: [] },
      expectedCode: "decision_invalid",
    },
    {
      name: "records_not_array",
      raw: { decision: "convert", records: "not-an-array" },
      expectedCode: "records_not_array",
    },
    {
      name: "records_not_empty_on_drop (drop_noise)",
      raw: {
        decision: "drop_noise",
        records: [{ data: "Some text here", type: "fact", subject: "test", confidence: 0.9 }],
      },
      expectedCode: "records_not_empty_on_drop",
    },
    {
      name: "records_not_empty_on_drop (drop_sensitive)",
      raw: {
        decision: "drop_sensitive",
        records: [{ data: "Some text here", type: "fact", subject: "test", confidence: 0.9 }],
      },
      expectedCode: "records_not_empty_on_drop",
    },
    {
      name: "empty_records (convert with 0 records)",
      raw: { decision: "convert", records: [] },
      expectedCode: "empty_records",
    },
    {
      name: "too_many_records (>6 records)",
      raw: {
        decision: "convert",
        records: [
          { data: "First valid atomic fact.", type: "fact", subject: "first", confidence: 0.9 },
          { data: "Second valid atomic fact.", type: "fact", subject: "second", confidence: 0.9 },
          { data: "Third valid atomic fact.", type: "fact", subject: "third", confidence: 0.9 },
          { data: "Fourth valid atomic fact.", type: "fact", subject: "fourth", confidence: 0.9 },
          { data: "Fifth valid atomic fact.", type: "fact", subject: "fifth", confidence: 0.9 },
          { data: "Sixth valid atomic fact.", type: "fact", subject: "sixth", confidence: 0.9 },
          { data: "Seventh valid atomic fact.", type: "fact", subject: "seventh", confidence: 0.9 },
        ],
      },
      expectedCode: "too_many_records",
    },
    {
      name: "data_not_string",
      raw: {
        decision: "convert",
        records: [{ data: 12345, type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_not_string",
    },
    {
      name: "data_too_short (<8 chars)",
      raw: {
        decision: "convert",
        records: [{ data: "Too few", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_too_short",
    },
    {
      name: "data_too_long (>400 chars)",
      raw: {
        decision: "convert",
        records: [{ data: "A".repeat(401), type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_too_long",
    },
    {
      name: "data_not_atomic (newline character)",
      raw: {
        decision: "convert",
        records: [{ data: "First sentence here.\nSecond line here.", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_not_atomic",
    },
    {
      name: "data_not_atomic (semicolon)",
      raw: {
        decision: "convert",
        records: [{ data: "First clause here; second clause follows.", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_not_atomic",
    },
    {
      name: "data_not_atomic (second sentence via . followed by space and non-space)",
      raw: {
        decision: "convert",
        records: [{ data: "First sentence ends here. Another sentence starts.", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_not_atomic",
    },
    {
      name: "data_not_atomic (conjunction chaining: and also)",
      raw: {
        decision: "convert",
        records: [{ data: "We prefer PostgreSQL and also prefer Redis for caching.", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_not_atomic",
    },
    {
      name: "data_sensitive_echo (sensitive token in model output data)",
      raw: {
        decision: "convert",
        records: [{ data: "Database password is password = secretPassword12345 for admin", type: "fact", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "data_sensitive_echo",
      expectedSensitiveFamily: "passwordAssignment",
    },
    {
      name: "type_invalid",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "opinion", subject: "subject", confidence: 0.9 }],
      },
      expectedCode: "type_invalid",
    },
    {
      name: "subject_invalid (too short)",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "fact", subject: "a", confidence: 0.9 }],
      },
      expectedCode: "subject_invalid",
    },
    {
      name: "subject_invalid (too long)",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "fact", subject: "x".repeat(81), confidence: 0.9 }],
      },
      expectedCode: "subject_invalid",
    },
    {
      name: "confidence_invalid (negative)",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "fact", subject: "subject", confidence: -0.1 }],
      },
      expectedCode: "confidence_invalid",
    },
    {
      name: "confidence_invalid (>1)",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "fact", subject: "subject", confidence: 1.5 }],
      },
      expectedCode: "confidence_invalid",
    },
    {
      name: "confidence_invalid (non-finite)",
      raw: {
        decision: "convert",
        records: [{ data: "Valid atomic sentence text.", type: "fact", subject: "subject", confidence: NaN }],
      },
      expectedCode: "confidence_invalid",
    },
  ];

  for (const tc of cases) {
    await t.test(`rejects with ${tc.expectedCode}: ${tc.name}`, () => {
      const res = validateConversionOutput(tc.raw);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.rejectCode, tc.expectedCode);
        if (tc.expectedSensitiveFamily && res.rejectCode === "data_sensitive_echo") {
          assert.equal(res.sensitiveReasonCode, tc.expectedSensitiveFamily);
        }
      }
    });
  }
});

test("buildTargetPayload invariants", async (t) => {
  const baseInput = {
    record: {
      data: "The organization holds security reviews on Wednesday afternoons.",
      type: "procedure" as const,
      subject: "security review scheduling",
      confidence: 0.9,
    },
    sourceId: "44444444-4444-4444-4444-444444444444",
    agentId: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    upgradeId: "33333333-3333-3333-3333-333333333333",
    sourcePayloadCreatedAt: "2026-01-15T12:00:00.000Z",
    conversionTimeIso: "2026-03-01T15:30:00.000Z",
  };

  await t.test("omits run/issue/user keys when absent on sourcePayload", () => {
    const payload = buildTargetPayload({
      ...baseInput,
      sourcePayload: {
        agent_id: baseInput.agentId,
        user_id: "company",
        data: "legacy raw data",
      },
    });

    assert.equal(payload.data, baseInput.record.data);
    assert.equal(payload.user_id, baseInput.agentId);
    assert.equal(payload.agent_id, baseInput.agentId);
    assert.equal(payload.created_at, "2026-01-15T12:00:00.000Z");
    assert.equal(payload.updated_at, "2026-03-01T15:30:00.000Z");
    assert.equal(payload.type, "procedure");
    assert.equal(payload.subject, "security review scheduling");
    assert.equal(payload.confidence, 0.9);
    assert.equal(payload.paperclip_company_id, baseInput.companyId);
    assert.equal(payload.migrated_from, baseInput.sourceId);
    assert.equal(payload.migration_id, baseInput.upgradeId);
    assert.deepEqual(payload.converter, { id: CONVERTER_ID, version: CONVERTER_VERSION });

    // Carry forward keys must be strictly ABSENT (not even null or undefined)
    assert.equal("paperclip_run_id" in payload, false, "paperclip_run_id must be absent");
    assert.equal("run_id" in payload, false, "run_id must be absent");
    assert.equal("issue_id" in payload, false, "issue_id must be absent");
    assert.equal("responsible_user_id" in payload, false, "responsible_user_id must be absent");
  });

  await t.test("carries forward run/issue/user keys when present on sourcePayload", () => {
    const payload = buildTargetPayload({
      ...baseInput,
      sourcePayload: {
        agent_id: baseInput.agentId,
        data: "legacy raw data",
        paperclip_run_id: "run-pc-100",
        run_id: "run-legacy-200",
        issue_id: "issue-300",
        responsible_user_id: "user-400",
      },
    });

    assert.equal(payload.paperclip_run_id, "run-pc-100");
    assert.equal(payload.run_id, "run-legacy-200");
    assert.equal(payload.issue_id, "issue-300");
    assert.equal(payload.responsible_user_id, "user-400");
  });

  await t.test("hash is md5 of data and computeRecordDataSha256 is sha256 of normalized text", () => {
    const payload = buildTargetPayload(baseInput);
    assert.ok(typeof payload.hash === "string" && payload.hash.length === 32);

    const dataSha = computeRecordDataSha256("   The Organization   Holds Security Reviews.  ");
    const dataShaNorm = computeRecordDataSha256("the organization holds security reviews.");
    assert.equal(dataSha, dataShaNorm, "computeRecordDataSha256 normalizes text before hashing");
    assert.equal(dataSha.length, 64);
  });

  await t.test("formatPgVectorLiteral formats vector array as JSON string", () => {
    const vec = [0.123, -0.456, 0.789];
    const literal = formatPgVectorLiteral(vec);
    assert.equal(literal, "[0.123,-0.456,0.789]");
  });
});

test("two-pass sensitive scan validates subject and data before all other checks (TECH-8191 P0)", async (t) => {
  await t.test("secret in subject only triggers data_sensitive_echo", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: "The organization holds security reviews quarterly.",
          type: "procedure",
          subject: "password = superSecretPassword123",
          confidence: 0.9,
        },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejectCode, "data_sensitive_echo");
      assert.equal(res.sensitiveReasonCode, "passwordAssignment");
    }
  });

  await t.test("secret in data + non-atomic returns data_sensitive_echo not data_not_atomic", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: "password = superSecretPassword123; and also here is a second clause.",
          type: "fact",
          subject: "secret fact",
          confidence: 0.9,
        },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejectCode, "data_sensitive_echo", "Pass 1 sensitive scan must precede atomicity check");
      assert.equal(res.sensitiveReasonCode, "passwordAssignment");
    }
  });

  await t.test("secret + data_too_long returns data_sensitive_echo not data_too_long", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: `Use key sk-123456789012345678901234567890 ${"A".repeat(500)}`,
          type: "fact",
          subject: "long secret",
          confidence: 0.9,
        },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejectCode, "data_sensitive_echo", "Pass 1 sensitive scan must precede length check");
      assert.equal(res.sensitiveReasonCode, "apiKey");
    }
  });

  await t.test("record[1] sensitive while record[0] non-atomic returns data_sensitive_echo", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: "First record is not atomic; because it has a semicolon.",
          type: "fact",
          subject: "non atomic record",
          confidence: 0.9,
        },
        {
          data: "Second record has sk-123456789012345678901234567890 key.",
          type: "fact",
          subject: "sensitive record",
          confidence: 0.9,
        },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejectCode, "data_sensitive_echo");
      assert.equal(res.sensitiveReasonCode, "apiKey");
    }
  });

  await t.test("two records different families produce sorted deduped CSV union", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: "First record has password = adminSecretPassword123 here.",
          type: "fact",
          subject: "db password",
          confidence: 0.9,
        },
        {
          data: "Second record uses sk-123456789012345678901234567890 key.",
          type: "fact",
          subject: "api key",
          confidence: 0.9,
        },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejectCode, "data_sensitive_echo");
      // "apiKey" and "passwordAssignment" sorted:
      assert.equal(res.sensitiveReasonCode, "apiKey,passwordAssignment");
    }
  });

  await t.test("clean input is completely unaffected by pass 1 scan", () => {
    const res = validateConversionOutput({
      decision: "convert",
      records: [
        {
          data: "Clean and atomic fact about configuration management.",
          type: "fact",
          subject: "configuration management",
          confidence: 0.95,
        },
      ],
    });
    assert.equal(res.ok, true);
  });
});

test("repair prompt and contract documentation invariants", async (t) => {
  await t.test("buildRepairConversionMessages appends prior assistant turn and repair rule class", () => {
    const initial = buildInitialConversionMessages("Source text here.");
    const priorResponse = JSON.stringify({ decision: "convert", records: [] });
    const repairMessages = buildRepairConversionMessages(initial, priorResponse, "empty_records");

    assert.equal(repairMessages.length, initial.length + 2);
    const assistantTurn = repairMessages[repairMessages.length - 2];
    assert.equal(assistantTurn.role, "assistant");
    assert.equal(assistantTurn.content, priorResponse);

    const userTurn = repairMessages[repairMessages.length - 1];
    assert.equal(userTurn.role, "user");
    assert.ok(userTurn.content.includes("empty_records"));
  });
});
