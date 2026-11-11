/**
 * Unit tests for publish error codes and vector cast resolution (TECH-8191 PR 4b).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  publishSourceBatch,
  resolveLiveVectorCast,
  type PublishSourceBatchParams,
} from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import {
  mapSweepErrorCode,
  SWEEP_ERROR_CODE_MAP,
  UPGRADE_ERROR_CODES,
} from "../../server/src/services/company-memory-upgrade/types.js";
import type { TenantCollectionShape } from "../../server/src/services/company-memory-upgrade/sweep-tenant.js";

test("resolveLiveVectorCast returns null when types match, cast when different", () => {
  const baseShape: TenantCollectionShape = {
    tableName: "mem0_memories",
    embeddingColumn: "vector",
    embeddingDims: 1536,
    embeddingType: "vector(1536)",
    embeddingTypeRaw: "vector(1536)",
    payloadType: "jsonb",
    rowCount: 0,
    isUuidId: true,
  };

  // 1. Staging vector(1536) and live vector(1536) -> null (no cast)
  assert.equal(resolveLiveVectorCast(baseShape, "vector(1536)"), null);

  // 2. Staging text and live "vector(1536)" domain -> ::"vector(1536)"
  const domainShape: TenantCollectionShape = {
    ...baseShape,
    embeddingType: "vector(1536)",
    embeddingTypeRaw: '"vector(1536)"',
  };
  assert.equal(resolveLiveVectorCast(domainShape, "text"), '::"vector(1536)"');

  // 3. Staging text and live extensions.vector(1536) -> ::extensions.vector(1536)
  const schemaShape: TenantCollectionShape = {
    ...baseShape,
    embeddingType: "extensions.vector(1536)",
    embeddingTypeRaw: "extensions.vector(1536)",
  };
  assert.equal(resolveLiveVectorCast(schemaShape, "text"), "::extensions.vector(1536)");

  // 4. Unsafe catalog type -> throws UNSAFE_CATALOG_TYPE
  const unsafeShape: TenantCollectionShape = {
    ...baseShape,
    embeddingTypeRaw: "vector(1536); DROP TABLE t",
  };
  assert.throws(
    () => resolveLiveVectorCast(unsafeShape, "text"),
    (err: any) => err?.code === "UNSAFE_CATALOG_TYPE",
  );
});

test("publish error codes are mapped in SWEEP_ERROR_CODE_MAP in both case forms", () => {
  const requiredCodes = [
    ["LIVE_TABLE_ID_NOT_UNIQUE", "publish_precondition_failed"],
    ["live_table_id_not_unique", "publish_precondition_failed"],
    ["LIVE_TABLE_NOT_INSERTABLE", "publish_precondition_failed"],
    ["live_table_not_insertable", "publish_precondition_failed"],
    ["PUBLISH_LEDGER_INCONSISTENT", "publish_precondition_failed"],
    ["publish_ledger_inconsistent", "publish_precondition_failed"],
    ["PUBLISH_CONFLICT_UNEXPECTED", "publish_failed"],
    ["publish_conflict_unexpected", "publish_failed"],
    ["PUBLISH_PRECONDITION_FAILED", "publish_precondition_failed"],
    ["publish_precondition_failed", "publish_precondition_failed"],
    ["UNSAFE_CATALOG_TYPE", "schema_init_failed"],
    ["unsafe_catalog_type", "schema_init_failed"],
  ] as const;

  for (const [code, expected] of requiredCodes) {
    assert.equal(SWEEP_ERROR_CODE_MAP[code], expected, `Expected ${code} to map to ${expected}`);
    assert.equal(mapSweepErrorCode(code), expected, `Expected mapSweepErrorCode(${code}) to be ${expected}`);
  }

  assert.ok(UPGRADE_ERROR_CODES.includes("publish_precondition_failed"));
});

test("PublishSourceBatchParams contract: outputIds and payloadType are not in interface", () => {
  type HasKey<T, K extends string> = K extends keyof T ? true : false;
  type _NoOutputIds = HasKey<PublishSourceBatchParams, "outputIds">;
  type _NoPayloadType = HasKey<PublishSourceBatchParams, "payloadType">;

  const noOutputIds: _NoOutputIds = false;
  const noPayloadType: _NoPayloadType = false;
  assert.equal(noOutputIds, false);
  assert.equal(noPayloadType, false);
});
