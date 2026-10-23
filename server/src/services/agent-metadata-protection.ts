/**
 * Server-managed `agents.metadata.defaultMcp` protection (TECH-7204).
 *
 * The protected key can only be written by the default-MCP services. Every caller-driven metadata
 * write (create, update, approval-activation replay) goes through the SAME parameterized SQL
 * expression, which reads the CURRENT row at UPDATE time. Nothing is read in JavaScript first, so a
 * concurrent setup checkpoint or owner binding can never be lost to a stale read.
 */
import { sql, type SQL } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { DEFAULT_MCP_METADATA_KEY } from "./default-mcp-spec.js";

export type AgentMetadataPatch = Record<string, unknown> | null | undefined;

/** Metadata is `undefined` (absent), `null`, or a plain object. Arrays and primitives are never valid. */
export function isAgentMetadataShape(value: unknown): value is AgentMetadataPatch {
  return value === undefined || value === null || (typeof value === "object" && !Array.isArray(value));
}

export function assertAgentMetadataShape(value: unknown): asserts value is AgentMetadataPatch {
  if (!isAgentMetadataShape(value)) {
    throw unprocessable("Agent metadata must be an object or null", { code: "agent_metadata_invalid_shape" });
  }
}

/** Drops the caller's copy of the reserved key. Everything else is ordinary caller data. */
export function stripProtectedMetadataKey(patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...patch };
  delete next[DEFAULT_MCP_METADATA_KEY];
  return next;
}

/**
 * `SET metadata = <this>`: ordinary replacement semantics for caller keys, with the CURRENT row's
 * protected key carried over. A null patch clears ordinary metadata only (NULL when nothing is protected).
 */
export function protectedMetadataReplacement(patch: Record<string, unknown> | null): SQL {
  const key = DEFAULT_MCP_METADATA_KEY;
  const protectedCurrent = sql`CASE WHEN ${agents.metadata} ? ${key}::text THEN jsonb_build_object(${key}::text, ${agents.metadata} -> ${key}::text) ELSE NULL END`;
  if (patch === null) return protectedCurrent;
  return sql`(${JSON.stringify(stripProtectedMetadataKey(patch))}::jsonb - ${key}::text) || coalesce(${protectedCurrent}, '{}'::jsonb)`;
}
