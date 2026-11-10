/**
 * OpenAI embedding client for memory upgrade re-embedding (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Re-embeds target text using text-embedding-3-small (1536 dimensions).
 * - Shape validation: response must contain exactly 1 embedding array of 1536 finite numbers,
 *   and model must start with 'text-embedding-3-small'.
 * - Failed-attempt token refunds: deliberately NOT implemented (over-debiting is safe).
 * - Any failure (transport exhaustion, bad shape, unexpected model, non-finite vectors)
 *   throws CompanyMemoryUpgradeError('EMBEDDING_FAILED'), which ABORTS the sweep,
 *   never quarantines.
 */

import { type MonotonicClock, type Sleeper } from "./clock.js";
import { type RedactionRegistry } from "./openai-key.js";
import { parseRetryAfterMs, type RateLimiter } from "./rate-limiter.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}

export interface EmbeddingClient {
  embed(text: string, options?: { signal?: AbortSignal }): Promise<EmbeddingResult>;
}

export interface CreateOpenAiEmbeddingClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  limiter: RateLimiter;
  sleeper: Sleeper;
  clock: MonotonicClock;
  redaction?: RedactionRegistry;
  maxAttempts?: number;
  random?: () => number;
}

export function assertEmbeddingShape(data: unknown, redaction?: RedactionRegistry): number[] {
  if (!data || typeof data !== "object") {
    throw new CompanyMemoryUpgradeError(
      "Invalid embeddings response: expected object",
      "EMBEDDING_FAILED",
    );
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.model !== "string" || !obj.model.startsWith("text-embedding-3-small")) {
    const modelStr = redaction ? redaction.scrub(String(obj.model)) : String(obj.model);
    throw new CompanyMemoryUpgradeError(
      `Invalid embeddings model: expected model starting with 'text-embedding-3-small', got '${modelStr}'`,
      "EMBEDDING_FAILED",
    );
  }

  if (!Array.isArray(obj.data) || obj.data.length !== 1) {
    throw new CompanyMemoryUpgradeError(
      `Invalid embeddings data: expected array of 1 item, got ${Array.isArray(obj.data) ? obj.data.length : typeof obj.data}`,
      "EMBEDDING_FAILED",
    );
  }

  const item = obj.data[0];
  if (!item || typeof item !== "object" || !Array.isArray((item as any).embedding)) {
    throw new CompanyMemoryUpgradeError(
      "Invalid embeddings item: missing embedding array",
      "EMBEDDING_FAILED",
    );
  }

  const vector = (item as any).embedding as unknown[];
  if (vector.length !== 1536) {
    throw new CompanyMemoryUpgradeError(
      `Invalid embedding dimensions: expected 1536, found ${vector.length}`,
      "EMBEDDING_FAILED",
    );
  }

  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid embedding vector: element at index ${i} is not a finite number`,
        "EMBEDDING_FAILED",
      );
    }
  }

  return vector as number[];
}

export function createOpenAiEmbeddingClient(
  options: CreateOpenAiEmbeddingClientOptions,
): EmbeddingClient {
  const {
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    fetchImpl = globalThis.fetch,
    limiter,
    sleeper,
    clock,
    redaction,
    maxAttempts = 5,
    random = Math.random,
  } = options;

  redaction?.add(apiKey);

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  type AttemptResult =
    | { kind: "ok"; data: EmbeddingResult }
    | { kind: "retry"; delayMs: number };

  return {
    async embed(text: string, embedOptions?: { signal?: AbortSignal }): Promise<EmbeddingResult> {
      let attempt = 0;
      let baseDelayMs = 500;
      const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));

      async function performSingleAttempt(
        currentAttempt: number,
        currentBaseDelayMs: number,
      ): Promise<AttemptResult> {
        const lease = await limiter.acquire(estimatedTokens);
        try {
          const body = JSON.stringify({
            model: "text-embedding-3-small",
            input: text,
            dimensions: 1536,
            encoding_format: "float",
          });

          let res: Response;
          try {
            res = await fetchImpl(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body,
              signal: embedOptions?.signal,
            });
          } catch (fetchErr: any) {
            if (embedOptions?.signal?.aborted) {
              throw new CompanyMemoryUpgradeError("Embedding aborted.", "ABORTED_BY_OPERATOR");
            }
            if (currentAttempt >= maxAttempts) {
              const rawMsg = fetchErr?.message ? String(fetchErr.message) : "network error";
              const scrubbed = redaction ? redaction.scrub(rawMsg) : rawMsg;
              throw new CompanyMemoryUpgradeError(
                `OpenAI embedding request failed after ${maxAttempts} attempts: ${scrubbed}`,
                "EMBEDDING_FAILED",
              );
            }
            const jitter = Math.floor(random() * 50);
            const delay = currentBaseDelayMs + jitter;
            return { kind: "retry", delayMs: delay };
          }

          if (embedOptions?.signal?.aborted) {
            throw new CompanyMemoryUpgradeError("Embedding aborted.", "ABORTED_BY_OPERATOR");
          }

          if (res.status === 429) {
            const errBody = await res.text().catch(() => "");
            if (errBody.includes("insufficient_quota")) {
              const msg = redaction
                ? redaction.scrub("OpenAI embeddings failed with HTTP 429: insufficient_quota")
                : "OpenAI embeddings failed with HTTP 429: insufficient_quota";
              throw new CompanyMemoryUpgradeError(msg, "COMPANY_OPENAI_QUOTA_EXHAUSTED");
            }
            if (currentAttempt >= maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI embeddings failed with HTTP 429 after ${maxAttempts} attempts.`,
                "EMBEDDING_FAILED",
              );
            }
            const nowMs = clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);
            const jitter = Math.floor(random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, currentBaseDelayMs) + jitter;
            return { kind: "retry", delayMs: delay };
          }

          if (res.status >= 500 || res.status === 408 || res.status === 409) {
            if (currentAttempt >= maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI embeddings failed with HTTP ${res.status} after ${maxAttempts} attempts.`,
                "EMBEDDING_FAILED",
              );
            }
            const nowMs = clock.nowMs();
            const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);
            const jitter = Math.floor(random() * 50);
            const delay = Math.max(retryAfterMs ?? 0, currentBaseDelayMs) + jitter;
            return { kind: "retry", delayMs: delay };
          }

          if (!res.ok) {
            const msg = redaction
              ? redaction.scrub(`OpenAI embeddings request failed with HTTP ${res.status}`)
              : `OpenAI embeddings request failed with HTTP ${res.status}`;
            throw new CompanyMemoryUpgradeError(msg, "EMBEDDING_FAILED");
          }

          const data: any = await res.json();
          const embedding = assertEmbeddingShape(data, redaction);

          const rawTokens = data.usage?.prompt_tokens;
          const tokens =
            typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens >= 0
              ? rawTokens
              : estimatedTokens;
          lease.settle(tokens);

          return { kind: "ok", data: { embedding, tokens } };
        } finally {
          lease.release();
        }
      }

      while (attempt < maxAttempts) {
        if (embedOptions?.signal?.aborted) {
          throw new CompanyMemoryUpgradeError("Embedding aborted.", "ABORTED_BY_OPERATOR");
        }

        attempt++;
        const result = await performSingleAttempt(attempt, baseDelayMs);
        if (result.kind === "ok") {
          return result.data;
        }
        baseDelayMs *= 2;
        await sleeper.sleep(result.delayMs);
      }

      throw new CompanyMemoryUpgradeError(
        `OpenAI embedding request failed: exhausted ${maxAttempts} attempts.`,
        "EMBEDDING_FAILED",
      );
    },
  };
}
