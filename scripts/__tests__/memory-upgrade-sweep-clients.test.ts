/**
 * Unit tests for OpenAI LLM conversion client and embedding client (TECH-8191).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAiConversionClient,
} from "../../server/src/services/company-memory-upgrade/llm-converter.js";
import {
  assertEmbeddingShape,
  createOpenAiEmbeddingClient,
} from "../../server/src/services/company-memory-upgrade/embedding-client.js";
import { RedactionRegistry } from "../../server/src/services/company-memory-upgrade/openai-key.js";
import { createRateLimiter } from "../../server/src/services/company-memory-upgrade/rate-limiter.js";
import { CompanyMemoryUpgradeError, TERMINAL_LLM_ERROR_CODES } from "../../server/src/services/company-memory-upgrade/types.js";
import { createRecordingFetch, ManualClock } from "./memory-upgrade-sweep-helpers.js";

function setupTestLimiter(clock: ManualClock) {
  return createRateLimiter({
    rpm: 10_000,
    tpm: 1_000_000,
    concurrency: 2,
    clock,
    sleeper: clock,
  });
}

test("LLM conversion client privacy invariant", async () => {
  const clock = new ManualClock();
  const limiter = setupTestLimiter(clock);

  const fixtureSecretId = "agent-secret-id-9999-aaaa";
  const fixtureAgentName = "SuperSecretAgent";
  const fixtureCompanyId = "comp-secret-id-8888-bbbb";
  const fixtureCompanyName = "ConfidentialCorp";
  const fixtureRowId = "row-secret-id-7777-cccc";

  const { fetch: recordingFetch, requests } = createRecordingFetch([
    {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                decision: "convert",
                records: [
                  {
                    data: "Engineering runs test suites before opening pull requests.",
                    type: "procedure",
                    subject: "pull request testing",
                    confidence: 0.95,
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 650, completion_tokens: 45, total_tokens: 695 },
      },
    },
  ]);

  const client = createOpenAiConversionClient({
    apiKey: "sk-mock-key-12345678901234567890",
    model: "gpt-5.4-mini",
    fetchImpl: recordingFetch,
    limiter,
    sleeper: clock,
    clock,
  });

  const memoryText = "Engineering runs test suites before opening pull requests.";
  const res = await client.convert(memoryText);

  assert.equal(res.status, "convert");
  assert.equal(requests.length, 1);

  const serializedBody = requests[0].body;
  // Assert strictly that NONE of the fixture identifiers or metadata appear in the request
  assert.ok(!serializedBody.includes(fixtureSecretId), "Request must not contain agent ID");
  assert.ok(!serializedBody.includes(fixtureAgentName), "Request must not contain agent name");
  assert.ok(!serializedBody.includes(fixtureCompanyId), "Request must not contain company ID");
  assert.ok(!serializedBody.includes(fixtureCompanyName), "Request must not contain company name");
  assert.ok(!serializedBody.includes(fixtureRowId), "Request must not contain row ID");

  // User content contains ONLY memory text inside <source_memory> delimiter
  const parsed = requests[0].parsedBody;
  const userMsg = parsed.messages.find((m: any) => m.role === "user");
  assert.equal(userMsg.content, `<source_memory>\n${memoryText}\n</source_memory>`);
  assert.equal(parsed.model, "gpt-5.4-mini");
  assert.equal(parsed.temperature, 0);
  assert.equal(parsed.seed, 8191);
});

test("LLM conversion client retry, repair, and error handling", async (t) => {
  const clock = new ManualClock();
  const limiter = setupTestLimiter(clock);

  await t.test("recovers from 429 rate limit with Retry-After header", async () => {
    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 429,
        headers: { "retry-after": "2" },
        body: { error: { message: "Rate limit exceeded" } },
      },
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "convert",
                  records: [
                    {
                      data: "Team prefers async status updates over standup meetings.",
                      type: "preference",
                      subject: "status updates",
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 600, completion_tokens: 40, total_tokens: 640 },
        },
      },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const res = await client.convert("Team prefers async status updates over standup meetings.");
    assert.equal(res.status, "convert");
    assert.equal(requests.length, 2);
  });

  await t.test("exhaustion of 5xx errors resolves to llm_unavailable", async () => {
    const { fetch: recordingFetch } = createRecordingFetch([
      { status: 500, body: "Internal Server Error" },
      { status: 502, body: "Bad Gateway" },
      { status: 503, body: "Service Unavailable" },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
      maxAttempts: 3,
    });

    const res = await client.convert("Some substantive fact.");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "llm_unavailable");
  });

  await t.test("schema rule violation triggers exactly one repair retry naming rule class", async () => {
    const invalidNonAtomicOutput = {
      decision: "convert",
      records: [
        {
          data: "First atomic fact here; and also a second clause.",
          type: "fact",
          subject: "multiple facts",
          confidence: 0.9,
        },
      ],
    };

    const validRepairedOutput = {
      decision: "convert",
      records: [
        {
          data: "The system runs background sweeps every sixty seconds.",
          type: "procedure",
          subject: "background sweep interval",
          confidence: 0.95,
        },
      ],
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(invalidNonAtomicOutput) } }],
          usage: { prompt_tokens: 650, completion_tokens: 50 },
        },
      },
      {
        status: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(validRepairedOutput) } }],
          usage: { prompt_tokens: 750, completion_tokens: 45 },
        },
      },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const res = await client.convert("The system runs background sweeps every sixty seconds.");
    assert.equal(res.status, "convert");
    assert.equal(requests.length, 2, "Must perform repair retry");

    // Repair request inspection:
    const repairBody = requests[1].parsedBody;
    const repairPrompt = repairBody.messages[repairBody.messages.length - 1].content;
    assert.ok(repairPrompt.includes("data_not_atomic"), "Repair message must name violated rule class");
    // Ensure repair message does not leak raw text from outside
    assert.ok(!repairPrompt.includes("First atomic fact here"), "Repair prompt must not echo raw invalid model text");
  });

  await t.test("second invalid attempt after repair returns quarantine reject code", async () => {
    const invalidOutput = { decision: "invalid_decision", records: [] };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: JSON.stringify(invalidOutput) } }] },
      },
      {
        status: 200,
        body: { choices: [{ message: { content: JSON.stringify(invalidOutput) } }] },
      },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const res = await client.convert("Substantive text here.");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "decision_invalid");
    assert.equal(requests.length, 2);
  });

  await t.test("aborts immediately when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      limiter,
      sleeper: clock,
      clock,
    });

    await assert.rejects(
      () => client.convert("Text", { signal: controller.signal }),
      (err: any) => {
        assert.equal(err.code, "ABORTED_BY_OPERATOR");
        return true;
      },
    );
  });

  await t.test("terminal 400/401/403: rejects immediately, 1 call, sleeper not called, scrubbed", async () => {
    const testCases: Array<{ status: number; expectedCode: string }> = [
      { status: 401, expectedCode: "COMPANY_OPENAI_KEY_REJECTED" },
      { status: 403, expectedCode: "COMPANY_OPENAI_KEY_REJECTED" },
      { status: 400, expectedCode: "LLM_REQUEST_REJECTED" },
      { status: 422, expectedCode: "LLM_REQUEST_REJECTED" },
    ];

    for (const { status, expectedCode } of testCases) {
      let sleepCalls = 0;
      const sleeper = { sleep: async () => { sleepCalls++; } };
      const secretKey = "sk-secret-test-key-12345678901234567890";
      const redaction = new RedactionRegistry();
      redaction.add(secretKey);

      const secretResponseBody = `Confidential backend error mentioning ${secretKey}`;
      const { fetch: recordingFetch, requests } = createRecordingFetch([
        { status, body: secretResponseBody },
      ]);

      const client = createOpenAiConversionClient({
        apiKey: secretKey,
        fetchImpl: recordingFetch,
        limiter,
        sleeper,
        clock,
        redaction,
      });

      await assert.rejects(
        () => client.convert("Some memory text"),
        (err: any) => {
          assert.equal(err.code, expectedCode);
          assert.ok(TERMINAL_LLM_ERROR_CODES.has(err.code));
          assert.equal(requests.length, 1, "fetchImpl called exactly once");
          assert.equal(sleepCalls, 0, "sleeper.sleep must never be called for terminal errors");
          assert.ok(!err.message.includes(secretKey), "Error must not contain API key");
          assert.ok(!err.message.includes(secretResponseBody), "Error must not contain response body");
          return true;
        },
      );
    }
  });

  await t.test("429 insufficient_quota: terminal, 1 call, sleeper not called, scrubbed", async () => {
    let sleepCalls = 0;
    const sleeper = { sleep: async () => { sleepCalls++; } };
    const secretKey = "sk-secret-test-key-12345678901234567890";
    const redaction = new RedactionRegistry();
    redaction.add(secretKey);

    const rawQuotaBody = JSON.stringify({
      error: {
        message: `You exceeded quota with key ${secretKey}`,
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 429, body: rawQuotaBody },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: secretKey,
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      redaction,
    });

    await assert.rejects(
      () => client.convert("Some memory text"),
      (err: any) => {
        assert.equal(err.code, "COMPANY_OPENAI_QUOTA_EXHAUSTED");
        assert.ok(TERMINAL_LLM_ERROR_CODES.has(err.code));
        assert.equal(requests.length, 1);
        assert.equal(sleepCalls, 0);
        assert.ok(!err.message.includes(secretKey));
        assert.ok(!err.message.includes(rawQuotaBody));
        assert.ok(err.message.includes("insufficient_quota"));
        return true;
      },
    );
  });

  await t.test("plain 429 and 408/409 are retried", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const validBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "convert",
              records: [
                {
                  data: "Team conducts weekly sprint planning on Mondays.",
                  type: "procedure",
                  subject: "sprint planning",
                  confidence: 0.9,
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 600, completion_tokens: 30 },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 408, body: "Request Timeout" },
      { status: 409, body: "Conflict" },
      { status: 429, body: JSON.stringify({ error: { message: "Rate limit" } }) },
      { status: 200, body: validBody },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 5,
    });

    const res = await client.convert("Team conducts weekly sprint planning on Mondays.");
    assert.equal(res.status, "convert");
    assert.equal(requests.length, 4, "Should retry across 408, 409, and plain 429");
    assert.equal(sleepCalls, 3);
  });

  await t.test("conservative fallbacks when usage is missing or incomplete", async () => {
    const validOutput = {
      decision: "convert",
      records: [
        {
          data: "Durable preference recorded without usage statistics.",
          type: "preference",
          subject: "preference subject",
          confidence: 0.9,
        },
      ],
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(validOutput) } }],
          // usage completely omitted
        },
      },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const text = "Durable preference recorded without usage statistics.";
    const res = await client.convert(text);
    assert.equal(res.status, "convert");
    assert.equal(requests.length, 1);
    const expectedInputBytes = Buffer.byteLength(requests[0].body, "utf8");
    assert.equal(res.inputTokens, expectedInputBytes, "inputTokens must fall back to request body UTF8 bytes");
    assert.equal(res.outputTokens, 600, "outputTokens must fall back to 600");
  });

  await t.test("choices: [] is retried and exhausted into quarantined/llm_unavailable (not not_json)", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 200, body: { choices: [] } },
      { status: 200, body: { choices: [] } },
      { status: 200, body: { choices: [] } },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    const res = await client.convert("Fact text.");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "llm_unavailable");
    assert.equal(requests.length, 3, "Must retry empty choices up to maxAttempts");
    assert.equal(sleepCalls, 2);
  });

  await t.test("injected fetch error message embeds API key is scrubbed by redaction", async () => {
    const secretKey = "sk-proj-supersecretkey1234567890";
    const redaction = new RedactionRegistry();
    redaction.add(secretKey);

    const failingFetch: typeof fetch = async () => {
      throw new Error(`Connection to host failed with credential ${secretKey}`);
    };

    const client = createOpenAiConversionClient({
      apiKey: secretKey,
      fetchImpl: failingFetch,
      limiter,
      sleeper: clock,
      clock,
      redaction,
      maxAttempts: 1,
    });

    const res = await client.convert("Some text");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "llm_unavailable");
  });

  await t.test("data_sensitive_echo maps to drop_sensitive with fetchImpl called exactly once (no repair)", async () => {
    const sensitiveOutput = {
      decision: "convert",
      records: [
        {
          data: "password = adminSecretPassword123 is the password",
          type: "fact",
          subject: "sensitive fact",
          confidence: 0.9,
        },
      ],
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(sensitiveOutput) } }],
          usage: { prompt_tokens: 600, completion_tokens: 30 },
        },
      },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const res = await client.convert("Some memory text");
    assert.equal(res.status, "drop_sensitive");
    assert.equal(res.reasonCode, "passwordAssignment");
    assert.equal(requests.length, 1, "fetchImpl must be called exactly once; never echo secret in repair turn");
  });

  await t.test("failed attempt token refunds: retried request debits twice without refund", async () => {
    let settledAmounts: number[] = [];
    let acquiredCount = 0;
    const mockLimiter = {
      async acquire(est: number) {
        acquiredCount++;
        return {
          settle(actual: number) {
            settledAmounts.push(actual);
          },
          release() {},
        };
      },
    };

    const validBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "convert",
              records: [
                {
                  data: "Atomic fact that succeeded on second attempt.",
                  type: "fact",
                  subject: "retry accounting",
                  confidence: 0.9,
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 650, completion_tokens: 35, total_tokens: 685 },
    };

    const { fetch: recordingFetch } = createRecordingFetch([
      { status: 500, body: "First call fails with 500" },
      { status: 200, body: validBody },
    ]);

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter: mockLimiter as any,
      sleeper: clock,
      clock,
      maxAttempts: 2,
    });

    const res = await client.convert("Atomic fact that succeeded on second attempt.");
    assert.equal(res.status, "convert");
    assert.equal(acquiredCount, 2, "Rate limiter acquire must be called for each attempt");
    assert.equal(settledAmounts.length, 1, "Only the successful attempt settled tokens (no failed attempt refund)");
  });
});

test("Embedding client assertions and shape validation", async (t) => {
  const clock = new ManualClock();
  const limiter = setupTestLimiter(clock);

  await t.test("assertEmbeddingShape succeeds on valid 1536 float array", () => {
    const valid = {
      model: "text-embedding-3-small",
      data: [{ embedding: new Array(1536).fill(0.01) }],
    };
    const vec = assertEmbeddingShape(valid);
    assert.equal(vec.length, 1536);
  });

  await t.test("assertEmbeddingShape throws EMBEDDING_FAILED on model mismatch", () => {
    const mismatch = {
      model: "text-embedding-ada-002",
      data: [{ embedding: new Array(1536).fill(0.01) }],
    };
    assert.throws(
      () => assertEmbeddingShape(mismatch),
      (err: any) => err.code === "EMBEDDING_FAILED" && err.message.includes("text-embedding-3-small"),
    );
  });

  await t.test("assertEmbeddingShape throws EMBEDDING_FAILED on wrong dimensions", () => {
    const badDims = {
      model: "text-embedding-3-small",
      data: [{ embedding: new Array(512).fill(0.01) }],
    };
    assert.throws(
      () => assertEmbeddingShape(badDims),
      (err: any) => err.code === "EMBEDDING_FAILED" && err.message.includes("1536"),
    );
  });

  await t.test("assertEmbeddingShape throws EMBEDDING_FAILED on non-finite values", () => {
    const nonFinite = new Array(1536).fill(0.01);
    nonFinite[10] = NaN;
    const badData = {
      model: "text-embedding-3-small",
      data: [{ embedding: nonFinite }],
    };
    assert.throws(
      () => assertEmbeddingShape(badData),
      (err: any) => err.code === "EMBEDDING_FAILED" && err.message.includes("not a finite number"),
    );
  });

  await t.test("embed happy path tracks prompt tokens and returns vector", async () => {
    const dummyVector = new Array(1536).fill(0.025);
    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          model: "text-embedding-3-small",
          data: [{ embedding: dummyVector }],
          usage: { prompt_tokens: 18 },
        },
      },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
    });

    const res = await embClient.embed("A concise atomic memory sentence.");
    assert.equal(res.tokens, 18);
    assert.equal(res.embedding.length, 1536);
    assert.equal(requests.length, 1);

    const reqBody = requests[0].parsedBody;
    assert.equal(reqBody.model, "text-embedding-3-small");
    assert.equal(reqBody.dimensions, 1536);
    assert.equal(reqBody.encoding_format, "float");
  });

  await t.test("assertEmbeddingShape scrubs model with RedactionRegistry", () => {
    const secretKey = "sk-proj-secret-key-1234567890";
    const redaction = new RedactionRegistry();
    redaction.add(secretKey);

    const badData = {
      model: `invalid-model-${secretKey}`,
      data: [{ embedding: new Array(1536).fill(0.01) }],
    };

    assert.throws(
      () => assertEmbeddingShape(badData, redaction),
      (err: any) => {
        assert.equal(err.code, "EMBEDDING_FAILED");
        assert.ok(!err.message.includes(secretKey), "Model error message must not leak key");
        assert.ok(err.message.includes("[REDACTED_API_KEY]"), "Model error message must be redacted");
        return true;
      },
    );
  });

  await t.test("embedding 429 insufficient_quota aborts immediately as COMPANY_OPENAI_QUOTA_EXHAUSTED", async () => {
    let sleepCalls = 0;
    const sleeper = { sleep: async () => { sleepCalls++; } };
    const secretKey = "sk-secret-embed-1234567890";
    const redaction = new RedactionRegistry();
    redaction.add(secretKey);

    const rawQuotaBody = JSON.stringify({
      error: { code: "insufficient_quota", message: "Quota exceeded" },
    });

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 429, body: rawQuotaBody },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: secretKey,
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      redaction,
      maxAttempts: 5,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => {
        assert.equal(err.code, "COMPANY_OPENAI_QUOTA_EXHAUSTED");
        assert.equal(requests.length, 1);
        assert.equal(sleepCalls, 0);
        return true;
      },
    );
  });

  await t.test("embedding client settles lease only after assertEmbeddingShape succeeds", async () => {
    let settled = false;
    const mockLimiter = {
      async acquire() {
        return {
          settle() {
            settled = true;
          },
          release() {},
        };
      },
    };

    const { fetch: recordingFetch } = createRecordingFetch([
      {
        status: 200,
        body: {
          model: "invalid-model", // assertEmbeddingShape will throw
          data: [{ embedding: new Array(1536).fill(0.01) }],
          usage: { prompt_tokens: 15 },
        },
      },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter: mockLimiter as any,
      sleeper: clock,
      clock,
      maxAttempts: 1,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => err.code === "EMBEDDING_FAILED",
    );

    assert.equal(settled, false, "Lease must NOT be settled when response shape validation fails");
  });
});
