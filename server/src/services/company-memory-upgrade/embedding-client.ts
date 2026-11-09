/**
 * OpenAI embedding client for memory upgrade re-embedding (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Re-embeds target text using text-embedding-3-small (1536 dimensions).
 * - Shape validation: response must contain exactly 1 embedding array of 1536 finite numbers,
 *   and model must start with 'text-embedding-3-small'.
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
}

export function assertEmbeddingShape(data: unknown): number[] {
  if (!data || typeof data !== "object") {
    throw new CompanyMemoryUpgradeError(
      "Invalid embeddings response: expected object",
      "EMBEDDING_FAILED",
    );
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.model !== "string" || !obj.model.startsWith("text-embedding-3-small")) {
    throw new CompanyMemoryUpgradeError(
      `Invalid embeddings model: expected model starting with 'text-embedding-3-small', got '${obj.model}'`,
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
  } = options;

  redaction?.add(apiKey);

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  return {
    async embed(text: string, embedOptions?: { signal?: AbortSignal }): Promise<EmbeddingResult> {
      let attempt = 0;
      let baseDelayMs = 500;
      const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));

      while (attempt < maxAttempts) {
        if (embedOptions?.signal?.aborted) {
          throw new CompanyMemoryUpgradeError("Embedding aborted.", "ABORTED_BY_OPERATOR");
        }

        attempt++;
        const lease = await limiter.acquire(estimatedTokens);

        try {
          const body = JSON.stringify({
            model: "text-embedding-3-small",
            input: text,
            dimensions: 1536,
            encoding_format: "float",
          });

          const res = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body,
            signal: embedOptions?.signal,
          });

          const nowMs = clock.nowMs();
          const retryAfterMs = parseRetryAfterMs(res.headers, nowMs);

          if (res.status === 429 || res.status >= 500) {
            if (attempt >= maxAttempts) {
              throw new CompanyMemoryUpgradeError(
                `OpenAI embeddings failed with HTTP ${res.status} after ${maxAttempts} attempts.`,
                "EMBEDDING_FAILED",
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
              `OpenAI embeddings request failed with HTTP ${res.status}`,
              "EMBEDDING_FAILED",
            );
          }

          const data: any = await res.json();
          const tokens = data.usage?.prompt_tokens ?? estimatedTokens;
          lease.settle(tokens);

          const embedding = assertEmbeddingShape(data);
          return { embedding, tokens };
        } catch (err: any) {
          if (embedOptions?.signal?.aborted) {
            throw new CompanyMemoryUpgradeError("Embedding aborted.", "ABORTED_BY_OPERATOR");
          }
          if (err instanceof CompanyMemoryUpgradeError) {
            if (err.code === "ABORTED_BY_OPERATOR" || err.code === "EMBEDDING_FAILED") {
              throw err;
            }
          }
          if (attempt >= maxAttempts) {
            throw new CompanyMemoryUpgradeError(
              `OpenAI embedding request failed after ${maxAttempts} attempts: ${err.message}`,
              "EMBEDDING_FAILED",
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
        `OpenAI embedding request failed: exhausted ${maxAttempts} attempts.`,
        "EMBEDDING_FAILED",
      );
    },
  };
}
