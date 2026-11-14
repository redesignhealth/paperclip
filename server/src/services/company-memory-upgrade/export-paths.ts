/**
 * Path and directory validation for memory upgrade export (TECH-8573).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./census.js";
import type { ExportJsonlRecord } from "./export-transform.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export function validateOutputDir(dirPath: string, repoRootPath?: string): string {
  const resolvedDir = path.resolve(process.cwd(), dirPath);
  const repoRoot = repoRootPath ?? path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    // fallback if repoRoot cannot be resolved with realpath
  }

  if (isPathInside(resolvedDir, repoRoot) || isPathInside(resolvedDir, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      "Refusing to write output inside repository. Memory reports contain sensitive identifiers. Use an external directory such as /tmp.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  if (!existsSync(resolvedDir)) {
    throw new CompanyMemoryUpgradeError(
      "Parent directory does not exist. The output parent directory must exist prior to execution.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  const realDir = realpathSync(resolvedDir);
  if (isPathInside(realDir, repoRoot) || isPathInside(realDir, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      "Refusing to write output inside repository via symlinked parent. Use an external directory such as /tmp.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  return realDir;
}

export async function writeExportFiles(params: {
  outputDir: string;
  repoRoot?: string;
  companyId: string;
  agentId: string;
  upgradeId: string;
  converterId: string;
  converterVersion: number;
  records: ExportJsonlRecord[];
  skippedCountsByOutcome: Record<string, number>;
  _internalManifestWriteFailureHook?: () => Promise<void> | void;
}): Promise<{ jsonlPath: string; manifestPath: string; jsonlSha256: string }> {
  const validatedDir = validateOutputDir(params.outputDir, params.repoRoot);
  const jsonlFinal = path.join(validatedDir, `export-${params.agentId}.jsonl`);
  const manifestFinal = path.join(validatedDir, `export-${params.agentId}.manifest.json`);

  if (existsSync(jsonlFinal) || existsSync(manifestFinal)) {
    const err = new Error("Output file already exists.");
    (err as any).code = "EEXIST";
    throw err;
  }

  const nonce = randomBytes(6).toString("hex");
  const jsonlTmp = path.join(validatedDir, `.export-${params.agentId}-${nonce}.jsonl.tmp`);
  const manifestTmp = path.join(validatedDir, `.export-${params.agentId}-${nonce}.manifest.json.tmp`);

  const createdArtifacts: string[] = [];

  try {
    const jsonlLines =
      params.records.map((r) => JSON.stringify(r)).join("\n") +
      (params.records.length > 0 ? "\n" : "");
    const jsonlSha256 = createHash("sha256").update(jsonlLines).digest("hex");

    await writeFile(jsonlTmp, jsonlLines, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    createdArtifacts.push(jsonlTmp);

    if (params._internalManifestWriteFailureHook) {
      await params._internalManifestWriteFailureHook();
    }

    const manifest = {
      format_version: 1,
      company_id: params.companyId,
      agent_id: params.agentId,
      upgrade_id: params.upgradeId,
      converter_id: params.converterId,
      converter_version: params.converterVersion,
      record_count: params.records.length,
      skipped_counts_by_outcome: params.skippedCountsByOutcome,
      jsonl_sha256: jsonlSha256,
      created_at: new Date().toISOString(),
      tool: "paperclip memory:upgrade export",
    };

    await writeFile(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    createdArtifacts.push(manifestTmp);

    // Atomic no-clobber publish: link then unlink
    await link(jsonlTmp, jsonlFinal);
    createdArtifacts.push(jsonlFinal);
    await unlink(jsonlTmp);
    const tmp1Idx = createdArtifacts.indexOf(jsonlTmp);
    if (tmp1Idx >= 0) createdArtifacts.splice(tmp1Idx, 1);

    await link(manifestTmp, manifestFinal);
    createdArtifacts.push(manifestFinal);
    await unlink(manifestTmp);
    const tmp2Idx = createdArtifacts.indexOf(manifestTmp);
    if (tmp2Idx >= 0) createdArtifacts.splice(tmp2Idx, 1);

    return { jsonlPath: jsonlFinal, manifestPath: manifestFinal, jsonlSha256 };
  } catch (error) {
    for (const f of createdArtifacts) {
      try {
        await unlink(f);
      } catch {
        // ignore cleanup error
      }
    }
    throw error;
  }
}
