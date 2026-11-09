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
 * - Key file path must be outside repo (lexically AND under realpath, including a symlinked
 *   parent directory), non-symlink (enforced via O_NOFOLLOW on a single
 *   O_RDONLY|O_NOFOLLOW|O_NONBLOCK open), a regular file (fstat on the open descriptor,
 *   rejecting FIFOs/devices/etc.), mode 0600/0400 (never chmod -- rejected, not corrected),
 *   and 20..512 non-whitespace ASCII. The descriptor's realpath identity (dev+ino) is
 *   re-validated against a fresh realpathSync() so a pathname swap between validation and
 *   read cannot cause one file to be validated while a different file is read.
 * - API keys are stored in closures only, never on options/reports, and scrubbed via RedactionRegistry.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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

    // LEXICAL repo containment check, against both the as-given repo root and its
    // symlink-resolved real path.
    if (isPathInside(resolvedPath, repoRootDir) || isPathInside(resolvedPath, realRepoRoot)) {
      throw new CompanyMemoryUpgradeError(
        "Refusing to read key file inside repository. API keys must not reside in the repository tree.",
        "INVALID_ARGUMENT",
      );
    }

    // REAL (symlink-resolved) repo containment check, including a symlinked PARENT
    // directory: the lexical path can look external while actually resolving, via an
    // ancestor symlink, to a location inside the repository tree. Resolve only the
    // PARENT directory here -- the leaf itself must never be followed as a symlink,
    // which is enforced atomically by O_NOFOLLOW on the open() below.
    const parentDir = path.dirname(resolvedPath);
    let realParentDir: string;
    try {
      realParentDir = realpathSync(parentDir);
    } catch {
      throw new CompanyMemoryUpgradeError(
        "Key file does not exist at specified path.",
        "INVALID_ARGUMENT",
      );
    }
    const realResolvedPath = path.join(realParentDir, path.basename(resolvedPath));
    if (isPathInside(realResolvedPath, repoRootDir) || isPathInside(realResolvedPath, realRepoRoot)) {
      throw new CompanyMemoryUpgradeError(
        "Refusing to read key file inside repository via symlinked parent directory. API keys must not reside in the repository tree.",
        "INVALID_ARGUMENT",
      );
    }

    // Single atomic open: O_NOFOLLOW makes the kernel refuse the open outright (no
    // TOCTOU window) if the FINAL path component is itself a symlink; O_NONBLOCK
    // prevents an indefinite hang if the path names a FIFO (rejected below once fstat
    // confirms it is not a regular file, rather than blocking forever waiting for a writer).
    let fd: number;
    try {
      fd = openSync(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new CompanyMemoryUpgradeError(
          "Key file does not exist at specified path.",
          "INVALID_ARGUMENT",
        );
      }
      if (err?.code === "ELOOP") {
        throw new CompanyMemoryUpgradeError(
          "Refusing to read key file: symbolic links are not permitted.",
          "INVALID_ARGUMENT",
        );
      }
      // Bounded, generic failure: never echo the path or any filesystem error detail.
      throw new CompanyMemoryUpgradeError(
        "Key file could not be opened.",
        "INVALID_ARGUMENT",
      );
    }

    try {
      const fdStat = fstatSync(fd);

      if (!fdStat.isFile()) {
        throw new CompanyMemoryUpgradeError(
          "Key file must be a regular file.",
          "INVALID_ARGUMENT",
        );
      }

      // Reject group or other access bits (mode & 0o077 !== 0). Checked on the OPEN
      // descriptor (fstat), never re-derived from a fresh stat-by-path call.
      if ((fdStat.mode & 0o077) !== 0) {
        throw new CompanyMemoryUpgradeError(
          "Key file permissions too open. Must be mode 0600 or 0400 (no group or other access permissions).",
          "INVALID_ARGUMENT",
        );
      }

      // Validate realpath identity (dev+ino) against the file we ACTUALLY opened. This
      // closes a pathname-swap race: even if the containment checks above and the
      // open() call above all individually succeeded against path strings, this
      // confirms the inode the filesystem resolves the path to right now is the exact
      // same inode we have open and are about to read -- a swap in between would be
      // caught here rather than silently validating one file and reading another.
      let realStat;
      try {
        const realpathNow = realpathSync(resolvedPath);
        realStat = statSync(realpathNow);
      } catch {
        throw new CompanyMemoryUpgradeError(
          "Key file identity could not be verified.",
          "INVALID_ARGUMENT",
        );
      }
      if (realStat.dev !== fdStat.dev || realStat.ino !== fdStat.ino) {
        throw new CompanyMemoryUpgradeError(
          "Key file identity changed during validation.",
          "INVALID_ARGUMENT",
        );
      }

      let rawContent: string;
      try {
        rawContent = readFileSync(fd, "utf8");
      } catch {
        throw new CompanyMemoryUpgradeError(
          "Key file could not be read.",
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
    } finally {
      // Always close the descriptor. Never chmod the file (permissions are validated,
      // not corrected).
      closeSync(fd);
    }
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
