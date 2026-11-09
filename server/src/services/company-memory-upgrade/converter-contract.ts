/**
 * Converter contract and output validation for company memory upgrades (TECH-8191).
 *
 * ARCHITECTURAL INVARIANTS:
 * - This module is pure and deterministic.
 * - Staging payloads contain normalized, validated, and atomic facts.
 * - Pinned CONVERTER_CONTRACT_SHA256 ensures prompt or schema drift requires an explicit contract version bump.
 */

import { createHash } from "node:crypto";
import { normalizeMemoryContent } from "./census.js";
import { detectSensitiveFamilies, type SensitiveFamilyName } from "./sensitive-patterns.js";

export const CONVERTER_ID = "paperclip.memory-upgrade.atomic-converter";
export const CONVERTER_VERSION = 1;

export const SUPPORTED_CONVERTER_MODELS = ["gpt-5.4-mini"] as const;
export type SupportedConverterModel = (typeof SUPPORTED_CONVERTER_MODELS)[number];

export const MEMORY_TYPES = [
  "preference",
  "decision",
  "lesson",
  "fact",
  "procedure",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const CONVERSION_DECISIONS = [
  "convert",
  "drop_noise",
  "drop_sensitive",
] as const;
export type ConversionDecision = (typeof CONVERSION_DECISIONS)[number];

export const CONVERSION_SYSTEM_PROMPT = `You are a precision memory upgrade converter for Paperclip.
Convert legacy unstructured company memories into 1 to 3 standalone, atomic, durable memory records.

RULES:
1. ATOMICITY: Each record must be exactly one atomic sentence expressing one single durable fact, decision, preference, lesson, or procedure.
2. NO PRONOUNS: Do not use standalone or ambiguous pronouns ("he", "she", "they", "it") outside the sentence; every entity must be explicitly named.
3. NO RELATIVE DATES: Never use relative dates like "yesterday", "last week", "today", or "tomorrow". Use explicit dates only if present in the source.
4. NO FRAMING: Do not use meta-framing like "The user said", "The memory states", or "It was noted that". State the fact directly.
5. NO INVENTED IDENTIFIERS: Never fabricate or hallucinate identifiers, URLs, dates, people, or systems not explicitly present in the source text.
6. SUBJECT: The subject must be a concise noun phrase (2-80 characters) summarizing what or who the record is about.
7. CONFIDENCE: A number between 0.0 and 1.0 reflecting certainty directly supported by the source text.
8. DECISION drop_sensitive: If the source contains credentials, API keys, bearer tokens, passwords, credit card numbers, SSNs, private keys, or personal authentication data, set decision to "drop_sensitive" and return empty records.
9. DECISION drop_noise: If the source is an acknowledgment, greeting, test string, placeholder, or devoid of durable substance, set decision to "drop_noise" and return empty records.
10. DECISION convert: If the source contains substantive knowledge, set decision to "convert" and return between 1 and 3 records.`;

/**
 * Strict JSON schema for Structured Outputs.
 * Note: OpenAI strict mode json_schema ignores minLength, maxLength, minimum, maximum,
 * minItems, and maxItems. All property bounds and atomicity constraints are enforced
 * in validateConversionOutput().
 */
export const CONVERSION_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["convert", "drop_noise", "drop_sensitive"],
    },
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          data: { type: "string" },
          type: { type: "string", enum: ["preference", "decision", "lesson", "fact", "procedure"] },
          subject: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["data", "type", "subject", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["decision", "records"],
  additionalProperties: false,
} as const;

export function computeConverterContractSha256(): string {
  return createHash("sha256")
    .update(CONVERSION_SYSTEM_PROMPT + JSON.stringify(CONVERSION_JSON_SCHEMA) + SUPPORTED_CONVERTER_MODELS.join(","))
    .digest("hex");
}

export const CONVERTER_CONTRACT_SHA256 = "2612137680b3711d352e7e1bb140b246ec7ddf094165f524cbe56066b8711145";

export const CONVERSION_REJECT_CODES = [
  "not_json",
  "not_object",
  "decision_invalid",
  "records_not_array",
  "records_not_empty_on_drop",
  "empty_records",
  "too_many_records",
  "data_not_string",
  "data_too_short",
  "data_too_long",
  "data_not_atomic",
  "data_sensitive_echo",
  "type_invalid",
  "subject_invalid",
  "confidence_invalid",
] as const;

export type ConversionRejectCode = (typeof CONVERSION_REJECT_CODES)[number];

export interface ConversionRecord {
  data: string;
  type: MemoryType;
  subject: string;
  confidence: number;
}

export type ConversionValidationResult =
  | {
      ok: true;
      decision: "convert";
      records: ConversionRecord[];
    }
  | {
      ok: true;
      decision: "drop_noise" | "drop_sensitive";
      records: [];
    }
  | {
      ok: false;
      rejectCode: "data_sensitive_echo";
      sensitiveReasonCode: string;
    }
  | {
      ok: false;
      rejectCode: Exclude<ConversionRejectCode, "data_sensitive_echo">;
    };

/**
 * Validates raw model output against the converter contract invariants.
 */
