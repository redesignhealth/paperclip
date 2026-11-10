/**
 * Unit tests for OpenAI LLM conversion client and embedding client (TECH-8191).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversionRequestBody,
  buildInitialConversionMessages,
  buildRepairConversionMessages,
  createOpenAiConversionClient,
  PREFLIGHT_MAX_COMPLETION_TOKENS,
  projectWorstCaseRepairRequestBodyBytes,
} from "../../server/src/services/company-memory-upgrade/llm-converter.js";
import { CANONICAL_CONVERSION_PARAMS } from "../../server/src/services/company-memory-upgrade/converter-contract.js";
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

test("canonical conversion request body params match contract", () => {
  const messages = buildInitialConversionMessages("Sample memory text");
  const bodyJson = buildConversionRequestBody("gpt-5.4-mini", messages);
  const parsed = JSON.parse(bodyJson);

  assert.equal(parsed.temperature, CANONICAL_CONVERSION_PARAMS.temperature);
  assert.equal(parsed.top_p, CANONICAL_CONVERSION_PARAMS.top_p);
  assert.equal(parsed.seed, CANONICAL_CONVERSION_PARAMS.seed);
  assert.equal(parsed.max_completion_tokens, CANONICAL_CONVERSION_PARAMS.max_completion_tokens);
  assert.equal(PREFLIGHT_MAX_COMPLETION_TOKENS, CANONICAL_CONVERSION_PARAMS.max_completion_tokens);
});

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

  await t.test("429 insufficient_quota detected via error.type and non-JSON substring fallback", async () => {
    // 1. error.type without error.code
    const typeQuotaBody = JSON.stringify({
      error: {
        message: "You have run out of credits",
        type: "insufficient_quota",
      },
    });

    const { fetch: fetch1 } = createRecordingFetch([
      { status: 429, body: typeQuotaBody },
    ]);

    const client1 = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: fetch1,
      limiter,
      sleeper: clock,
      clock,
    });

    await assert.rejects(
      () => client1.convert("Memory"),
      (err: any) => err.code === "COMPANY_OPENAI_QUOTA_EXHAUSTED",
    );

    // 2. Non-JSON substring fallback
    const rawSubstringBody = "<html><body>error: insufficient_quota for project</body></html>";
    const { fetch: fetch2 } = createRecordingFetch([
      { status: 429, body: rawSubstringBody },
    ]);

    const client2 = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: fetch2,
      limiter,
      sleeper: clock,
      clock,
    });

    await assert.rejects(
      () => client2.convert("Memory"),
      (err: any) => {
        assert.equal(err.code, "COMPANY_OPENAI_QUOTA_EXHAUSTED");
        assert.ok(!err.message.includes(rawSubstringBody), "Must never interpolate error body");
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

  await t.test("choices: [] is treated as billed_unusable without retrying (exact usage passthrough variant)", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        },
      },
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
    assert.equal(requests.length, 1, "Must not retry billed empty choices");
    assert.equal(sleepCalls, 0, "Must not sleep or backoff on billed unusable response");
    assert.equal(res.inputTokens, 120, "Must pass through exact prompt_tokens from usage");
    assert.equal(res.outputTokens, 45, "Must pass through exact completion_tokens from usage");
  });

  await t.test("choices: [] is treated as billed_unusable without retrying ((bodyBytes, 600) fallback variant)", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
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
    assert.equal(requests.length, 1, "Must not retry billed empty choices");
    assert.equal(sleepCalls, 0, "Must not sleep or backoff on billed unusable response");
    const expectedInputBytes = Buffer.byteLength(requests[0].body, "utf8");
    assert.equal(res.inputTokens, expectedInputBytes, "Must fall back to request body bytes");
    assert.equal(res.outputTokens, 600, "Must fall back to 600 output tokens");
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

  await t.test("malformed JSON containing a credential -> drop_sensitive with fetchImpl called exactly once", async () => {
    const malformedBodyWithKey = '{ "decision": "convert", "records": [ invalid json sk-123456789012345678901234567890 ';
    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: malformedBodyWithKey } }],
          usage: { prompt_tokens: 500, completion_tokens: 20 },
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

    const res = await client.convert("Some memory text with malformed LLM response");
    assert.equal(res.status, "drop_sensitive");
    assert.equal(res.reasonCode, "apiKey");
    assert.equal(requests.length, 1, "fetchImpl must be called exactly once; must not issue repair turn on sensitive raw output");
  });

  await t.test("too_many_records + secret -> drop_sensitive with fetchImpl called exactly once", async () => {
    const tooManyRecordsWithSecret = {
      decision: "convert",
      records: [
        { data: "First record has secret password = superSecretPassword123", type: "fact", subject: "s1", confidence: 0.9 },
        { data: "Second clean record data text.", type: "fact", subject: "s2", confidence: 0.9 },
        { data: "Third clean record data text.", type: "fact", subject: "s3", confidence: 0.9 },
        { data: "Fourth clean record data text.", type: "fact", subject: "s4", confidence: 0.9 },
      ],
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(tooManyRecordsWithSecret) } }],
          usage: { prompt_tokens: 500, completion_tokens: 50 },
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
    assert.equal(requests.length, 1, "fetchImpl must be called exactly once; must not issue repair turn on sensitive raw output");
  });

  await t.test("unreadable 200 body is quarantined without retrying", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    let callCount = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];
    const customFetch: typeof fetch = async (url, init) => {
      callCount++;
      requests.push({ url: String(url), init, body: String(init?.body ?? "") });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("Premature EOF during body read with key sk-secret-1234567890");
        },
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: customFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    const res = await client.convert("Input text");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "llm_unavailable");
    assert.equal(callCount, 1, "Must never retry a billed 200 response with unreadable body");
    assert.equal(sleepCalls, 0, "Must not sleep or backoff on billed unusable response");
    assert.equal(res.inputTokens, Buffer.byteLength(requests[0].body, "utf8"));
    assert.equal(res.outputTokens, 600);
  });

  await t.test("repair-turn case: call 1 schema-invalid triggers repair, call 2 json() rejects -> quarantined/llm_unavailable", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    let callCount = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];
    const schemaInvalidOutput = {
      decision: "convert",
      records: [
        {
          data: "Fact 1 and Fact 2",
          type: "fact",
          subject: "subject",
        },
      ],
    };

    const customFetch: typeof fetch = async (url, init) => {
      callCount++;
      requests.push({ url: String(url), init, body: String(init?.body ?? "") });
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(schemaInvalidOutput) } }],
            usage: { prompt_tokens: 150, completion_tokens: 40 },
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("Premature EOF on repair attempt body");
        },
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: customFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    const res = await client.convert("Input text requiring repair");
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "llm_unavailable");
    assert.equal(callCount, 2, "Must execute call 1 (initial) and call 2 (repair)");
    assert.equal(sleepCalls, 0, "No backoff sleep on billed unusable response");
    const expectedCall2BodyBytes = Buffer.byteLength(requests[1].body, "utf8");
    assert.equal(res.inputTokens, 150 + expectedCall2BodyBytes);
    assert.equal(res.outputTokens, 40 + 600);
  });

  await t.test("quote-heavy/control/multibyte schema-invalid call 1: oversize repair request is intercepted and never sent; first-call usage counted", async () => {
    let callCount = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];
    const subClock = new ManualClock();
    const subLimiter = setupTestLimiter(subClock);

    const sourceText = "Input text with oversize repair echo potential";
    const model = "gpt-5.4-mini";

    // Call 1 returns schema-invalid JSON packed with control characters that escape to \u00XX (6 bytes each),
    // genuinely exceeding the escape-aware preflight projection (600 * 24 bytes).
    const oversizeSchemaInvalidContent = JSON.stringify({
      invalid: "\u0000".repeat(4000),
    });

    const wouldBeRepairMessages = buildRepairConversionMessages(
      buildInitialConversionMessages(sourceText),
      oversizeSchemaInvalidContent,
      "decision_invalid",
    );
    const wouldBeRepairBody = buildConversionRequestBody(model, wouldBeRepairMessages);
    const wouldBeBytes = Buffer.byteLength(wouldBeRepairBody, "utf8");
    const projectedBytes = projectWorstCaseRepairRequestBodyBytes(sourceText, model);
    assert.ok(
      wouldBeBytes > projectedBytes,
      `Would-be repair body (${wouldBeBytes} bytes) must strictly exceed projected bound (${projectedBytes} bytes)`,
    );

    const customFetch: typeof fetch = async (url, init) => {
      callCount++;
      requests.push({ url: String(url), init, body: String(init?.body ?? "") });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: oversizeSchemaInvalidContent } }],
          usage: { prompt_tokens: 125, completion_tokens: 600 },
        }),
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      model,
      fetchImpl: customFetch,
      limiter: subLimiter,
      sleeper: subClock,
      clock: subClock,
      maxAttempts: 3,
    });

    const res = await client.convert(sourceText);
    assert.equal(res.status, "quarantined");
    assert.equal(res.rejectCode, "decision_invalid");
    assert.equal(callCount, 1, "Must NEVER issue call 2 (oversize repair request intercepted before fetch)");
    assert.equal(requests.length, 1, "Only initial request was dispatched");
    assert.ok(
      requests[0].body.includes("Input text with oversize repair echo potential"),
      "Initial request body contains input text",
    );
    assert.equal(res.inputTokens, 125, "Reports ONLY first-call input tokens");
    assert.equal(res.outputTokens, 600, "Reports ONLY first-call output tokens");
  });

  await t.test("realistic quote-heavy JSON-ish ~600-token reply that previously tripped guard is within bound and executes repair call (2 fetches)", async () => {
    let callCount = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];
    const subClock = new ManualClock();
    const subLimiter = setupTestLimiter(subClock);

    const sourceText = "A user interaction with multiple memories to extract";
    const model = "gpt-5.4-mini";

    // Realistic quote-heavy JSON-ish reply (~2800 bytes, ~600 tokens worth).
    // Under the old 4 bytes/token bound (2400 bytes echo allowance), this would exceed the bound and be skipped.
    // Under the escape-aware 24 bytes/token bound (14400 bytes echo allowance), it is within bound.
    const quoteHeavyInvalidContent = JSON.stringify({
      malformed: true,
      context: "User said: \"Please remember 'key-quote-1' and 'key-quote-2'\".",
      details: Array.from({ length: 30 }, (_, i) => `item_${i}: "quoted value with \\"escaped\\" text and / slashes"`).join(", "),
      nested: { a: "quote \"test\"", b: "another \"quote\" here", c: "end of \"stream\"" },
    });

    const initialMessages = buildInitialConversionMessages(sourceText);
    const wouldBeRepairMessages = buildRepairConversionMessages(
      initialMessages,
      quoteHeavyInvalidContent,
      "decision_invalid",
    );
    const repairBody = buildConversionRequestBody(model, wouldBeRepairMessages);
    const repairBytes = Buffer.byteLength(repairBody, "utf8");

    const emptyEchoBody = buildConversionRequestBody(
      model,
      buildRepairConversionMessages(initialMessages, "", "records_not_empty_on_drop"),
    );
    const oldProjectedBound = Buffer.byteLength(emptyEchoBody, "utf8") + 600 * 4;
    const newProjectedBound = projectWorstCaseRepairRequestBodyBytes(sourceText, model);

    assert.ok(
      repairBytes > oldProjectedBound,
      `Actual repair body (${repairBytes} bytes) must exceed old 4-byte/token bound (${oldProjectedBound} bytes)`,
    );
    assert.ok(
      repairBytes <= newProjectedBound,
      `Actual repair body (${repairBytes} bytes) must be within new bound (${newProjectedBound} bytes)`,
    );

    const customFetch: typeof fetch = async (url, init) => {
      callCount++;
      requests.push({ url: String(url), init, body: String(init?.body ?? "") });
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            choices: [{ message: { content: quoteHeavyInvalidContent } }],
            usage: { prompt_tokens: 125, completion_tokens: 600 },
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "convert",
                  records: [
                    {
                      data: "Extracted memory after successful repair",
                      type: "fact",
                      subject: "user",
                      confidence: 0.9,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 50 },
        }),
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      model,
      fetchImpl: customFetch,
      limiter: subLimiter,
      sleeper: subClock,
      clock: subClock,
      maxAttempts: 3,
    });

    const res = await client.convert(sourceText);
    assert.equal(callCount, 2, "Repair call must be issued (2 fetches)");
    assert.equal(requests.length, 2, "Exactly 2 requests dispatched");
    assert.equal(res.status, "convert");
    if (res.status === "convert") {
      assert.equal(res.records.length, 1);
    }
    assert.equal(res.inputTokens, 125 + 200);
    assert.equal(res.outputTokens, 600 + 50);
  });

  await t.test("repair call rate-limiter reservation covers actual serialized repair request body bytes plus PREFLIGHT_MAX_COMPLETION_TOKENS with no billed200 retries", async () => {
    let callCount = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];
    const acquiredEstimates: number[] = [];
    const subClock = new ManualClock();
    const baseLimiter = setupTestLimiter(subClock);

    const trackingLimiter = {
      async acquire(est: number) {
        acquiredEstimates.push(est);
        return baseLimiter.acquire(est);
      },
    };

    const sourceText = "User discussed quarterly planning and product milestones";
    const model = "gpt-5.4-mini";

    const schemaInvalidContent = JSON.stringify({
      unexpected_key: "invalid schema payload",
      details: "triggers schema validation rejection and repair turn",
    });

    const customFetch: typeof fetch = async (url, init) => {
      callCount++;
      requests.push({ url: String(url), init, body: String(init?.body ?? "") });
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            choices: [{ message: { content: schemaInvalidContent } }],
            usage: { prompt_tokens: 110, completion_tokens: 65 },
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "convert",
                  records: [
                    {
                      data: "User planned product milestones for Q3",
                      type: "fact",
                      subject: "user",
                      confidence: 0.92,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 165, completion_tokens: 40 },
        }),
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      model,
      fetchImpl: customFetch,
      limiter: trackingLimiter,
      sleeper: subClock,
      clock: subClock,
      maxAttempts: 3,
    });

    const res = await client.convert(sourceText);

    // Call 1 succeeded with HTTP 200 (billed) so it must never be retried at the transport layer;
    // Exactly 2 fetches dispatched: initial attempt + single repair attempt.
    assert.equal(callCount, 2, "Exactly 2 fetches dispatched: initial attempt + single repair turn (no billed 200 retries)");
    assert.equal(requests.length, 2, "No spurious retries dispatched");
    assert.equal(acquiredEstimates.length, 2, "Exactly 2 limiter acquire calls recorded");

    const repairRequestBody = requests[1].body;
    const actualRepairBytes = Buffer.byteLength(repairRequestBody, "utf8");
    const repairAcquiredEstimate = acquiredEstimates[1];

    assert.ok(
      repairAcquiredEstimate >= actualRepairBytes + PREFLIGHT_MAX_COMPLETION_TOKENS,
      `Repair acquire estimate (${repairAcquiredEstimate}) must cover actual repair body bytes (${actualRepairBytes}) + PREFLIGHT_MAX_COMPLETION_TOKENS (${PREFLIGHT_MAX_COMPLETION_TOKENS})`,
    );

    assert.equal(res.status, "convert");
    assert.equal(res.inputTokens, 110 + 165);
    assert.equal(res.outputTokens, 65 + 40);
  });

  await t.test("abort-during-body-read rejects ABORTED_BY_OPERATOR not quarantine", async () => {
    const controller = new AbortController();
    const abortingFetch: typeof fetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          controller.abort();
          throw new Error("aborted during stream read");
        },
      } as any;
    };

    const client = createOpenAiConversionClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: abortingFetch,
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

  await t.test("embedding client throws EMBEDDING_FAILED on unreadable 200 body without retrying", async () => {
    let callCount = 0;
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const customFetch: typeof fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("Premature EOF during body read with key sk-secret-1234567890");
        },
      } as any;
    };

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: customFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => {
        assert.equal(err.code, "EMBEDDING_FAILED");
        assert.equal(callCount, 1, "Must fail immediately without retrying billed 200");
        assert.equal(sleepCalls, 0, "Sleeper must never be called");
        assert.ok(!err.message.includes("sk-secret-1234567890"), "Must not leak secret in error message");
        assert.ok(!err.message.includes("Premature EOF"), "Must not leak response-derived text");
        return true;
      },
    );
  });

  await t.test("retries on 5xx (500/502/503) and 408/409", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 500, body: "internal error" },
      { status: 502, body: "bad gateway" },
      { status: 408, body: "timeout" },
      { status: 409, body: "conflict" },
      {
        status: 200,
        body: {
          model: "text-embedding-3-small",
          data: [{ embedding: new Array(1536).fill(0.01) }],
          usage: { prompt_tokens: 10 },
        },
      },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 6,
    });

    const res = await embClient.embed("Text to embed");
    assert.equal(res.tokens, 10);
    assert.equal(requests.length, 5);
    assert.equal(sleepCalls, 4);
  });

  await t.test("retries on network error", async () => {
    let callCount = 0;
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };
    const networkFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("DNS resolution failed");
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          model: "text-embedding-3-small",
          data: [{ embedding: new Array(1536).fill(0.01) }],
          usage: { prompt_tokens: 8 },
        }),
      } as any;
    };

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: networkFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    const res = await embClient.embed("Text to embed");
    assert.equal(res.tokens, 8);
    assert.equal(callCount, 2);
    assert.equal(sleepCalls, 1);
  });

  await t.test("M3: transport error exhaustion without redaction yields static error message with no injected text", async () => {
    const secretKey = "sk-proj-transportleaksecret9999";
    const failingFetch: typeof fetch = async () => {
      throw new Error(`Connection timeout carrying ${secretKey}`);
    };

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: failingFetch,
      limiter,
      sleeper: clock,
      clock,
      maxAttempts: 2,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => {
        assert.equal(err.code, "EMBEDDING_FAILED");
        assert.equal(err.message, "OpenAI embedding request failed after 2 attempts.");
        assert.ok(!err.message.includes(secretKey), "Must not leak secret text");
        assert.ok(!err.message.includes("Connection timeout"), "Must not interpolate raw error without redaction");
        return true;
      },
    );
  });

  await t.test("M3: transport error exhaustion with redaction interpolates scrubbed error message", async () => {
    const secretKey = "sk-proj-transportleaksecret8888";
    const redaction = new RedactionRegistry();
    redaction.add(secretKey);

    const failingFetch: typeof fetch = async () => {
      throw new Error(`Connection timeout carrying ${secretKey}`);
    };

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: failingFetch,
      limiter,
      sleeper: clock,
      clock,
      redaction,
      maxAttempts: 2,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => {
        assert.equal(err.code, "EMBEDDING_FAILED");
        assert.ok(err.message.includes("[REDACTED_API_KEY]"), "Must scrub secret using redaction registry");
        assert.ok(!err.message.includes(secretKey), "Must not leak raw secret");
        assert.ok(err.message.startsWith("OpenAI embedding request failed after 2 attempts: Connection timeout carrying"));
        return true;
      },
    );
  });

  await t.test("attempt exhaustion throws EMBEDDING_FAILED", async () => {
    let sleepCalls = 0;
    const sleeper = {
      sleep: async (ms: number) => {
        sleepCalls++;
        clock.advance(ms);
      },
    };

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      { status: 503, body: "service unavailable" },
      { status: 503, body: "service unavailable" },
      { status: 503, body: "service unavailable" },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper,
      clock,
      maxAttempts: 3,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed"),
      (err: any) => {
        assert.equal(err.code, "EMBEDDING_FAILED");
        assert.equal(requests.length, 3);
        assert.equal(sleepCalls, 2);
        return true;
      },
    );
  });

  await t.test("aborts immediately when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const { fetch: recordingFetch, requests } = createRecordingFetch([
      {
        status: 200,
        body: {
          model: "text-embedding-3-small",
          data: [{ embedding: new Array(1536).fill(0.01) }],
          usage: { prompt_tokens: 10 },
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

    await assert.rejects(
      () => embClient.embed("Text to embed", { signal: controller.signal }),
      (err: any) => {
        assert.equal(err.code, "ABORTED_BY_OPERATOR");
        assert.equal(requests.length, 0);
        return true;
      },
    );
  });

  await t.test("terminal 401/403 throws COMPANY_OPENAI_KEY_REJECTED without retrying", async () => {
    let sleepCalls = 0;
    const sleeper = { sleep: async () => { sleepCalls++; } };

    for (const status of [401, 403]) {
      const { fetch: recordingFetch, requests } = createRecordingFetch([
        { status, body: "Unauthorized" },
      ]);

      const embClient = createOpenAiEmbeddingClient({
        apiKey: "sk-mock-key-12345678901234567890",
        fetchImpl: recordingFetch,
        limiter,
        sleeper,
        clock,
        maxAttempts: 5,
      });

      await assert.rejects(
        () => embClient.embed("Text to embed"),
        (err: any) => {
          assert.equal(err.code, "COMPANY_OPENAI_KEY_REJECTED");
          assert.equal(requests.length, 1);
          assert.equal(sleepCalls, 0);
          return true;
        },
      );
    }
  });

  await t.test("other terminal 4xx throws EMBEDDING_FAILED without retrying", async () => {
    let sleepCalls = 0;
    const sleeper = { sleep: async () => { sleepCalls++; } };

    for (const status of [400, 404, 422]) {
      const { fetch: recordingFetch, requests } = createRecordingFetch([
        { status, body: "Bad request" },
      ]);

      const embClient = createOpenAiEmbeddingClient({
        apiKey: "sk-mock-key-12345678901234567890",
        fetchImpl: recordingFetch,
        limiter,
        sleeper,
        clock,
        maxAttempts: 5,
      });

      await assert.rejects(
        () => embClient.embed("Text to embed"),
        (err: any) => {
          assert.equal(err.code, "EMBEDDING_FAILED");
          assert.equal(requests.length, 1);
          assert.equal(sleepCalls, 0);
          return true;
        },
      );
    }
  });
});
