import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HERMES_CLI } from "../../../packages/adapters/hermes/src/shared/constants.js";
import { HERMES_MEMORY_REQUIRED_MODULES } from "@paperclipai/hermes-paperclip-adapter/server";

/**
 * Deterministic integrity tests for the Hermes CLI installation in the production Dockerfile
 * and its committed hash-locked dependency closure.
 *
 * Verifies that:
 * 1. The production stage installs the hash-locked PyPI closure (`docker/hermes/requirements.txt`, reviewable chunk
 *    includes) and then hermes-agent itself from a sha256-verified upstream tag tarball recorded in `docker/hermes/source.lock`
 *    (upstream no longer publishes to PyPI after 0.19.0).
 * 2. All chunk files are strictly below GitHub API patch omission thresholds (<250 lines, <20KB each).
 * 3. All transitive dependencies are strictly pinned (`==`) and covered by sha256 distribution hashes.
 * 4. Multi-architecture wheel hashes (amd64 + arm64) are present in the closure.
 * 5. Deterministic offline drift and integrity verification via scripts/compile-hermes-requirements.py --check without uv or network.
 * 6. The `hermes` CLI is symlinked to `/usr/local/bin/hermes` (on system PATH) matching the adapter's HERMES_CLI.
 * 7. `/opt/hermes` is root-owned and read-only to the runtime `node` user (no `chown node:node /opt/hermes`),
 *    preventing code/toolchain mutation across runs by the `--yolo` agent process.
 * 8. `HERMES_DISABLE_LAZY_INSTALLS=1` is set in the runtime environment and forced at spawn time,
 *    ensuring the agent fails closed on missing optional plugins and never executes runtime `pip install`.
 * 9. Deterministic build smoke checks verify `--help`, `--version`, and public `import mcp, mem0, psycopg, psycopg2` without private Hermes symbols.
 * 10. Live integration tests are gated by PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true with isolated tag builds.
 */

