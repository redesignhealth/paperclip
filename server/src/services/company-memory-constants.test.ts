import { describe, expect, it } from "vitest";
import {
  isUnsupportedMemoryEmbeddingError,
  UnsupportedMemoryEmbeddingError,
  UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE,
  isSupportedCompanyMemoryEmbedding,
  SUPPORTED_COMPANY_MEMORY_EMBEDDINGS,
} from "./company-memory-constants.js";

describe("company-memory-constants", () => {
  describe("isUnsupportedMemoryEmbeddingError", () => {
    it("returns true for UnsupportedMemoryEmbeddingError instances", () => {
      const err = new UnsupportedMemoryEmbeddingError("company-1", "text-embedding-3-large", 3072);
      expect(isUnsupportedMemoryEmbeddingError(err)).toBe(true);
      expect(err.code).toBe(UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE);
      expect(err.name).toBe("UnsupportedMemoryEmbeddingError");
      expect(err.companyId).toBe("company-1");
      expect(err.model).toBe("text-embedding-3-large");
      expect(err.dimensions).toBe(3072);
    });

    it("returns true for duck-typed objects with code matching UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE", () => {
      expect(isUnsupportedMemoryEmbeddingError({ code: UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE })).toBe(true);
      expect(isUnsupportedMemoryEmbeddingError({ code: "unsupported_memory_embedding", name: "CustomError" })).toBe(true);
    });

    it("returns true for duck-typed objects or deserialized errors with name UnsupportedMemoryEmbeddingError", () => {
      const err = new Error("Unsupported embedding");
      err.name = "UnsupportedMemoryEmbeddingError";
      expect(isUnsupportedMemoryEmbeddingError(err)).toBe(true);
      expect(isUnsupportedMemoryEmbeddingError({ name: "UnsupportedMemoryEmbeddingError" })).toBe(true);
    });

    it("returns true for deserialized errors with both matching name and code", () => {
      expect(
        isUnsupportedMemoryEmbeddingError({
          name: "UnsupportedMemoryEmbeddingError",
          code: UNSUPPORTED_MEMORY_EMBEDDING_FAILURE_CODE,
          message: "failed",
        }),
      ).toBe(true);
    });

    it("returns false for null and undefined", () => {
      expect(isUnsupportedMemoryEmbeddingError(null)).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(undefined)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isUnsupportedMemoryEmbeddingError("unsupported_memory_embedding")).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError("UnsupportedMemoryEmbeddingError")).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(123)).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(true)).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(false)).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(Symbol("error"))).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(0)).toBe(false);
    });

    it("returns false for unrelated errors and objects", () => {
      expect(isUnsupportedMemoryEmbeddingError(new Error("Generic error"))).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError(new TypeError("Type mismatch"))).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError({})).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError({ code: "other_error", name: "OtherError" })).toBe(false);
      expect(isUnsupportedMemoryEmbeddingError({ message: "unsupported_memory_embedding" })).toBe(false);
    });
  });

  describe("isSupportedCompanyMemoryEmbedding", () => {
    it("recognizes supported embeddings allowlist", () => {
      for (const item of SUPPORTED_COMPANY_MEMORY_EMBEDDINGS) {
        expect(isSupportedCompanyMemoryEmbedding({ model: item.model, dimensions: item.dimensions })).toBe(true);
      }
    });

    it("rejects unsupported models or dimensions", () => {
      expect(isSupportedCompanyMemoryEmbedding({ model: "text-embedding-3-large", dimensions: 3072 })).toBe(false);
      expect(isSupportedCompanyMemoryEmbedding({ model: "text-embedding-3-small", dimensions: 3072 })).toBe(false);
      expect(isSupportedCompanyMemoryEmbedding({ model: "text-embedding-ada-002", dimensions: 1536 })).toBe(false);
      expect(isSupportedCompanyMemoryEmbedding({ model: "", dimensions: 1536 })).toBe(false);
    });
  });
});
