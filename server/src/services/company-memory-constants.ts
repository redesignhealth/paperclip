import { createHash } from "node:crypto";
import { DEFAULT_COMPANY_MEMORY_EMBEDDING } from "@paperclipai/db";

export { DEFAULT_COMPANY_MEMORY_EMBEDDING };

export const HERMES_ADAPTER_TYPE = "hermes_local";

/**
 * Only the local Hermes adapter consumes the per-company Mem0/pgvector
 * descriptor. Gateway adapters run outside the host and must never receive
 * per-company database credentials.
 */
export function adapterSupportsRuntimeMemory(adapterType: string | null | undefined): boolean {
  return adapterType === HERMES_ADAPTER_TYPE;
}

export class CompanyMemoryDatabaseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CompanyMemoryDatabaseError";
  }
}

export const SAFE_PG_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEASE_TTL_MS = 120_000; // 120 seconds

export function deriveCompanyMemoryDatabaseNames(companyId: string): {
  databaseName: string;
  databaseRole: string;
} {
  const trimmed = companyId.trim().toLowerCase();
  if (!UUID_REGEX.test(trimmed)) {
    throw new CompanyMemoryDatabaseError("Invalid companyId UUID", "INVALID_COMPANY_ID");
  }
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
  const databaseName = `pcmem_${hash}`;
  const databaseRole = `pcmem_r_${hash}`;

  if (!SAFE_PG_IDENTIFIER_REGEX.test(databaseName) || !SAFE_PG_IDENTIFIER_REGEX.test(databaseRole)) {
    throw new CompanyMemoryDatabaseError("Derived database identifier failed safety allowlist", "UNSAFE_IDENTIFIER");
  }

  return { databaseName, databaseRole };
}

export const UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE = "unsupported_memory_embedding";

export class UnsupportedMemoryEmbeddingError extends Error {
  readonly code = UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE;

  constructor(
    readonly companyId: string,
    readonly model: string,
    readonly dimensions: number,
  ) {
    super(
      `Unsupported company memory embedding configuration for company "${companyId}": model "${model}" with ${dimensions} dimensions is not in the supported allowlist`,
    );
    this.name = "UnsupportedMemoryEmbeddingError";
  }
}

export type UnsupportedMemoryEmbeddingErrorLike =
  | UnsupportedMemoryEmbeddingError
  | {
      name: "UnsupportedMemoryEmbeddingError";
      code?: string;
      message: string;
      companyId?: string;
      model?: string;
      dimensions?: number;
    };

export function isUnsupportedMemoryEmbeddingError(
  err: unknown,
): err is UnsupportedMemoryEmbeddingErrorLike {
  if (err instanceof UnsupportedMemoryEmbeddingError) return true;
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return (
    candidate.code === UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE ||
    candidate.name === "UnsupportedMemoryEmbeddingError"
  );
}

export const SUPPORTED_COMPANY_MEMORY_EMBEDDINGS: readonly {
  readonly model: string;
  readonly dimensions: number;
}[] = [{ model: "text-embedding-3-small", dimensions: 1536 }];

export function isSupportedCompanyMemoryEmbedding(embedding: {
  model: string;
  dimensions: number;
}): boolean {
  return SUPPORTED_COMPANY_MEMORY_EMBEDDINGS.some(
    (e) => e.model === embedding.model && e.dimensions === embedding.dimensions,
  );
}
