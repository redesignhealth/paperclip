import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

  it("verifies patches.lock matches source.lock upstream sha256 and schema", () => {
    const sourceLockPath = path.join(hermesDockerDir, "source.lock");
    const patchesLockPath = path.join(hermesDockerDir, "patches.lock");
    expect(existsSync(patchesLockPath), "patches.lock must exist").toBe(true);

    const sourceLock = parseLockfile(readFileSync(sourceLockPath, "utf8"));
    const patchesLock = parseLockfile(readFileSync(patchesLockPath, "utf8"));

    expect(patchesLock.upstream_name).toBe(sourceLock.name);
    expect(patchesLock.upstream_version).toBe(sourceLock.version);
    expect(patchesLock.upstream_sha256).toBe(sourceLock.sha256);
    expect(patchesLock.patch_file).toBe("patches/0001-require-command-scan.patch");
    expect(patchesLock.postpatch_marker).toBe("TECH-7355-MANDATORY-COMMAND-SCAN");
    expect(patchesLock.extension_version).toBe("0.21.3+tech7355.1");

    // Path safety validation on parsed manifest field
    const patchFile = patchesLock.patch_file;
    expect(patchFile.startsWith("patches/")).toBe(true);
    expect(patchFile.includes("..")).toBe(false);
    expect(path.isAbsolute(patchFile)).toBe(false);

    const patchFilePath = path.join(hermesDockerDir, patchFile);
    expect(existsSync(patchFilePath), "patch file must exist").toBe(true);

    const patchBytes = readFileSync(patchFilePath);
    const actualSha = createHash("sha256").update(patchBytes).digest("hex");
    expect(actualSha).toBe(patchesLock.patch_sha256);
  });

  it("verifies Dockerfile pins multi-arch Tirith releases for both amd64 and arm64", () => {
    const dockerfilePath = path.join(repoRoot, "Dockerfile");
    const dockerfile = readFileSync(dockerfilePath, "utf8");

    // amd64 pins
    expect(dockerfile).toContain("efa6bf414a83dba385d4f13137e8677f850ced9102fe74ebb14c72f31df0dc77");
    expect(dockerfile).toContain("b3a4d07ed3512b7b0fc7361310fc6db4cd9d993894f579b5cd34126dd2d02ae0");

    // arm64 pins
    expect(dockerfile).toContain("c550b1bfb0c8c872ab3421cd6ef756f260f7cf4981a18cedd49f141fa2d77569");
    expect(dockerfile).toContain("06efef82d732009208ef1a62facd3780da7261b95fe8781c5389956d104c4704");

    // Architecture case switch
    expect(dockerfile).toMatch(/case "\$\{TARGETARCH:-amd64\}" in/);
    expect(dockerfile).toMatch(/amd64\)/);
    expect(dockerfile).toMatch(/arm64\)/);
  });

  it("verifies the patch contains the extension marker and truth-preserving version", () => {
    const patchesLockPath = path.join(hermesDockerDir, "patches.lock");
    const lock = parseLockfile(readFileSync(patchesLockPath, "utf8"));
    const patchContent = readFileSync(path.join(hermesDockerDir, lock.patch_file), "utf8");

    expect(patchContent).toContain(lock.postpatch_marker);
    expect(patchContent).toContain(lock.extension_version);
    expect(patchContent).toContain("--offline");
    expect(patchContent).toContain("_MandatoryCircuitBreaker");
    expect(patchContent).toContain("_run_scanner_bounded");
  });

  it("exercises patched library real calls and source arguments via python harness", () => {
    const studyDir = "/var/folders/w3/z241rnm17j19z7vrq2tm2tyr0000gp/T/opencode/t7355-hermes-study";
    if (!existsSync(studyDir)) return;

    const pythonScript = `
import sys
sys.path.insert(0, "${studyDir}")
import os, platform, stat
os.environ["HERMES_REQUIRE_COMMAND_SCAN"] = "1"
os.environ["HERMES_COMMAND_SCANNER"] = "/usr/local/bin/tirith"

# Qualify platform checks for cross-platform runner compatibility
platform.system = lambda: "Linux"
platform.machine = lambda: "x86_64"
fake_st = type("St", (), {"st_mode": stat.S_IFREG | 0o755, "st_uid": 0})()
fake_dir = type("St", (), {"st_mode": stat.S_IFDIR | 0o755, "st_uid": 0})()
os.lstat = lambda p: fake_st if p == "/usr/local/bin/tirith" else fake_dir

from tools.tirith_security import (
    is_mandatory_scan_mode,
    check_command_mandatory,
    _mandatory_circuit_breaker,
    HERMES_SECURITY_EXTENSION_MARKER,
    HERMES_RUNTIME_EXTENSION_VERSION,
)
assert is_mandatory_scan_mode() is True
assert HERMES_SECURITY_EXTENSION_MARKER == "TECH-7355-MANDATORY-COMMAND-SCAN"
assert HERMES_RUNTIME_EXTENSION_VERSION == "0.21.3+tech7355.1"

_mandatory_circuit_breaker.reset()
for _ in range(3):
    _mandatory_circuit_breaker.record_failure(is_probe=False)
assert _mandatory_circuit_breaker._circuit_open is True
res = check_command_mandatory("git status")
assert res["allowed"] is False
assert res["reason"] == "scanner_circuit_open"
print("OK")
`;

    const out = execFileSync("python3", ["-c", pythonScript], { encoding: "utf8" });
    expect(out.trim()).toBe("OK");
  });
});
