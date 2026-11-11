/**
 * Read-only drain probe for company memory upgrade (TECH-8191 §Q3, PR5.5).
 *
 * Scans the live tenant memory collection with an anti-join against the upgrade
 * ledger to verify whether a catch-up sweep or publish run now (in draining state)
 * would do work on any source row.
 */

import type postgres from "postgres";
import type { CpAgentRow } from "./agent-routing.js";
import { isValidUuid, validateAndResolveTableIdentifier } from "./census.js";
import {
  assertDrainProbePreflight,
  countPublishPending,
  type PublishPendingResult,
} from "./drain-probe-preflight.js";
import { RECONVERTIBLE_LEDGER_OUTCOMES } from "./sweep.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export { countPublishPending, type PublishPendingResult };

/**
 * ECMAScript WhiteSpace and LineTerminator characters trimmed by String.prototype.trim().
 * Explicitly enumerated to match JavaScript trim() semantics in PostgreSQL btrim().
 * Excludes U+0085 (NEL) and U+200B (Zero Width Space) which JS does not trim.
 */
export const ECMA_TRIM_WHITESPACE =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export interface DrainProbeOptions {
  upgradeId: string;
  tableName: string;
  cpAgentMap: Map<string, CpAgentRow>;
  limit?: number;
}

export interface DrainProbeResult {
  blockingSources: number;
  missingScopeBlockingSources: number;
  pendingPublishableRows: number;
  probedAt: Date;
  limitReached: boolean;
}

/**
 * Runs a read-only drain probe against the live collection.
 * Proves whether a catch-up sweep or publish would find pending work.
 * Fails closed without DDL if tables are missing or database version lacks sha256().
 */
export async function runDrainProbe(
  tenantSql: postgres.Sql,
  options: DrainProbeOptions,
): Promise<DrainProbeResult> {
  if (!isValidUuid(options.upgradeId)) {
    throw new CompanyMemoryUpgradeError(
      `Invalid upgrade ID: "${options.upgradeId}"`,
      "INVALID_ARGUMENT",
    );
  }
  if (!options.cpAgentMap || !(options.cpAgentMap instanceof Map)) {
    throw new CompanyMemoryUpgradeError(
      "cpAgentMap is required for drain probe routing verification.",
      "INVALID_ARGUMENT",
    );
  }
  const limit = options.limit && options.limit > 0 ? options.limit : 1000;
  const resolved = validateAndResolveTableIdentifier(options.tableName);

  await assertDrainProbePreflight(tenantSql, options.tableName, resolved.regclassArg);
  const pending = await countPublishPending(tenantSql, options.upgradeId);

  const knownAgentIds = Array.from(
    new Set([
      ...Array.from(options.cpAgentMap.keys()).map((k) => k.trim().toLowerCase()),
      ...Array.from(options.cpAgentMap.values()).map((a) => (a?.id ? a.id.trim().toLowerCase() : "")).filter(Boolean),
    ]),
  );
  const reconvertibleOutcomes = Array.from(RECONVERTIBLE_LEDGER_OUTCOMES);

  // Anti-join over live collection matching sweep decision rules exactly:
  // 1. Provenance exclusion (#349): rows with staging.output_id = t.id were published by
  //    the upgrade and must not be treated as fresh legacy sources.
  // 2. Routing semantics: live agent ID canonicalization and matching against CP agent map.
  //    Unroutable/unknown/missing agent IDs compare against NULL, matching ledger storage.
  // 3. Reconvertible outcomes: outcomes in RECONVERTIBLE_LEDGER_OUTCOMES (e.g. 'superseded')
  //    are re-converted by sweep even if hash matches; probe blocks on them.
  // 4. Scope separation: catch-up sweep in draining scans user_id = 'company'. Missing-scope
  //    rows (payload->>'user_id' IS NULL) cannot be swept during draining, so unledgered/changed
  //    missing-scope rows are reported in missingScopeBlockingSources (fail-closed, non-waitable).
  const probeRows = (await tenantSql.unsafe(
    `SELECT
       count(*) FILTER (WHERE q.payload->>'user_id' = 'company')::int AS blocking_sources,
       count(*) FILTER (WHERE q.payload IS NULL OR q.payload->>'user_id' IS NULL)::int AS missing_scope_sources
     FROM (
       SELECT t.payload
       FROM ${resolved.regclassArg} t
       LEFT JOIN paperclip_memory_upgrade_ledger l
         ON l.upgrade_id = $1::uuid
        AND l.source_id::text = lower(t.id::text)
       WHERE (t.payload IS NULL OR t.payload->>'user_id' IS NULL OR t.payload->>'user_id' = 'company')
         AND NOT EXISTS (
           SELECT 1 FROM paperclip_memory_upgrade_staging s
           WHERE lower(s.output_id::text) = lower(t.id::text)
         )
         AND (
              l.source_id IS NULL
           OR l.outcome = ANY($4::text[])
           OR l.source_content_sha256 <> encode(sha256(convert_to(coalesce(t.payload->>'data',''),'UTF8')),'hex')
           OR coalesce(l.agent_id::text,'') <> coalesce(
                CASE
                  WHEN btrim(lower(coalesce(t.payload->>'agent_id', '')), $5::text) = ANY($3::text[])
                  THEN btrim(lower(t.payload->>'agent_id'), $5::text)
                  ELSE NULL
                END,
                ''
              )
           OR EXISTS (
                SELECT 1 FROM paperclip_memory_upgrade_staging s
                WHERE s.upgrade_id = $1::uuid
                  AND s.source_id = l.source_id
                  AND s.published_at IS NULL
                  AND l.outcome = 'published'
              )
         )
       LIMIT $2
     ) q;`,
    [options.upgradeId, limit, knownAgentIds, reconvertibleOutcomes, ECMA_TRIM_WHITESPACE],
  )) as Array<{
    blocking_sources: number | string | null;
    missing_scope_sources: number | string | null;
  }>;

  const antiJoinBlocking = Number(probeRows[0]?.blocking_sources ?? 0);
  const antiJoinMissingScope = Number(probeRows[0]?.missing_scope_sources ?? 0);
  const totalBlocking = Math.max(antiJoinBlocking, pending.pendingSources);
  const limitReached = (antiJoinBlocking + antiJoinMissingScope) >= limit;

  return {
    blockingSources: totalBlocking,
    missingScopeBlockingSources: antiJoinMissingScope,
    pendingPublishableRows: pending.pendingRows,
    probedAt: new Date(),
    limitReached,
  };
}