export function validateConversionOutput(raw: unknown): ConversionValidationResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, rejectCode: "not_json" };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, rejectCode: "not_object" };
  }

  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision;

  if (
    decision !== "convert" &&
    decision !== "drop_noise" &&
    decision !== "drop_sensitive"
  ) {
    return { ok: false, rejectCode: "decision_invalid" };
  }

  const records = obj.records;
  if (!Array.isArray(records)) {
    return { ok: false, rejectCode: "records_not_array" };
  }

  if (decision === "drop_noise" || decision === "drop_sensitive") {
    if (records.length !== 0) {
      return { ok: false, rejectCode: "records_not_empty_on_drop" };
    }
    return { ok: true, decision, records: [] };
  }

  // decision === "convert"
  if (records.length === 0) {
    return { ok: false, rejectCode: "empty_records" };
  }
  if (records.length > 3) {
    return { ok: false, rejectCode: "too_many_records" };
  }

  const validatedRecords: ConversionRecord[] = [];

  for (const item of records) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, rejectCode: "not_object" };
    }

    const rec = item as Record<string, unknown>;

    if (typeof rec.data !== "string") {
      return { ok: false, rejectCode: "data_not_string" };
    }

    const trimmedData = rec.data.trim();
    if (trimmedData.length < 8) {
      return { ok: false, rejectCode: "data_too_short" };
    }
    if (trimmedData.length > 400) {
      return { ok: false, rejectCode: "data_too_long" };
    }

    // Atomicity checks:
    // - no newline characters (\r or \n)
    // - no semicolons (;)
    // - no second sentence via sentence-ending punctuation followed by whitespace and a non-whitespace character
    // - no conjunction chaining via /\band also\b/i
    if (
      /[\r\n]/.test(rec.data) ||
      rec.data.includes(";") ||
      /[.!?]\s+\S/.test(rec.data) ||
      /\band also\b/i.test(rec.data)
    ) {
      return { ok: false, rejectCode: "data_not_atomic" };
    }

    // Sensitive data detection on model output
    const sensitive = detectSensitiveFamilies(rec.data);
    if (sensitive.isSensitive) {
      const families = (Object.entries(sensitive.matches) as Array<[SensitiveFamilyName, boolean]>)
        .filter(([, hit]) => hit)
        .map(([fam]) => fam)
        .sort()
        .join(",");
      return {
        ok: false,
        rejectCode: "data_sensitive_echo",
        sensitiveReasonCode: families,
      };
    }

    if (
      typeof rec.type !== "string" ||
      !MEMORY_TYPES.includes(rec.type as MemoryType)
    ) {
      return { ok: false, rejectCode: "type_invalid" };
    }

    if (typeof rec.subject !== "string") {
      return { ok: false, rejectCode: "subject_invalid" };
    }
    const trimmedSubject = rec.subject.trim();
    if (trimmedSubject.length < 2 || trimmedSubject.length > 80) {
      return { ok: false, rejectCode: "subject_invalid" };
    }

    if (
      typeof rec.confidence !== "number" ||
      !Number.isFinite(rec.confidence) ||
      rec.confidence < 0 ||
      rec.confidence > 1
    ) {
      return { ok: false, rejectCode: "confidence_invalid" };
    }

    validatedRecords.push({
      data: trimmedData,
      type: rec.type as MemoryType,
      subject: trimmedSubject,
      confidence: rec.confidence,
    });
  }

  return {
    ok: true,
    decision: "convert",
    records: validatedRecords,
  };
}

/**
 * Computes sha256 of normalizeMemoryContent(data).
 */
export function computeRecordDataSha256(data: string): string {
  const normalized = normalizeMemoryContent(data);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export interface BuildTargetPayloadInput {
  record: ConversionRecord;
  sourceId: string;
  agentId: string;
  companyId: string;
  upgradeId: string;
  sourcePayloadCreatedAt: string | null;
  conversionTimeIso?: string;
  sourcePayload?: Record<string, unknown> | null;
}

/**
 * Builds the staging payload for a converted memory record.
 *
 * Invariants:
 * - created_at preserves source payload created_at verbatim.
 * - updated_at is the conversion timestamp ISO string.
 * - hash is md5 of data.
 * - paperclip_run_id, run_id, issue_id, responsible_user_id are carried forward
 *   ONLY when present on sourcePayload; when absent, the keys are completely omitted (never null).
 */
export function buildTargetPayload(input: BuildTargetPayloadInput): Record<string, unknown> {
  const {
    record,
    sourceId,
    agentId,
    companyId,
    upgradeId,
    sourcePayloadCreatedAt,
    conversionTimeIso = new Date().toISOString(),
    sourcePayload,
  } = input;

  const dataMd5 = createHash("md5").update(record.data, "utf8").digest("hex");

  const payload: Record<string, unknown> = {
    data: record.data,
    user_id: agentId,
    agent_id: agentId,
    hash: dataMd5,
    created_at: sourcePayloadCreatedAt,
    updated_at: conversionTimeIso,
    type: record.type,
    subject: record.subject,
    confidence: record.confidence,
    paperclip_company_id: companyId,
    migrated_from: sourceId,
    migration_id: upgradeId,
    converter: {
      id: CONVERTER_ID,
      version: CONVERTER_VERSION,
    },
  };

  if (sourcePayload && typeof sourcePayload === "object") {
    if ("paperclip_run_id" in sourcePayload && sourcePayload.paperclip_run_id !== undefined) {
      payload.paperclip_run_id = sourcePayload.paperclip_run_id;
    }
    if ("run_id" in sourcePayload && sourcePayload.run_id !== undefined) {
      payload.run_id = sourcePayload.run_id;
    }
    if ("issue_id" in sourcePayload && sourcePayload.issue_id !== undefined) {
      payload.issue_id = sourcePayload.issue_id;
    }
    if ("responsible_user_id" in sourcePayload && sourcePayload.responsible_user_id !== undefined) {
      payload.responsible_user_id = sourcePayload.responsible_user_id;
    }
  }

  return payload;
}

/**
 * Formats a vector array as a pgvector string literal (JSON.stringify(vector)).
 * In SQL queries, this is bound as text with `::vector(1536)`. Never bind JS number arrays.
 */
export function formatPgVectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}
