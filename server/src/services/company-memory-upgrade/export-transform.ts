/**
 * Payload validation and record transformation for memory upgrade export (TECH-8573).
 */

import { isValidUuid } from "./census.js";
import {
  EXPORT_MAX_METADATA_CHARS,
  EXPORT_MAX_TEXT_CHARS,
  type ExportJsonlRecord,
  type StagingExportRow,
  type TransformStagingResult,
  parseAndNormalizeUtcIsoTimestamp,
} from "./export-contract.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export {
  EXPORT_MAX_TEXT_CHARS,
  EXPORT_MAX_METADATA_CHARS,
  parseAndNormalizeUtcIsoTimestamp,
  type StagingExportRow,
  type ExportJsonlRecord,
  type TransformStagingResult,
};

export function transformAndValidateStagingRows(
  rows: StagingExportRow[],
  companyId: string,
  agentId: string,
  upgradeId: string,
  converterId: string,
  converterVersion: number,
): TransformStagingResult {
  const cCo = companyId.trim().toLowerCase();
  const cAg = agentId.trim().toLowerCase();
  const cUp = upgradeId.trim().toLowerCase();

  const violations: Record<string, number> = {};
  const record = (k: string) => { violations[k] = (violations[k] ?? 0) + 1; };

  const records: ExportJsonlRecord[] = [];
  const perTypeCounts: Record<string, number> = {};
  const charLengths: number[] = [];
  let totalChars = 0;

  for (const row of rows) {
    let fail = false;
    if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
      record("payload_non_object");
      continue;
    }

    const pUser = typeof row.payload.user_id === "string" ? row.payload.user_id.trim().toLowerCase() : null;
    const sAgent = typeof row.staging_agent_id === "string" ? row.staging_agent_id.trim().toLowerCase() : null;
    if (pUser !== cAg || sAgent !== cAg) { record("payload_user_id_mismatch"); fail = true; }

    // Ledger output_ids recomputed verification (document: ledger output_ids are recomputed from staging inside same tx)
    if (Array.isArray(row.output_ids)) {
      const ids = row.output_ids.map((id) => String(id).trim().toLowerCase());
      if (!ids.includes(row.output_id.trim().toLowerCase())) { record("ledger_output_id_missing"); fail = true; }
    }

    const data = row.payload.data;
    if (typeof data !== "string" || data.length === 0) { record("text_empty_or_non_string"); fail = true; }
    else if (data.length > EXPORT_MAX_TEXT_CHARS) { record("text_too_long"); fail = true; }

    const c = row.payload.confidence;
    if (typeof c !== "number" || typeof c === "boolean" || !Number.isFinite(c) || c < 0 || c > 1) {
      record("confidence_invalid"); fail = true;
    }

    const type = row.payload.type;
    if (type !== null && type !== undefined && (typeof type !== "string" || type.length > EXPORT_MAX_METADATA_CHARS)) {
      record("type_invalid"); fail = true;
    }

    const subject = row.payload.subject;
    if (subject !== null && subject !== undefined && (typeof subject !== "string" || subject.length > EXPORT_MAX_METADATA_CHARS)) {
      record("subject_invalid"); fail = true;
    }

    const ts = parseAndNormalizeUtcIsoTimestamp(row.payload.created_at);
    if (!ts.valid) { record("created_at_invalid"); fail = true; }

    const cOut = row.output_id ? row.output_id.trim().toLowerCase() : "";
    const cSrc = row.source_id ? row.source_id.trim().toLowerCase() : "";
    if (!isValidUuid(cOut) || !isValidUuid(cSrc) || !isValidUuid(cCo) || !isValidUuid(cAg) || !isValidUuid(cUp)) {
      record("uuid_invalid"); fail = true;
    }

    if (fail) continue;

    const typeStr = typeof type === "string" && type.length > 0 ? type : "(none)";
    perTypeCounts[typeStr] = (perTypeCounts[typeStr] ?? 0) + 1;
    charLengths.push(data.length);
    totalChars += data.length;

    records.push({
      import_key: cOut,
      company_id: cCo,
      agent_id: cAg,
      text: data,
      created_at: ts.iso,
      type: typeof type === "string" ? type : null,
      subject: typeof subject === "string" ? subject : null,
      confidence: c,
      migrated_from: cSrc,
      migration_id: cUp,
      converter_id: converterId,
      converter_version: converterVersion,
    });
  }

  if (Object.keys(violations).length > 0) {
    const summary = Object.entries(violations).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(", ");
    throw new CompanyMemoryUpgradeError(
      `Importer contract violation detected (${summary}). Export aborted.`,
      "IMPORTER_CONTRACT_VIOLATION",
    );
  }

  return { records, perTypeCounts, charLengths, totalChars };
}
