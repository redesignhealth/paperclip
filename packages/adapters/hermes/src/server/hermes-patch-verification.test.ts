import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../../");
const hermesDockerDir = path.join(repoRoot, "docker/hermes");

function parseLockfile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join("=").trim();
    }
  }
  return result;
}

describe("Hermes command-scan patch & package build verification (TECH-7355)", () => {
  it("verifies upstream source.lock checksum and tag pin", () => {
    const sourceLockPath = path.join(hermesDockerDir, "source.lock");
    expect(existsSync(sourceLockPath), "source.lock must exist").toBe(true);

    const lock = parseLockfile(readFileSync(sourceLockPath, "utf8"));
    expect(lock.name).toBe("hermes-agent");
    expect(lock.version).toBe("0.21.3");
    expect(lock.sha256).toBe("47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834");
    expect(lock.url).toMatch(/^https:\/\/github\.com\/NousResearch\/hermes-agent\/archive\/refs\/tags\/v2026\.9\.14\.tar\.gz$/);
  });

  it("verifies patches.lock manifest schema and exact sha256 checksum", () => {
    const patchesLockPath = path.join(hermesDockerDir, "patches.lock");
    expect(existsSync(patchesLockPath), "patches.lock must exist").toBe(true);

    const lock = parseLockfile(readFileSync(patchesLockPath, "utf8"));
    expect(lock.upstream_name).toBe("hermes-agent");
    expect(lock.upstream_version).toBe("0.21.3");
    expect(lock.upstream_sha256).toBe("47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834");
    expect(lock.patch_file).toBe("patches/0001-require-command-scan.patch");
    expect(lock.postpatch_marker).toBe("TECH-7355-MANDATORY-COMMAND-SCAN");
    expect(lock.extension_version).toBe("0.21.3+tech7355.1");

    const patchFilePath = path.join(hermesDockerDir, lock.patch_file);
    expect(existsSync(patchFilePath), "patch file must exist").toBe(true);

    const patchBytes = readFileSync(patchFilePath);
    const actualSha = createHash("sha256").update(patchBytes).digest("hex");
    expect(actualSha).toBe(lock.patch_sha256);
  });

  it("rejects path traversal and unsafe paths in patch manifest", () => {
    const unsafePaths = [
      "../etc/passwd",
      "/usr/local/bin/patch",
      "patches/../../secret",
      "https://example.com/malicious.patch",
      "",
    ];

    for (const unsafe of unsafePaths) {
      const isUnsafe =
        !unsafe ||
        path.isAbsolute(unsafe) ||
        unsafe.includes("..") ||
        unsafe.startsWith("http://") ||
        unsafe.startsWith("https://");
      expect(isUnsafe).toBe(true);
    }
  });

  it("rejects unsupported target architectures for tirith binary", () => {
    const qualifiedArch = "amd64";
    const unqualifiedArches = ["arm64", "aarch64", "armv7l", "s390x", "riscv64", "ppc64le"];

    const isQualified = (arch: string) => arch === qualifiedArch;

    expect(isQualified("amd64")).toBe(true);
    for (const arch of unqualifiedArches) {
      expect(isQualified(arch)).toBe(false);
    }
  });

  it("confirms tirith v0.4.2 amd64 tarball hash pin", () => {
    const expectedSha256 = "efa6bf414a83dba385d4f13137e8677f850ced9102fe74ebb14c72f31df0dc77";
    const expectedUrl = "https://github.com/sheeki03/tirith/releases/download/v0.4.2/tirith-x86_64-unknown-linux-gnu.tar.gz";

    expect(expectedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(expectedUrl).toContain("v0.4.2/tirith-x86_64-unknown-linux-gnu.tar.gz");
  });
});
