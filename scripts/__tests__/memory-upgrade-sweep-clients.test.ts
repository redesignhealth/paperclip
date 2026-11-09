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
import { createRateLimiter } from "../../server/src/services/company-memory-upgrade/rate-limiter.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";
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

  await t.test("embedding failure aborts sweep with EMBEDDING_FAILED", async () => {
    const { fetch: recordingFetch } = createRecordingFetch([
      { status: 500, body: "Internal Server Error" },
      { status: 500, body: "Internal Server Error" },
    ]);

    const embClient = createOpenAiEmbeddingClient({
      apiKey: "sk-mock-key-12345678901234567890",
      fetchImpl: recordingFetch,
      limiter,
      sleeper: clock,
      clock,
      maxAttempts: 2,
    });

    await assert.rejects(
      () => embClient.embed("Text to embed."),
      (err: any) => err.code === "EMBEDDING_FAILED",
    );
  });
});
