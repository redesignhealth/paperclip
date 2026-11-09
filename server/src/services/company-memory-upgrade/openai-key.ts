/**
 * Company OpenAI API key resolution and redaction registry (TECH-8191).
 *
 * ARCHITECTURAL CONTRACT:
 * - Reads company-scoped secret 'openai_api_key' from control plane database.
 * - Only provider 'local_encrypted' is supported directly; others fail with
 *   COMPANY_OPENAI_KEY_PROVIDER_UNSUPPORTED directing to --openai-key-file.
 * - Missing active secret fails with COMPANY_OPENAI_KEY_MISSING.
 * - Does NOT call secretService().resolveSecretValue (no binding context, HTTP errors, or access events).
 * - Does NOT fall back to platform default key.
 * - Does NOT read process.env.OPENAI_API_KEY (env var is strictly ignored).
 * - Key file path must be outside repo, non-symlink, mode 0600/0400 (never chmod), and 20..512 non-whitespace ASCII.
 * - API keys are stored in closures only, never on options/reports, and scrubbed via RedactionRegistry.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companySecrets, companySecretVersions, type Db } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { getSecretProvider } from "../../secrets/provider-registry.js";
import { isPathInside } from "./census.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export class RedactionRegistry {
  private secrets = new Set<string>();

  add(secret: string): void {
    if (typeof secret === "string" && secret.trim().length > 0) {
      this.secrets.add(secret.trim());
    }
  }

  scrub(text: string): string {
    if (!text) return "";
    let scrubbed = text;
    for (const secret of this.secrets) {
      if (secret.length > 0) {
        scrubbed = scrubbed.split(secret).join("[REDACTED_API_KEY]");
      }
    }
    // Mask typical OpenAI secret key patterns (sk-..., sk-proj-...)
    scrubbed = scrubbed.replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
    return scrubbed;
  }
}

export function isPrintableNonWhitespaceAscii(str: string): boolean {
  if (str.length < 20 || str.length > 512) {
    return false;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // ASCII 33 ('!') through 126 ('~') are printable non-whitespace characters
    if (code < 33 || code > 126) {
      return false;
    }
  }
  return true;
}

export interface ResolveCompanyOpenAiKeyParams {
  controlPlaneDb: Db;
  companyId: string;
  keyFilePath?: string | null;
  redaction?: RedactionRegistry;
  repoRoot?: string;
}

/**
 * Resolves the company OpenAI API key from either --openai-key-file or company_secrets.
 *
 * Never reads process.env.OPENAI_API_KEY.
 * Never falls back to platform default key.
 */
export async function resolveCompanyOpenAiKey(
  params: ResolveCompanyOpenAiKeyParams,
): Promise<string> {
  const { controlPlaneDb, companyId, keyFilePath, redaction, repoRoot } = params;

  if (keyFilePath) {
    const resolvedPath = path.resolve(process.cwd(), keyFilePath);
    const repoRootDir = repoRoot ?? path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

    let realRepoRoot = repoRootDir;
    try {
      realRepoRoot = realpathSync(repoRootDir);
    } catch {
      // fallback
    }

    if (isPathInside(resolvedPath, repoRootDir) || isPathInside(resolvedPath, realRepoRoot)) {
      throw new CompanyMemoryUpgradeError(
        "Refusing to read key file inside repository. API keys must not reside in the repository tree.",
        "INVALID_ARGUMENT",
      );
    }

    if (!existsSync(resolvedPath)) {
      throw new CompanyMemoryUpgradeError(
        "Key file does not exist at specified path.",
        "INVALID_ARGUMENT",
      );
    }

    let lstat;
    try {
      lstat = lstatSync(resolvedPath);
    } catch (err: any) {
      throw new CompanyMemoryUpgradeError(
        `Unable to stat key file: ${err.message}`,
        "INVALID_ARGUMENT",
      );
    }

    if (lstat.isSymbolicLink()) {
      throw new CompanyMemoryUpgradeError(
        "Refusing to read key file: symbolic links are not permitted.",
        "INVALID_ARGUMENT",
      );
    }

    let stat;
    try {
      stat = statSync(resolvedPath);
    } catch (err: any) {
      throw new CompanyMemoryUpgradeError(
        `Unable to stat key file: ${err.message}`,
        "INVALID_ARGUMENT",
      );
    }

    // Reject group or other access bits (mode & 0o077 !== 0)
    if ((stat.mode & 0o077) !== 0) {
      throw new CompanyMemoryUpgradeError(
        "Key file permissions too open. Must be mode 0600 or 0400 (no group or other access permissions).",
        "INVALID_ARGUMENT",
      );
    }

    let rawContent: string;
    try {
      rawContent = readFileSync(resolvedPath, "utf8");
    } catch (err: any) {
      throw new CompanyMemoryUpgradeError(
        `Failed to read key file: ${err.message}`,
        "INVALID_ARGUMENT",
      );
    }

    const trimmedKey = rawContent.trim();
    if (!isPrintableNonWhitespaceAscii(trimmedKey)) {
      throw new CompanyMemoryUpgradeError(
        "Invalid key file content: key must be 20-512 printable non-whitespace ASCII characters.",
        "INVALID_ARGUMENT",
      );
    }

    redaction?.add(trimmedKey);
    return trimmedKey;
  }

  // Sourced from company_secrets
  const rows = await controlPlaneDb
    .select({
      secretId: companySecrets.id,
      provider: companySecrets.provider,
      status: companySecrets.status,
      latestVersion: companySecrets.latestVersion,
      material: companySecretVersions.material,
      versionStatus: companySecretVersions.status,
    })
    .from(companySecrets)
    .innerJoin(
      companySecretVersions,
      and(
        eq(companySecretVersions.secretId, companySecrets.id),
        eq(companySecretVersions.version, companySecrets.latestVersion),
      ),
    )
    .where(
      and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.key, "openai_api_key"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
        eq(companySecretVersions.status, "current"),
        isNull(companySecretVersions.revokedAt),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new CompanyMemoryUpgradeError(
      "No active company-scoped openai_api_key found in control plane database.",
      "COMPANY_OPENAI_KEY_MISSING",
    );
  }

  const row = rows[0];

  if (row.provider !== "local_encrypted") {
    throw new CompanyMemoryUpgradeError(
      `Company openai_api_key uses provider '${row.provider}'. Only 'local_encrypted' is supported directly. Use --openai-key-file to supply an external key file.`,
      "COMPANY_OPENAI_KEY_PROVIDER_UNSUPPORTED",
    );
  }

  const secretProvider = getSecretProvider("local_encrypted");
  const decrypted = await secretProvider.resolveVersion({
    material: row.material as any,
    externalRef: null,
  });

  if (typeof decrypted !== "string" || !isPrintableNonWhitespaceAscii(decrypted.trim())) {
    throw new CompanyMemoryUpgradeError(
      "Decrypted company openai_api_key secret does not contain a valid API key.",
      "COMPANY_OPENAI_KEY_MISSING",
    );
  }

  const trimmedKey = decrypted.trim();
  redaction?.add(trimmedKey);
  return trimmedKey;
}
