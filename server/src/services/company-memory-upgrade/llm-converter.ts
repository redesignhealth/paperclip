/**
 * LLM client for converting legacy memories to atomic schema (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Uses OpenAI Chat Completions with strict json_schema response_format.
 * - PRIVACY INVARIANT: The serialized request body contains ONLY the memory text
 *   inside <source_memory>...</source_memory>. It MUST NEVER include agent ID,
 *   agent name, company ID, company name, or source row ID.
 * - Transport failures (429/5xx/network/timeout) are retried with Retry-After-aware
 *   exponential backoff + jitter. If exhausted, resolves to outcome 'llm_unavailable'.
 * - Schema violations trigger exactly ONE repair retry naming only the violated rule class
 *   (never echoing the model's output text).
 * - Sensitive data detected in model output (data_sensitive_echo) maps to drop_sensitive,
 *   not quarantine.
 */

import {
  CONVERSION_JSON_SCHEMA,
  CONVERSION_SYSTEM_PROMPT,
  type ConversionRecord,
  SUPPORTED_CONVERTER_MODELS,
  type SupportedConverterModel,
  validateConversionOutput,
} from "./converter-contract.js";
import { type MonotonicClock, type Sleeper } from "./clock.js";
import { type RedactionRegistry } from "./openai-key.js";
import { estimateChatTokens, parseRetryAfterMs, type RateLimiter } from "./rate-limiter.js";
import { CompanyMemoryUpgradeError } from "./types.js";

/**
 * Exact bounded reason_code literal emitted for `dropped_sensitive` outcomes that were
 * classified by the model itself (decision: "drop_sensitive" with no regex family match
 * on the model's own textual output). This is a SINGLE fixed literal -- distinct from, and
 * never combined with, the sorted comma-separated regex family CSV emitted when our own
 * `detectSensitiveFamilies` regexes match (see sensitive-patterns.ts / converter-contract.ts
 * `data_sensitive_echo`). Shared here as the producer constant so validateOutcomeReason in
 * sweep-tenant.ts can permit it as an exact literal without weakening family CSV validation.
 */
export const MODEL_CLASSIFIED_SENSITIVE_REASON_CODE = "model_classified";

export type ConversionClientResult =
  | {
      status: "convert";
      records: ConversionRecord[];
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "drop_noise";
      reasonCode: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "drop_sensitive";
      reasonCode: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "quarantined";
      rejectCode: string;
      inputTokens: number;
      outputTokens: number;
    };

export interface ConversionClient {
  convert(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConversionClientResult>;
}

export type ConversionChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Wraps raw source memory text in the privacy-invariant <source_memory> tags. */
export function buildConversionUserMessage(text: string): string {
  return `<source_memory>\n${text}\n</source_memory>`;
}

/** Builds the exact initial chat messages array sent to the conversion endpoint. */
export function buildInitialConversionMessages(text: string): ConversionChatMessage[] {
  return [
    { role: "system", content: CONVERSION_SYSTEM_PROMPT },
    { role: "user", content: buildConversionUserMessage(text) },
  ];
}

/**
 * Builds the exact repair-retry chat messages array, given the initial messages, the
 * (rejected) prior assistant response content, and the violated rule class being repaired.
 */
export function buildRepairConversionMessages(
  initialMessages: ConversionChatMessage[],
  priorResponseContent: string,
  repairRuleClass: string,
): ConversionChatMessage[] {
  return [
    ...initialMessages,
    { role: "assistant", content: priorResponseContent },
    {
      role: "user",
      content: `Your previous response was rejected due to rule violation: ${repairRuleClass}. Please produce a strictly compliant JSON response satisfying all rules.`,
    },
  ];
}

/** Mirrors the literal max_completion_tokens cap applied to every chat conversion call. */
export const PREFLIGHT_MAX_COMPLETION_TOKENS = 600;

/** Builds the exact serialized request body sent to the chat completions endpoint. */
export function buildConversionRequestBody(
  model: string,
  messages: ConversionChatMessage[],
): string {
  return JSON.stringify({
    model,
    messages,
    temperature: 0,
    top_p: 1,
    seed: 8191,
    max_completion_tokens: PREFLIGHT_MAX_COMPLETION_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "memory_conversion",
        strict: true,
        schema: CONVERSION_JSON_SCHEMA,
      },
    },
  });
}

export interface CreateOpenAiConversionClientOptions {
  apiKey: string;
  model?: SupportedConverterModel | string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  limiter: RateLimiter;
  sleeper: Sleeper;
  clock: MonotonicClock;
  redaction?: RedactionRegistry;
  maxAttempts?: number;
}

