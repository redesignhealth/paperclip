/**
 * Source content hashing for memory upgrade tracking (TECH-8191).
 */

import { createHash } from "node:crypto";

/**
 * Computes sha256 hash of raw UTF-8 memory content text.
 */
export function computeSourceContentSha256(data: string | null | undefined): string {
  return createHash("sha256").update(data ?? "", "utf8").digest("hex");
}