export const LIVE_DOCKER_HERMES_CHECK_COMMANDS = [
  "gosu node hermes --help >/dev/null",
  "gosu node hermes --version >/dev/null",
  "gosu node test -f /opt/hermes/.hermes-production-closure",
  "gosu node test -r /opt/hermes/.hermes-production-closure",
  `gosu node /opt/hermes/bin/python3 -c 'import mcp, ${HERMES_MEMORY_REQUIRED_MODULES.join(", ")}'`,
  "if gosu node touch /opt/hermes/.hermes-production-closure 2>/dev/null; then echo 'Security failure: /opt/hermes/.hermes-production-closure was modified by node'; exit 1; fi",
  "if gosu node touch /opt/hermes/bin/hermes 2>/dev/null; then echo 'Security failure: /opt/hermes/bin/hermes binary was modified by node'; exit 1; fi",
  "if gosu node touch /opt/hermes/bin/mutation_probe 2>/dev/null; then echo 'Security failure: /opt/hermes/bin is writable by node'; exit 1; fi",
  "test ! -e /opt/hermes/bin/mutation_probe",
  "if gosu node touch /opt/hermes/lib/python3.13/site-packages/mutation_probe.py 2>/dev/null; then echo 'Security failure: site-packages is writable by node'; exit 1; fi",
  "test ! -e /opt/hermes/lib/python3.13/site-packages/mutation_probe.py",
  "mkdir -p /tmp/hermes-mcp-test && chown -R node:node /tmp/hermes-mcp-test && printf 'mcp_servers:\\n  offline-server:\\n    url: http://127.0.0.1:9999/mcp\\n    headers:\\n      Authorization: Bearer test\\n    enabled: true\\n    skip_preflight: true\\n    tools:\\n      include:\\n        - test_tool\\n      resources: false\\n      prompts: false\\n' > /tmp/hermes-mcp-test/config.yaml",
  "HERMES_HOME=/tmp/hermes-mcp-test gosu node hermes mcp list | grep -q 'offline-server'",
  "HERMES_HOME=/tmp/hermes-mcp-test gosu node hermes config get --json mcp_servers | grep -q 'offline-server'",
  "mkdir -p /tmp/hermes-mem0-test && chown -R node:node /tmp/hermes-mem0-test && printf '{\\n  \"mode\": \"oss\",\\n  \"oss\": {\\n    \"llm\": {\\n      \"provider\": \"openai\",\\n      \"config\": { \"model\": \"gpt-5.4\" }\\n    },\\n    \"embedder\": {\\n      \"provider\": \"openai\",\\n      \"config\": { \"model\": \"text-embedding-3-small\" }\\n    },\\n    \"vector_store\": {\\n      \"provider\": \"pgvector\",\\n      \"config\": {\\n        \"host\": \"localhost\",\\n        \"port\": 5432,\\n        \"user\": \"test\",\\n        \"password\": \"test\",\\n        \"dbname\": \"test\",\\n        \"sslmode\": \"require\",\\n        \"collection_name\": \"memories\"\\n      }\\n    }\\n  },\\n  \"user_id\": \"company\",\\n  \"agent_id\": \"agent-1\"\\n}\\n' > /tmp/hermes-mem0-test/mem0.json && printf 'memory:\\n  provider: mem0\\n' > /tmp/hermes-mem0-test/config.yaml",
  "HERMES_HOME=/tmp/hermes-mem0-test gosu node hermes config get memory.provider | grep -q 'mem0'",
  "HERMES_HOME=/tmp/hermes-mem0-test gosu node /opt/hermes/bin/python3 -c \"from plugins.memory.mem0 import Mem0MemoryProvider; p = Mem0MemoryProvider(); assert p.is_available()\"",
  "/opt/hermes/bin/python3 -c \"import site, os; paths = site.getsitepackages(); files = sorted(f'{os.path.join(d, f)}:{os.stat(os.path.join(d, f)).st_size}' for d in paths if os.path.exists(d) for f in os.listdir(d)); print('\\n'.join(files))\" > /tmp/manifest_before.txt",
  "if HERMES_DISABLE_LAZY_INSTALLS=1 gosu node hermes memory setup honcho </dev/null 2>&1 | grep -E -q 'Failed to install|Install failed|Permission denied|Could not install|Cannot install|runtime installs are disabled'; then :; else echo 'Security failure: hermes memory setup honcho did not deny installation'; exit 1; fi",
  "/opt/hermes/bin/python3 -c \"import site, os; paths = site.getsitepackages(); files = sorted(f'{os.path.join(d, f)}:{os.stat(os.path.join(d, f)).st_size}' for d in paths if os.path.exists(d) for f in os.listdir(d)); print('\\n'.join(files))\" > /tmp/manifest_after.txt",
  "cmp /tmp/manifest_before.txt /tmp/manifest_after.txt",
  "/opt/hermes/bin/python3 -c \"import importlib.util; assert importlib.util.find_spec('honcho') is None, 'Security failure: honcho spec found'\"",
  "if /opt/hermes/bin/python3 -c 'import honcho' 2>/dev/null; then echo 'Security failure: honcho was imported'; exit 1; fi",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfilePath = path.join(repoRoot, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

const hermesDir = path.join(repoRoot, "docker", "hermes");
const requirementsInPath = path.join(hermesDir, "requirements.in");
const requirementsTxtPath = path.join(hermesDir, "requirements.txt");

function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\b`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasHermesCli = (() => {
  try {
    execSync("hermes --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const hasHermesPython = existsSync("/opt/hermes/bin/python3");

export function validateMutationDenialCommands(commands: string[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const scriptText = commands.join("\n");

  if (scriptText.includes("|| true")) {
    errors.push("Forbidden permissive fallback '|| true' detected in mutation denial script");
  }
  if (scriptText.includes("&& exit 1")) {
    errors.push("Invalid '&& exit 1' operator pattern detected");
  }

  const hasSentinelTouchCheck =
    /if gosu node touch \/opt\/hermes\/\.hermes-production-closure 2>\/dev\/null; then echo [^;]+; exit 1; fi/.test(scriptText);
  if (!hasSentinelTouchCheck) {
    errors.push("Missing required fail-closed touch check for /opt/hermes/.hermes-production-closure");
  }

  const hasBinaryTouchCheck =
    /if gosu node touch \/opt\/hermes\/bin\/hermes 2>\/dev\/null; then echo [^;]+; exit 1; fi/.test(scriptText);
  if (!hasBinaryTouchCheck) {
    errors.push("Missing required fail-closed touch check for /opt/hermes/bin/hermes");
  }

  const hasProbeTouchCheck =
    /if gosu node touch \/opt\/hermes\/bin\/mutation_probe 2>\/dev\/null; then echo [^;]+; exit 1; fi/.test(scriptText);
  if (!hasProbeTouchCheck) {
    errors.push("Missing required fail-closed touch check for /opt/hermes/bin/mutation_probe");
  }

  const hasNegativeProbeExistence = /test ! -e \/opt\/hermes\/bin\/mutation_probe/.test(scriptText);
  if (!hasNegativeProbeExistence) {
    errors.push("Missing required negative existence verification 'test ! -e /opt/hermes/bin/mutation_probe'");
  }

  const hasSitePackagesTouchCheck =
    /if gosu node touch \/opt\/hermes\/lib\/python3\.13\/site-packages\/mutation_probe\.py 2>\/dev\/null; then echo [^;]+; exit 1; fi/.test(scriptText);
  if (!hasSitePackagesTouchCheck) {
    errors.push("Missing required fail-closed touch check for /opt/hermes/lib/python3.13/site-packages/mutation_probe.py");
  }

  const hasNegativeSitePackagesProbeExistence =
    /test ! -e \/opt\/hermes\/lib\/python3\.13\/site-packages\/mutation_probe\.py/.test(scriptText);
  if (!hasNegativeSitePackagesProbeExistence) {
    errors.push("Missing required negative existence verification 'test ! -e /opt/hermes/lib/python3.13/site-packages/mutation_probe.py'");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

describe("Dockerfile Hermes CLI installation & packaging integrity", () => {
  const production = stageBody(dockerfile, "production");

  function createHermesFixture(): { tempDir: string; cleanup: () => void } {
    const tempDir = mkdtempSync(path.join(tmpdir(), "paperclip-hermes-fixture-"));
    const srcFiles = readdirSync(hermesDir);
    for (const file of srcFiles) {
      const srcPath = path.join(hermesDir, file);
      if (statSync(srcPath).isFile()) {
        writeFileSync(path.join(tempDir, file), readFileSync(srcPath));
      }
    }
    return {
      tempDir,
      cleanup: () => {
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }

  afterAll(() => {
    const gitStatus = execSync("git status --porcelain docker/hermes", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(gitStatus, "docker/hermes tracked files must remain clean and untouched").toBe("");
  });

  it("pins hermes-agent to an allow-listed upstream tag tarball in requirements.in and does not declare dead/diverging Docker ARG", () => {
    // ARG HERMES_AGENT_VERSION was removed to prevent divergence from hash-locked requirements
    expect(production).not.toMatch(/^ARG HERMES_AGENT_VERSION=/m);

    // Exact pin is defined in requirements.in
    const inContent = readFileSync(requirementsInPath, "utf8");
    expect(inContent).toMatch(
      /^hermes-agent\[mcp,anthropic\] @ https:\/\/github\.com\/NousResearch\/hermes-agent\/archive\/refs\/tags\/v[0-9.]+\.tar\.gz$/m,
    );
    const lock = readFileSync(path.join(hermesDir, "source.lock"), "utf8");
    expect(lock).toMatch(/^version=0\.21\.3$/m);
    expect(lock).toMatch(/^sha256=[a-f0-9]{64}$/m);
    expect(inContent).toContain(lock.match(/^url=(.+)$/m)![1]);
  });

  it("provides committed requirements.in with the hermes source pin, its exact build tools and mem0 runtime dependencies", () => {
    expect(existsSync(requirementsInPath), "docker/hermes/requirements.in must exist").toBe(true);
    const content = readFileSync(requirementsInPath, "utf8");
    expect(content).toMatch(/^hermes-agent\[mcp,anthropic\] @ https:\/\/github\.com\/NousResearch\/hermes-agent\/archive\/refs\/tags\/v[0-9.]+\.tar\.gz$/m);
    expect(content).toMatch(/^setuptools==83\.0\.0$/m);
    expect(content).toMatch(/^wheel==[0-9.]+$/m);
    expect(content).toMatch(/^mem0ai==2\.0\.10$/m);
    expect(content).toMatch(/^psycopg2-binary==2\.9\.10$/m);
    expect(content).toMatch(/^psycopg\[binary,pool\]==3\.2\.9$/m);
  });

  it("installs hermes-agent from the sha256-verified source.lock tarball into a root-owned tree without build isolation", () => {
    expect(production).toMatch(/sha256sum -c -/);
    expect(production).toContain("source.lock");
    expect(production).toMatch(/pip install[^\n]*--no-deps --no-build-isolation --no-index -e \/opt\/hermes-src/);
    expect(production).toMatch(/version = \\"\$HERMES_SRC_VERSION\\"/);
    expect(production).toMatch(/pip check/);
    // The hashed PyPI closure install is unchanged and still precedes the source install.
    const closureIdx = production.indexOf("--require-hashes --no-deps -r /tmp/hermes/requirements.txt");
    const sourceIdx = production.indexOf("/opt/hermes-src");
    expect(closureIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeGreaterThan(closureIdx);
  });

  it("rejects a tampered source.lock, a non-allow-listed source URL and a missing build tool offline", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const run = (dir: string) =>
      spawnSync("python3", [compileScript, "--hermes-dir", dir, "--check"], { cwd: repoRoot, encoding: "utf8" });

    const tampered = createHermesFixture();
    try {
      const lockPath = path.join(tampered.tempDir, "source.lock");
      writeFileSync(lockPath, readFileSync(lockPath, "utf8").replace(/sha256=[a-f0-9]{64}/, `sha256=${"0".repeat(64)}`));
      const result = run(tampered.tempDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/digest mismatch|source\.lock/);
    } finally {
      tampered.cleanup();
    }

    const foreignUrl = createHermesFixture();
    try {
      const inPath = path.join(foreignUrl.tempDir, "requirements.in");
      writeFileSync(inPath, readFileSync(inPath, "utf8").replace("github.com/NousResearch/", "github.com/someone-else/"));
      const result = run(foreignUrl.tempDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/allowed NousResearch tag archive|exact '==' pin/);
    } finally {
      foreignUrl.cleanup();
    }

    const noBuildTool = createHermesFixture();
    try {
      const inPath = path.join(noBuildTool.tempDir, "requirements.in");
      writeFileSync(inPath, readFileSync(inPath, "utf8").replace(/^wheel==.*\n/m, ""));
      const result = run(noBuildTool.tempDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/build tool 'wheel'/);
    } finally {
      noBuildTool.cleanup();
    }
  });

  it("provides top-level requirements.txt with only -r chunk includes and no raw package blocks", () => {
    expect(existsSync(requirementsTxtPath), "docker/hermes/requirements.txt must exist").toBe(true);
    const content = readFileSync(requirementsTxtPath, "utf8");

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(lines.length).toBeGreaterThan(0);
    // Every non-comment line must be a `-r requirements-*.txt` include
    for (const line of lines) {
      expect(line).toMatch(/^-r requirements-[0-9]{2}\.txt$/);
      const chunkName = line.replace(/^-r\s+/, "");
      expect(existsSync(path.join(hermesDir, chunkName)), `Chunk ${chunkName} must exist`).toBe(true);
    }

    // Top-level requirements.txt must not contain package versions or hashes directly
    expect(content).not.toMatch(/==/);
    expect(content).not.toMatch(/--hash=/);
  });

  it("splits hash-locked dependency closure into small reviewable chunk files (<250 lines, <20KB each)", () => {
    const chunkFiles = readdirSync(hermesDir)
      .filter((f) => f.startsWith("requirements-") && f.endsWith(".txt"))
      .sort();

    expect(chunkFiles.length).toBeGreaterThan(1);

    let totalPackages = 0;
    let totalHashes = 0;
    const combinedContent: string[] = [];

    for (const chunkFile of chunkFiles) {
      const fullPath = path.join(hermesDir, chunkFile);
      const content = readFileSync(fullPath, "utf8");
      combinedContent.push(content);

      const lines = content.split("\n");
      const stat = statSync(fullPath);

      // Verify strict reviewability thresholds (<250 lines and <20KB per file)
      expect(
        lines.length,
        `${chunkFile} has ${lines.length} lines, which must be < 250 for PR reviewability`,
      ).toBeLessThan(250);
      expect(
        stat.size,
        `${chunkFile} has ${stat.size} bytes, which must be < 20KB (20480 bytes)`,
      ).toBeLessThan(20480);

      const packageLines = lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("--hash="));

      for (const pkgLine of packageLines) {
        expect(pkgLine).toMatch(/^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.-]+/);
        expect(pkgLine).not.toMatch(/[<>~]=/);
        totalPackages++;
      }

      const hashLines = lines
        .map((l) => l.trim())
        .filter((l) => l.startsWith("--hash=sha256:"));
      totalHashes += hashLines.length;

      // No credentials, passwords, or tokens in requirements (avoids false-positive package names like secretstorage/tokenizers)
      expect(content).not.toMatch(
        /(?::\/\/[^/\s@:]+:[^/\s@]+@|\bghp_[a-zA-Z0-9]{20,}|\bgithub_pat_[a-zA-Z0-9_]{20,}|\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}|\bBearer\s+[a-zA-Z0-9_\-\.]{20,}|\beyJ[a-zA-Z0-9_-]{10,}|\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b|\b(?:aws[_-]?)?(?:secret[_-]?(?:access[_-]?)?key|session[_-]?token)\s*[:=]|\bxox[baprs]-[0-9a-zA-Z-]{10,}|\bAIza[0-9A-Za-z_-]{20,})/i,
      );
    }

    const allContent = combinedContent.join("\n");
    expect(totalPackages).toBeGreaterThan(30);
    expect(totalHashes).toBeGreaterThan(100);

    // Top-level packages must be pinned in the chunks
    // hermes-agent itself is installed from source.lock, never from the PyPI closure
    expect(allContent).not.toMatch(/^hermes-agent/m);
    expect(allContent).toMatch(/^setuptools==[0-9.]+ \\/m);
    expect(allContent).toMatch(/^wheel==[0-9.]+ \\/m);
    expect(allContent).toMatch(/^mcp==[0-9.]+/m);
    expect(allContent).toMatch(/^anthropic==[0-9.]+/m);

    // Multi-architecture wheel hashes (amd64 / arm64) present scoped to cffi block only
    const cffiBlock = allContent
      .split(/(?=\n[a-zA-Z0-9_.-]+==)/)
      .find((block) => block.trim().startsWith("cffi=="));
    expect(cffiBlock, "cffi package block must be present in chunks").toBeDefined();
    expect(cffiBlock!).toContain("sha256:f16c709686a78c727bbbf059f92b0bf41c6fc60deec706d2dc19f529175a6125"); // cffi cp313 manylinux aarch64
    expect(cffiBlock!).toContain("sha256:a931079504ecc49efed7744c476a5c343a92fabf66dec2db95edb1b2fdc770e2"); // cffi cp313 manylinux x86_64
  });

  it("verifies hash-lock closure verification runs fully offline without uv or network on system PATH", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    expect(existsSync(compileScript), "scripts/compile-hermes-requirements.py must exist").toBe(true);

    const pythonExec = execSync("which python3", { encoding: "utf8" }).trim();
    expect(path.isAbsolute(pythonExec), "python3 executable must be an absolute path").toBe(true);

    const sandboxedPath = "/usr/bin:/bin";

    // Verify uv and uvx are inaccessible under this sandboxed PATH
    expect(() => {
      execFileSync("sh", ["-c", "command -v uv"], {
        env: { PATH: sandboxedPath },
        stdio: "pipe",
      });
    }).toThrow();
    expect(() => {
      execFileSync("sh", ["-c", "command -v uvx"], {
        env: { PATH: sandboxedPath },
        stdio: "pipe",
      });
    }).toThrow();

    const result = execFileSync(pythonExec, [compileScript, "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: sandboxedPath,
        HTTP_PROXY: "http://127.0.0.1:0",
        HTTPS_PROXY: "http://127.0.0.1:0",
        ALL_PROXY: "http://127.0.0.1:0",
      },
    });
    expect(result).toContain("OK: Hermes requirements hash lock closure and chunks match exactly");
    expect(result).toContain("fully offline");
  });

  it("verifies requirements.in with extras like [dev] does not fail closure verification for lacking standalone extra distribution", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const fixture = createHermesFixture();
    try {
      // Append a conventional extra [dev]
      const reqInPath = path.join(fixture.tempDir, "requirements.in");
      writeFileSync(reqInPath, readFileSync(reqInPath, "utf8").replace("[mcp,anthropic]", "[mcp,anthropic,dev]"), "utf8");
      const result = execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(result).toContain("OK: Hermes requirements hash lock closure and chunks match exactly");
    } finally {
      fixture.cleanup();
    }
  });

  it("enforces continuation slashes on package headers and non-final hash lines and rejects trailing slashes on final hash lines", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const fixture = createHermesFixture();
    const chunkPath = path.join(fixture.tempDir, "requirements-01.txt");
    const origChunk = readFileSync(chunkPath, "utf8");

    try {
      // 1. Removing continuation slash from package header must fail --check
      const missingHeaderSlash = origChunk.replace("annotated-doc==0.0.5 \\", "annotated-doc==0.0.5");
      writeFileSync(chunkPath, missingHeaderSlash, "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/must end with continuation backslash/);

      // 2. Removing continuation slash from non-final hash line must fail --check even if normalized digest unchanged
      const lines = origChunk.split("\n");
      const firstHashIdx = lines.findIndex((l) => l.includes("--hash=") && l.endsWith("\\"));
      expect(firstHashIdx).toBeGreaterThan(0);
      lines[firstHashIdx] = lines[firstHashIdx].slice(0, -1).trimEnd();
      writeFileSync(chunkPath, lines.join("\n"), "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/must end with continuation backslash/);

      // 3. Adding slash to final hash line must fail --check
      const linesWithFinalSlash = origChunk.split("\n");
      const finalHashIdx = linesWithFinalSlash.findIndex((l) => l.includes("--hash=") && !l.endsWith("\\"));
      expect(finalHashIdx).toBeGreaterThan(0);
      linesWithFinalSlash[finalHashIdx] = linesWithFinalSlash[finalHashIdx] + " \\";
      writeFileSync(chunkPath, linesWithFinalSlash.join("\n"), "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/must not end with backslash/);
    } finally {
      fixture.cleanup();
    }
  });

  it("scans and strictly rejects credentials in requirements files including comments while allowing benign names", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const fixture = createHermesFixture();
    try {
      const chunkPath = path.join(fixture.tempDir, "requirements-01.txt");
      const originalChunk = readFileSync(chunkPath, "utf8");

      // 1. Benign comments and package names (secretstorage, tokenizers, google-auth, slack-sdk, aws-requests-auth, public URLs) inside package blocks must succeed
      const benignChunk = originalChunk.replace(
        "annotated-doc==0.0.5 \\\n",
        "annotated-doc==0.0.5 \\\n    # via tokenizers\n    # dependency for secretstorage\n    # AWS IAM role authentication helpers\n    # Google Cloud authentication provider\n    # Slack bot webhook client\n    # Bearer token auth workflow documentation\n    # https://pypi.org/simple\n",
      );
      writeFileSync(chunkPath, benignChunk, "utf8");
      const okResult = execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(okResult).toContain("OK:");

      // Helper to test malicious provenance comments
      const testMaliciousComment = (maliciousComment: string) => {
        const injectedChunk = originalChunk.replace(
          "annotated-doc==0.0.5 \\\n",
          `annotated-doc==0.0.5 \\\n    ${maliciousComment}\n`,
        );
        writeFileSync(chunkPath, injectedChunk, "utf8");
        expect(() => {
          execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: "pipe",
          });
        }, `Must reject malicious provenance comment: ${maliciousComment}`).toThrow(/Credential security violation/);
      };

      // 2. Malicious provenance comment: URL userinfo with password
      testMaliciousComment("# provenance: https://ci-bot:supersecretpassword123@pypi.internal.corp/");

      // 3. Malicious provenance comment: GitHub personal access token (ghp_)
      testMaliciousComment("# provenance: downloaded via token ghp_1234567890abcdef1234567890abcdef");

      // 4. Malicious provenance comment: Fine-grained GitHub token (github_pat_)
      testMaliciousComment("# provenance: token github_pat_1234567890abcdef1234567890abcdef1234567890");

      // 5. Malicious provenance comment: GitHub OAuth token (gho_)
      testMaliciousComment("# provenance: token gho_1234567890abcdef1234567890abcdef");

      // 6. Malicious provenance comment: API secret key (sk-)
      testMaliciousComment("# provenance: api_key = sk-proj-1234567890abcdef1234567890");

      // 7. Malicious provenance comment: Bearer JWT token
      testMaliciousComment("# provenance: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak");

      // 8. Malicious provenance comment: AWS access key ID (AKIA / ASIA)
      testMaliciousComment("# provenance: AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE");
      testMaliciousComment("# provenance: AWS_ACCESS_KEY_ID = ASIAIOSFODNN7EXAMPLE");

      // 9. Malicious provenance comment: AWS secret access key form
      testMaliciousComment("# provenance: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
      testMaliciousComment("# provenance: AWS_SECRET_ACCESS_KEY: \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"");

      // 10. Malicious provenance comment: Slack token (xoxb- / xoxp-)
      testMaliciousComment("# provenance: slack_bot_token = xoxb-123456789012-abcdef123456");
      testMaliciousComment("# provenance: slack_user_token = xoxp-123456789012-abcdef123456");

      // 11. Malicious provenance comment: Google API key (AIza...)
      testMaliciousComment("# provenance: google_api_key = AIzaSyA1234567890abcdefghijklmnopqrst");
    } finally {
      fixture.cleanup();
    }
  });

  it("redacts diagnostics consistently for all high-signal credential types while preserving benign diagnostic messages", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const pythonExec = execSync("which python3", { encoding: "utf8" }).trim();

    const runRedact = (input: string): string => {
      return execFileSync(
        pythonExec,
        [
          "-B",
          "-c",
          `import importlib.util, sys
spec = importlib.util.spec_from_file_location("compile_hermes", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sys.stdout.write(mod.redact_diagnostics(sys.stdin.read()))`,
          compileScript,
        ],
        {
          input,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      );
    };

    // 1. Benign diagnostic output must be preserved untouched
    const benignDiag =
      "uv pip compile error: package secretstorage failed to resolve with tokenizers and aws-requests-auth, google-auth, slack-sdk at https://pypi.org/simple";
    expect(runRedact(benignDiag)).toBe(benignDiag);

    // 2. URL userinfo credentials redacted
    expect(runRedact("Failed fetching https://bot-user:super-secret@pypi.internal/simple")).toBe(
      "Failed fetching https://[redacted]@pypi.internal/simple",
    );

    // 3. GitHub personal access tokens redacted
    expect(runRedact("Error using token ghp_1234567890abcdef1234567890abcdef")).toContain("ghp_[redacted]");
    expect(runRedact("Error using token github_pat_1234567890abcdef1234567890abcdef1234567890")).toContain(
      "github_pat_[redacted]",
    );
    expect(runRedact("Error using OAuth gho_1234567890abcdef1234567890abcdef")).toContain(
      "[redacted_github_token]",
    );

    // 4. API secret keys redacted
    expect(runRedact("OpenAI sk-proj-1234567890abcdef1234567890 failed")).toContain("sk-[redacted]");

    // 5. Bearer tokens and JWTs redacted
    expect(
      runRedact(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak",
      ),
    ).toContain("Bearer [redacted]");

    // 6. AWS access keys and secret forms redacted
    expect(runRedact("AWS key AKIAIOSFODNN7EXAMPLE rejected")).toContain("[redacted_aws_key]");
    expect(runRedact("AWS session ASIAIOSFODNN7EXAMPLE expired")).toContain("[redacted_aws_key]");
    expect(runRedact("Error: aws_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' invalid")).toContain(
      "aws_secret_access_key = '[redacted]'",
    );
    expect(
      runRedact("Error: AWS_SECRET_ACCESS_KEY: \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\" invalid"),
    ).toContain("AWS_SECRET_ACCESS_KEY: \"[redacted]\"");

    // 7. Slack tokens redacted
    expect(runRedact("Slack bot xoxb-123456789012-abcdef123456 failed")).toContain("[redacted_slack_token]");
    expect(runRedact("Slack user xoxp-123456789012-abcdef123456 failed")).toContain("[redacted_slack_token]");

    // 8. Google API keys redacted
    expect(runRedact("Google key AIzaSyA1234567890abcdefghijklmnopqrst expired")).toContain(
      "[redacted_google_key]",
    );
  });

  it("enforces mandatory requirements.digest: rejects missing, malformed, duplicate, or mismatched digest", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const fixture = createHermesFixture();
    try {
      const digestPath = path.join(fixture.tempDir, "requirements.digest");
      const validDigest = readFileSync(digestPath, "utf8").trim();

      // 1. Missing digest file
      unlinkSync(digestPath);
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/requirements\.digest is mandatory/);

      // 2. Malformed digest (not 64 hex chars)
      writeFileSync(digestPath, "malformed-digest-not-64-hex\n", "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/malformed digest/);

      // 3. Duplicate digest lines
      writeFileSync(digestPath, `${validDigest}\n${validDigest}\n`, "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/multiple or duplicate lines/);

      // 4. Mismatch digest
      writeFileSync(digestPath, "0000000000000000000000000000000000000000000000000000000000000000\n", "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow(/Normalized closure digest mismatch/);
    } finally {
      fixture.cleanup();
    }
  });

  function parseNormalizedClosure(text: string) {
    const pkgs = new Map<string, { version: string; hashes: string[] }>();
    let currentPkg: string | null = null;
    let currentVer: string | null = null;
    let currentHashes: string[] = [];

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([a-zA-Z0-9_.-]+)==([a-zA-Z0-9_.-]+)/);
      if (match) {
        if (currentPkg) {
          pkgs.set(currentPkg, { version: currentVer!, hashes: currentHashes.sort() });
        }
        currentPkg = match[1].toLowerCase().replace(/[-_.]+/g, "-");
        currentVer = match[2];
        currentHashes = [];
      } else if (line.startsWith("--hash=")) {
        currentHashes.push(line.split(/\s+/)[0].replace(/\\$/, ""));
      }
    }
    if (currentPkg) {
      pkgs.set(currentPkg, { version: currentVer!, hashes: currentHashes.sort() });
    }
    return pkgs;
  }

  it("proves split closure matches requirements.digest via python --print-digest and is equivalent to pre-split monolith (commit 93bea5d68)", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const digestFile = path.join(hermesDir, "requirements.digest");
    expect(existsSync(digestFile), "docker/hermes/requirements.digest must exist").toBe(true);
    const expectedDigest = readFileSync(digestFile, "utf8").trim();

    // Invoke python script --print-digest offline as the single source of truth for canonical closure digest
    const pythonExec = execSync("which python3", { encoding: "utf8" }).trim();
    const printedDigest = execFileSync(pythonExec, [compileScript, "--print-digest"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        HTTP_PROXY: "http://127.0.0.1:0",
        HTTPS_PROXY: "http://127.0.0.1:0",
        ALL_PROXY: "http://127.0.0.1:0",
      },
    }).trim();
    expect(printedDigest).toBe(expectedDigest);

    // Dynamically discover all chunk files matching strict filename pattern
    const chunkFileNames = readdirSync(hermesDir)
      .filter((file) => /^requirements-\d{2}\.txt$/.test(file))
      .sort();
    expect(chunkFileNames.length).toBeGreaterThan(0);

    const chunkFiles = chunkFileNames.map((file) =>
      readFileSync(path.join(hermesDir, file), "utf8"),
    );
    const allChunksContent = chunkFiles.join("\n");
    const splitPkgs = parseNormalizedClosure(allChunksContent);
    expect(splitPkgs.size).toBeGreaterThan(0);

    // Catch ONLY git show command failure into nullable preimage
    let monolithPreimage: string | null = null;
    try {
      monolithPreimage = execSync("git show 93bea5d68:docker/hermes/requirements.txt", {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      // If git history is shallow, preimage remains null and digest check above is authoritative
    }

    if (monolithPreimage !== null) {
      const monolithPkgs = parseNormalizedClosure(monolithPreimage);
      // The closure has since been intentionally upgraded (Hermes 0.21.3), so versions may differ from the
      // pre-split monolith. Any package still at the same version must keep identical hashes, and the
      // mem0/psycopg runtime closure must be unchanged.
      for (const [pkg, monoEntry] of monolithPkgs.entries()) {
        const splitEntry = splitPkgs.get(pkg);
        if (splitEntry && splitEntry.version === monoEntry.version) {
          expect(splitEntry.hashes, `Hashes for ${pkg}==${monoEntry.version}`).toEqual(monoEntry.hashes);
        }
      }
      for (const pkg of ["mem0ai", "psycopg", "psycopg-binary", "psycopg2-binary"]) {
        const monoEntry = monolithPkgs.get(pkg);
        const splitEntry = splitPkgs.get(pkg);
        expect(splitEntry, `Package ${pkg} should be present in closure`).toBeDefined();
        if (monoEntry) {
          expect(splitEntry!.version).toBe(monoEntry.version);
          expect(splitEntry!.hashes).toEqual(monoEntry.hashes);
        }
      }
      expect(splitPkgs.has("mem0ai")).toBe(true);
      expect(splitPkgs.get("mem0ai")?.version).toBe("2.0.10");
      expect(splitPkgs.has("psycopg2-binary")).toBe(true);
      expect(splitPkgs.has("psycopg")).toBe(true);
    }
  });

  it("fails equivalence assertion when deliberate package, version, or hash mismatch is introduced against monolith", () => {
    let monolithPreimage: string | null = null;
    try {
      monolithPreimage = execSync("git show 93bea5d68:docker/hermes/requirements.txt", {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      // Fallback synthetic monolith for shallow clone
    }

    const basePreimage =
      monolithPreimage ??
      "annotated-doc==0.0.5 \\\n    --hash=sha256:117bac03a25ede5df5440e855b32d556049ca169ead221505badf432fed4b101\n";
    const baselinePkgs = parseNormalizedClosure(basePreimage);

    // 1. Version mismatch assertion failure
    const versionMutated = basePreimage.replace(/==[0-9.]+/m, "==999.999.999");
    const versionPkgs = parseNormalizedClosure(versionMutated);
    expect(() => {
      for (const [pkg, entry] of baselinePkgs.entries()) {
        const other = versionPkgs.get(pkg);
        expect(other).toBeDefined();
        expect(entry.version).toBe(other!.version);
      }
    }).toThrow();

    // 2. Hash mismatch assertion failure
    const hashMutated = basePreimage.replace(
      /sha256:[a-f0-9]{64}/m,
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    const hashPkgs = parseNormalizedClosure(hashMutated);
    expect(() => {
      for (const [pkg, entry] of baselinePkgs.entries()) {
        const other = hashPkgs.get(pkg);
        expect(other).toBeDefined();
        expect(entry.hashes).toEqual(other!.hashes);
      }
    }).toThrow();

    // 3. Package presence / size mismatch assertion failure
    const missingPkgs = new Map(baselinePkgs);
    const firstKey = missingPkgs.keys().next().value;
    if (firstKey) missingPkgs.delete(firstKey);
    expect(() => {
      expect(missingPkgs.size).toBe(baselinePkgs.size);
    }).toThrow();
  });

  it("requires explicit opt-in for --refresh and documents pinned uv version in help", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");

    const helpOutput = execFileSync("python3", [compileScript, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(helpOutput).toContain("--check");
    expect(helpOutput).toContain("--refresh");
    expect(helpOutput).toMatch(/pinned uv \(0\.11\.28\)/);

    // Running with no flags must fail and require explicit --check or --refresh
    expect(() => {
      execFileSync("python3", [compileScript], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      });
    }).toThrow();
  });

  it("fails --check if a chunk file is unexpected or has drifted content", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    const fixture = createHermesFixture();
    try {
      const fakeChunk = path.join(fixture.tempDir, "requirements-99.txt");
      // Adding an unexpected unreferenced chunk must cause --check to fail
      writeFileSync(fakeChunk, "# Unexpected chunk\n", "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--hermes-dir", fixture.tempDir, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it("installs hermes from requirements directory enforcing hashes and --no-deps", () => {
    expect(production).toContain("COPY docker/hermes/ /tmp/hermes/");
    expect(production).toMatch(/pip install --no-cache-dir --require-hashes --no-deps -r \/tmp\/hermes\/requirements\.txt/);
    expect(production).toContain("rm -rf /tmp/hermes");
  });

  it("installs python3-venv runtime dependency and isolates venv in /opt/hermes", () => {
    expect(production).toMatch(/apt-get install -y --no-install-recommends [^\n]*\bpython3-venv\b/);
    expect(production).toContain("/usr/bin/python3 -m venv /opt/hermes");
  });

  it("makes hermes available on PATH matching adapter HERMES_CLI", () => {
    expect(HERMES_CLI).toBe("hermes");
    expect(production).toContain(`/usr/local/bin/${HERMES_CLI}`);
    expect(production).toMatch(new RegExp(`ln -sf /opt/hermes/bin/${HERMES_CLI} /usr/local/bin/${HERMES_CLI}`));
  });

  it("preserves root-ownership of /opt/hermes and removes node chown (mutation denial)", () => {
    // /opt/hermes must NEVER be chowned to node:node
    expect(production).not.toMatch(/chown[^\n]*\/opt\/hermes/);
    // Only /paperclip should be chowned to node:node
    expect(production).toMatch(/chown -R node:node \/paperclip\b/);
    // Explicitly seals /opt/hermes permissions so only root can write
    expect(production).toMatch(/chmod -R u=rwX,go=rX \/opt\/hermes/);
  });

  it("sets HERMES_DISABLE_LAZY_INSTALLS=1 in production ENV", () => {
    expect(production).toMatch(/HERMES_DISABLE_LAZY_INSTALLS=1/);
  });

  it("runs non-root build smoke checks using public symbols without private Hermes internals", () => {
    expect(production).toMatch(/gosu node hermes --help >\/dev\/null/);
    expect(production).toMatch(/gosu node hermes --version >\/dev\/null/);
    expect(production).toContain(
      `gosu node /opt/hermes/bin/python3 -c "import mcp, ${HERMES_MEMORY_REQUIRED_MODULES.join(", ")}"`,
    );
    expect(production).not.toContain("_MCP_AVAILABLE");
    expect(production).not.toContain("lazy_deps");
    expect(production).not.toContain("_allow_lazy_installs");
  });

  it("proves mutation denial shell pattern fails if writable and passes when sealed", () => {
    const initialAdapterGitStatus = execSync("git status --porcelain packages/adapters/hermes", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-hermes-shell-mutation-"));
    try {
      const probeFile = path.join(tempDir, "probe");

      // 1. In a writable directory, the explicit shell check MUST FAIL (exit 1)
      const writableCheck = `if touch "${probeFile}" 2>/dev/null; then echo "Security failure: directory is writable"; exit 1; fi`;
      expect(() => {
        execFileSync("sh", ["-c", writableCheck], { stdio: "pipe" });
      }).toThrow();

      // Clean probe
      execFileSync("sh", ["-c", `rm -f "${probeFile}"`]);

      // 2. In a read-only directory, the explicit check succeeds and verifies target does not exist
      execFileSync("sh", ["-c", `chmod 555 "${tempDir}"`]);
      const sealedCheck = `if touch "${probeFile}" 2>/dev/null; then echo "Security failure: directory is writable"; exit 1; fi && test ! -e "${probeFile}"`;
      const sealedResult = execFileSync("sh", ["-c", sealedCheck], { stdio: "pipe" });
      expect(sealedResult).toBeDefined();
    } finally {
      try {
        execFileSync("sh", ["-c", `chmod 755 "${tempDir}"`]);
      } catch {
        // ignore chmod restoration failure if directory was removed
      }
      rmSync(tempDir, { recursive: true, force: true });
    }

    const adapterGitStatus = execSync("git status --porcelain packages/adapters/hermes", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    // Diff-based assertion: packages/adapters/hermes must not gain new modifications during test execution
    const initialAdapterLines = new Set(
      initialAdapterGitStatus.split("\n").map((l) => l.trim()).filter(Boolean),
    );
    const finalAdapterLines = adapterGitStatus
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const newModifications = finalAdapterLines.filter((line) => !initialAdapterLines.has(line));
    expect(
      newModifications,
      "packages/adapters/hermes git status must not gain new modifications during test execution",
    ).toEqual([]);

    const initialUntracked = new Set(Array.from(initialAdapterLines).filter((l) => l.startsWith("??")));
    const newUntracked = finalAdapterLines.filter((l) => l.startsWith("??") && !initialUntracked.has(l));
    expect(newUntracked, "no new untracked files created in packages/adapters/hermes").toEqual([]);

    if (process.env.CI) {
      expect(
        adapterGitStatus,
        "packages/adapters/hermes git status must remain clean in CI",
      ).toBe("");
    }

    const fullGitStatus = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(fullGitStatus, "no repo-local temp directories left in workspace").not.toMatch(
      /(\.test-tmp|paperclip-.*mutation)/,
    );
  });

  it("enforces fail-closed mutation denial contract via independent command validator", () => {
    // 1. Production command suite must satisfy all mutation denial constraints
    const liveValidation = validateMutationDenialCommands(LIVE_DOCKER_HERMES_CHECK_COMMANDS);
    expect(liveValidation.valid).toBe(true);
    expect(liveValidation.errors).toEqual([]);

    // 2. Permissive fallback '|| true' must be rejected
    const permissiveResult = validateMutationDenialCommands([
      "if gosu node touch /opt/hermes/bin/hermes 2>/dev/null; then exit 1; fi || true",
    ]);
    expect(permissiveResult.valid).toBe(false);
    expect(permissiveResult.errors.some((e) => e.includes("|| true"))).toBe(true);

    // 3. Invalid '&& exit 1' pattern must be rejected
    const andExitResult = validateMutationDenialCommands([
      "gosu node touch /opt/hermes/bin/mutation_probe && exit 1",
    ]);
    expect(andExitResult.valid).toBe(false);
    expect(andExitResult.errors.some((e) => e.includes("&& exit 1"))).toBe(true);

    // 4. Removing each required command individually must cause validation to fail with a specific diagnostic
    const requiredChecks: Array<{
      name: string;
      matcher: (cmd: string) => boolean;
      expectedError: string;
    }> = [
      {
        name: "sentinel mutation denial",
        matcher: (cmd: string) =>
          cmd.includes("touch /opt/hermes/.hermes-production-closure"),
        expectedError:
          "Missing required fail-closed touch check for /opt/hermes/.hermes-production-closure",
      },
      {
        name: "binary mutation denial",
        matcher: (cmd: string) => cmd.includes("touch /opt/hermes/bin/hermes"),
        expectedError: "Missing required fail-closed touch check for /opt/hermes/bin/hermes",
      },
      {
        name: "bin mutation denial probe",
        matcher: (cmd: string) => cmd.includes("touch /opt/hermes/bin/mutation_probe"),
        expectedError: "Missing required fail-closed touch check for /opt/hermes/bin/mutation_probe",
      },
      {
        name: "bin marker negative existence",
        matcher: (cmd: string) => cmd.includes("test ! -e /opt/hermes/bin/mutation_probe"),
        expectedError: "Missing required negative existence verification 'test ! -e /opt/hermes/bin/mutation_probe'",
      },
      {
        name: "site-packages mutation denial",
        matcher: (cmd: string) =>
          cmd.includes("touch /opt/hermes/lib/python3.13/site-packages/mutation_probe.py"),
        expectedError:
          "Missing required fail-closed touch check for /opt/hermes/lib/python3.13/site-packages/mutation_probe.py",
      },
      {
        name: "site-packages marker negative existence",
        matcher: (cmd: string) =>
          cmd.includes("test ! -e /opt/hermes/lib/python3.13/site-packages/mutation_probe.py"),
        expectedError:
          "Missing required negative existence verification 'test ! -e /opt/hermes/lib/python3.13/site-packages/mutation_probe.py'",
      },
    ];

    for (const req of requiredChecks) {
      expect(
        LIVE_DOCKER_HERMES_CHECK_COMMANDS.some(req.matcher),
        `Live suite must include command for ${req.name}`,
      ).toBe(true);

      const stripped = LIVE_DOCKER_HERMES_CHECK_COMMANDS.filter((cmd) => !req.matcher(cmd));
      const res = validateMutationDenialCommands(stripped);
      expect(res.valid, `Validation must fail when ${req.name} is removed`).toBe(false);
      expect(
        res.errors,
        `Validation errors must include '${req.expectedError}' when ${req.name} is removed`,
      ).toContain(req.expectedError);
    }
  });

  it.skipIf(!hasHermesCli)(
    "restores public-surface offline MCP config behavioral coverage using public Hermes CLI",
    () => {
      const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-hermes-mcp-"));
      try {
        const configYaml = [
          "mcp_servers:",
          "  offline-test-server:",
          "    url: http://127.0.0.1:9999/mcp",
          "    headers:",
          "      Authorization: Bearer test-token",
          "    enabled: true",
          "    skip_preflight: true",
          "    tools:",
          "      include:",
          "        - sample_tool",
          "      resources: false",
          "      prompts: false",
        ].join("\n");
        writeFileSync(path.join(tempHome, "config.yaml"), configYaml, "utf8");

        const mcpListOutput = execSync("hermes mcp list", {
          encoding: "utf8",
          env: {
            ...process.env,
            HERMES_HOME: tempHome,
            HTTP_PROXY: "http://127.0.0.1:0",
            HTTPS_PROXY: "http://127.0.0.1:0",
            ALL_PROXY: "http://127.0.0.1:0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        expect(mcpListOutput).toContain("offline-test-server");
        expect(mcpListOutput).toContain("1 selected");
        expect(mcpListOutput).toContain("enabled");

        const configGetOutput = execSync("hermes config get --json mcp_servers", {
          encoding: "utf8",
          env: {
            ...process.env,
            HERMES_HOME: tempHome,
            HTTP_PROXY: "http://127.0.0.1:0",
            HTTPS_PROXY: "http://127.0.0.1:0",
            ALL_PROXY: "http://127.0.0.1:0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const parsedConfig = JSON.parse(configGetOutput);
        expect(parsedConfig["offline-test-server"]).toBeDefined();
        expect(parsedConfig["offline-test-server"].tools.resources).toBe(false);
        expect(parsedConfig["offline-test-server"].tools.prompts).toBe(false);
        expect(parsedConfig["offline-test-server"].tools.include).toEqual(["sample_tool"]);
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasHermesPython || !hasHermesCli)(
    "verifies HERMES_DISABLE_LAZY_INSTALLS=1 prevents installation for an uninstalled optional feature in /opt/hermes venv",
    () => {
      const hermesPython = "/opt/hermes/bin/python3";
      const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-lazy-denial-"));
      try {
        const getManifest = () => {
          return execFileSync(
            hermesPython,
            [
              "-c",
              "import site, os; paths = site.getsitepackages(); files = sorted(f'{os.path.join(d, f)}:{os.stat(os.path.join(d, f)).st_size}' for d in paths if os.path.exists(d) for f in os.listdir(d)); print('\\n'.join(files))",
            ],
            { encoding: "utf8" },
          );
        };

        const manifestBefore = getManifest();

        let output = "";
        try {
          output = execSync("hermes memory setup honcho", {
            input: "",
            encoding: "utf8",
            env: {
              ...process.env,
              HERMES_HOME: tempHome,
              HERMES_DISABLE_LAZY_INSTALLS: "1",
              HTTP_PROXY: "http://127.0.0.1:0",
              HTTPS_PROXY: "http://127.0.0.1:0",
              ALL_PROXY: "http://127.0.0.1:0",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err: any) {
          output = err.stdout?.toString() || err.message || "";
        }

        // Assert clear failure/denial from public CLI
        expect(output).toMatch(
          /Failed to install|Install failed|Permission denied|Could not install|Cannot install|runtime installs are disabled/i,
        );

        // Compare manifest byte-for-byte
        const manifestAfter = getManifest();
        expect(manifestAfter).toBe(manifestBefore);

        // Assert honcho package/import remains absent in /opt/hermes venv without ambient python
        const specResult = execFileSync(
          hermesPython,
          ["-c", 'import importlib.util; print(importlib.util.find_spec("honcho"))'],
          { encoding: "utf8" },
        ).trim();
        expect(specResult).toBe("None");

        expect(() => {
          execFileSync(hermesPython, ["-c", "import honcho"], { stdio: "ignore" });
        }).toThrow();
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    },
  );

  it("enforces offline requirements check in GitHub Actions pr-trusted policy job", () => {
    const prTrustedWorkflowPath = path.join(repoRoot, ".github", "workflows", "pr-trusted.yml");
    expect(existsSync(prTrustedWorkflowPath), "pr-trusted.yml must exist").toBe(true);
    const workflowContent = readFileSync(prTrustedWorkflowPath, "utf8");
    expect(workflowContent).toMatch(/python3 scripts\/compile-hermes-requirements\.py --check/);
  });

  it("orders CLI installation before application source copy to preserve layer cache", () => {
    const toolsLayerIdx = production.search(/\/tmp\/hermes\/requirements\.txt/);
    const appCopyIdx = production.search(/COPY --chown=node:node --from=build \/app \/app/);
    expect(toolsLayerIdx, "Hermes tool installation must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(appCopyIdx, "app copy must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(toolsLayerIdx, "Hermes tool installation must precede application source copy").toBeLessThan(appCopyIdx);
  });

  it("maintains architecture compatibility without arch-exclusive barriers", () => {
    const hermesSection = production.slice(
      production.indexOf("COPY docker/hermes/ /tmp/hermes/"),
      production.indexOf("gosu node hermes --version"),
    );
    expect(hermesSection).not.toContain("dpkg --print-architecture");
    expect(hermesSection).not.toContain("amd64");
  });
});

const runLiveDockerTests = process.env.PAPERCLIP_RUN_DOCKER_HERMES_TESTS === "true";

describe.skipIf(!runLiveDockerTests)(
  "Docker live integration tests (PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true)",
  () => {
    const testImageTag = `paperclip-test-hermes-${randomUUID()}`;

    beforeAll(() => {
      if (!isDockerAvailable()) {
        throw new Error(
          "Docker daemon is not reachable or docker command failed, but PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true was set.",
        );
      }
      // Build isolated test base image containing python3, venv, and gosu without assuming preexisting paperclip-base
      execFileSync(
        "docker",
        ["build", "--target", "base", "-t", testImageTag, repoRoot],
        { stdio: "pipe", timeout: 120_000 },
      );
    }, 120_000);

    afterAll(() => {
      try {
        execFileSync("docker", ["rmi", "-f", testImageTag], { stdio: "ignore" });
      } catch {
        // Best-effort cleanup
      }
    });

    it("verifies live container runtime immutability and public MCP availability in isolated container", () => {
      const testContainerName = `paperclip-test-run-${randomUUID()}`;
      const checkScript = LIVE_DOCKER_HERMES_CHECK_COMMANDS.join(" && ");

      try {
        const output = execFileSync(
          "docker",
          [
            "run",
            "--name",
            testContainerName,
            "--rm",
            "-v",
            `${hermesDir}:/tmp/hermes:ro`,
            "-v",
            `${path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")}:/fixtures:ro`,
            testImageTag,
            "sh",
            "-c",
            `DEBIAN_FRONTEND=noninteractive apt-get update -qq && ` +
              `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null && ` +
              `/usr/bin/python3 -m venv /opt/hermes && ` +
              `/opt/hermes/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/hermes/requirements.txt >/dev/null && ` +
              // Mirrors the Dockerfile: hermes-agent comes from the sha256-verified tarball in source.lock.
              `HERMES_SRC_URL="$(sed -n 's/^url=//p' /tmp/hermes/source.lock)" && ` +
              `HERMES_SRC_SHA256="$(sed -n 's/^sha256=//p' /tmp/hermes/source.lock)" && ` +
              `HERMES_SRC_VERSION="$(sed -n 's/^version=//p' /tmp/hermes/source.lock)" && ` +
              `curl -fsSL --retry 3 -o /tmp/hermes-src.tar.gz "$HERMES_SRC_URL" && ` +
              `echo "$HERMES_SRC_SHA256  /tmp/hermes-src.tar.gz" | sha256sum -c - >/dev/null && ` +
              `mkdir -p /opt/hermes-src && tar -xzf /tmp/hermes-src.tar.gz -C /opt/hermes-src --strip-components=1 && ` +
              `grep -qx "version = \\"$HERMES_SRC_VERSION\\"" /opt/hermes-src/pyproject.toml && ` +
              `/opt/hermes/bin/pip install --no-cache-dir --no-deps --no-build-isolation --no-index -e /opt/hermes-src >/dev/null && ` +
              `/opt/hermes/bin/pip check >/dev/null && ` +
              `cp /tmp/hermes/requirements.digest /opt/hermes/.hermes-production-closure && ` +
              `ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes && ` +
              `chmod -R u=rwX,go=rX /opt/hermes /opt/hermes-src && ` +
              `mkdir -p /paperclip && chown -R node:node /paperclip && ` +
              checkScript +
              // Deterministic non-interactive `hermes chat -q` MCP discovery fixture (default and tool_search off).
              ` && gosu node /opt/hermes/bin/python3 /fixtures/hermes-chat-mcp-fixture.py auto` +
              ` && gosu node /opt/hermes/bin/python3 /fixtures/hermes-chat-mcp-fixture.py off`,
          ],
          { encoding: "utf8", timeout: 300_000 },
        );

        expect(output).toBeDefined();
      } finally {
        try {
          execFileSync("docker", ["rm", "-f", testContainerName], { stdio: "ignore" });
        } catch {
          // Cleanup
        }
      }
    }, 360_000);
  },
);