export function createOpenAiConversionClient(
  options: CreateOpenAiConversionClientOptions,
): ConversionClient {
  const {
    apiKey,
    model = "gpt-5.4-mini",
    baseUrl = "https://api.openai.com/v1",
    fetchImpl = globalThis.fetch,
    limiter,
    sleeper,
    clock,
    redaction,
    maxAttempts = 5,
  } = options;

  if (!SUPPORTED_CONVERTER_MODELS.includes(model as SupportedConverterModel)) {
    throw new CompanyMemoryUpgradeError(
      `Unsupported converter model '${model}'. Supported models: [${SUPPORTED_CONVERTER_MODELS.join(", ")}]`,
      "INVALID_ARGUMENT",
    );
  }

  redaction?.add(apiKey);

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function executeChatRequest(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    estimatedTokens: number,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    let attempt = 0;
    let baseDelayMs = 500;

    while (attempt < maxAttempts) {
      if (signal?.aborted) {
        throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
      }

      attempt++;

      const lease = await limiter.acquire(estimatedTokens);
      try {
        const body = buildConversionRequestBody(model, messages);

        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal,
        });

        const nowMs = clock.nowMs();
        const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);

        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxAttempts) {
            throw new CompanyMemoryUpgradeError(
              `OpenAI chat completions failed with HTTP ${res.status} after ${maxAttempts} attempts.`,
              "LLM_UNAVAILABLE",
            );
          }
          const jitter = Math.floor(Math.random() * 50);
          const delay = Math.max(retryAfterMs ?? 0, baseDelayMs) + jitter;
          baseDelayMs *= 2;
          await sleeper.sleep(delay);
          continue;
        }

        if (!res.ok) {
          throw new CompanyMemoryUpgradeError(
            `OpenAI chat completions request failed with HTTP ${res.status}`,
            "LLM_UNAVAILABLE",
          );
        }

        const data: any = await res.json();
        const inputTokens = data.usage?.prompt_tokens ?? estimatedTokens;
        const outputTokens = data.usage?.completion_tokens ?? 0;
        const totalTokens = data.usage?.total_tokens ?? (inputTokens + outputTokens);

        lease.settle(totalTokens);

        const content = data.choices?.[0]?.message?.content ?? "";
        return { content, inputTokens, outputTokens };
      } catch (err: any) {
        if (signal?.aborted) {
          throw new CompanyMemoryUpgradeError("Conversion aborted.", "ABORTED_BY_OPERATOR");
        }
        if (err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR") {
          throw err;
        }
        if (attempt >= maxAttempts) {
          throw new CompanyMemoryUpgradeError(
            `OpenAI request failed after ${maxAttempts} attempts: ${err.message}`,
            "LLM_UNAVAILABLE",
          );
        }
        const jitter = Math.floor(Math.random() * 50);
        const delay = baseDelayMs + jitter;
        baseDelayMs *= 2;
        await sleeper.sleep(delay);
      } finally {
        lease.release();
      }
    }

    throw new CompanyMemoryUpgradeError(
      `OpenAI request failed: exhausted ${maxAttempts} attempts.`,
      "LLM_UNAVAILABLE",
    );
  }

  return {
    async convert(
      text: string,
      options?: { signal?: AbortSignal },
    ): Promise<ConversionClientResult> {
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // 1. Initial attempt
      const messages = buildInitialConversionMessages(text);

      const estimatedTokens = estimateChatTokens(text);

      let responseContent: string;
      try {
        const resp = await executeChatRequest(messages, estimatedTokens, options?.signal);
        totalInputTokens += resp.inputTokens;
        totalOutputTokens += resp.outputTokens;
        responseContent = resp.content;
      } catch (err: any) {
        if (err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR") {
          throw err;
        }
        return {
          status: "quarantined",
          rejectCode: "llm_unavailable",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 2. Validate first output
      let validation = validateConversionOutput(responseContent);

      if (validation.ok) {
        if (validation.decision === "convert") {
          return {
            status: "convert",
            records: validation.records,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        if (validation.decision === "drop_noise") {
          return {
            status: "drop_noise",
            reasonCode: "exact_placeholder_or_greeting",
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        // drop_sensitive
        return {
          status: "drop_sensitive",
          reasonCode: MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // Sensitive data echo detected in model output maps to drop_sensitive, not quarantine
      if (validation.rejectCode === "data_sensitive_echo") {
        return {
          status: "drop_sensitive",
          reasonCode: validation.sensitiveReasonCode,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 3. Schema or rule violation -> Exactly ONE repair retry naming the violated rule class
      const repairRuleClass = validation.rejectCode;
      const repairMessages = buildRepairConversionMessages(messages, responseContent, repairRuleClass);

      try {
        const repairResp = await executeChatRequest(repairMessages, estimatedTokens + 100, options?.signal);
        totalInputTokens += repairResp.inputTokens;
        totalOutputTokens += repairResp.outputTokens;
        responseContent = repairResp.content;
      } catch (err: any) {
        if (err instanceof CompanyMemoryUpgradeError && err.code === "ABORTED_BY_OPERATOR") {
          throw err;
        }
        return {
          status: "quarantined",
          rejectCode: "llm_unavailable",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // 4. Validate repaired output
      validation = validateConversionOutput(responseContent);

      if (validation.ok) {
        if (validation.decision === "convert") {
          return {
            status: "convert",
            records: validation.records,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        if (validation.decision === "drop_noise") {
          return {
            status: "drop_noise",
            reasonCode: "exact_placeholder_or_greeting",
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }
        // drop_sensitive
        return {
          status: "drop_sensitive",
          reasonCode: MODEL_CLASSIFIED_SENSITIVE_REASON_CODE,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      if (validation.rejectCode === "data_sensitive_echo") {
        return {
          status: "drop_sensitive",
          reasonCode: validation.sensitiveReasonCode,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }

      // Still invalid after repair retry -> quarantine with rejectCode
      return {
        status: "quarantined",
        rejectCode: validation.rejectCode,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
    },
  };
}
