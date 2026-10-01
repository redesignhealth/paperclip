import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HERMES_CLI } from "../../../packages/adapters/hermes/src/shared/constants.js";

/**
 * Deterministic integrity tests for the Hermes CLI installation in the production Dockerfile
 * and its committed hash-locked dependency closure.
 *
 * Verifies that:
 * 1. The production stage installs the pinned `hermes-agent[mcp,anthropic]==0.19.0` via a committed
 *    hash-locked requirements file (`docker/hermes/requirements.txt`) containing reviewable chunk includes.
 * 2. All chunk files are strictly below GitHub API patch omission thresholds (<250 lines, <20KB each).
 * 3. All transitive dependencies are strictly pinned (`==`) and covered by sha256 distribution hashes.
 * 4. Multi-architecture wheel hashes (amd64 + arm64) are present in the closure.
 * 5. Deterministic offline drift and integrity verification via scripts/compile-hermes-requirements.py --check without uv or network.
 * 6. The `hermes` CLI is symlinked to `/usr/local/bin/hermes` (on system PATH) matching the adapter's HERMES_CLI.
 * 7. `/opt/hermes` is root-owned and read-only to the runtime `node` user (no `chown node:node /opt/hermes`),
 *    preventing code/toolchain mutation across runs by the `--yolo` agent process.
 * 8. `HERMES_DISABLE_LAZY_INSTALLS=1` is set in the runtime environment and forced at spawn time,
 *    ensuring the agent fails closed on missing optional plugins and never executes runtime `pip install`.
 * 9. Deterministic build smoke checks verify `--help`, `--version`, and public `import mcp` without private Hermes symbols.
 * 10. Live integration tests are gated by PAPERCLIP_RUN_DOCKER_HERMES_TESTS=true with isolated tag builds.
 */

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

describe("Dockerfile Hermes CLI installation & packaging integrity", () => {
  const production = stageBody(dockerfile, "production");

  it("pins exact hermes-agent version 0.19.0 in requirements.in and does not declare dead/diverging Docker ARG", () => {
    // ARG HERMES_AGENT_VERSION was removed to prevent divergence from hash-locked requirements
    expect(production).not.toMatch(/^ARG HERMES_AGENT_VERSION=/m);

    // Exact pin is defined in requirements.in
    const inContent = readFileSync(requirementsInPath, "utf8");
    expect(inContent).toMatch(/^hermes-agent\[mcp,anthropic\]==0\.19\.0$/m);
  });

  it("provides committed requirements.in with exact extras pin hermes-agent[mcp,anthropic]==0.19.0", () => {
    expect(existsSync(requirementsInPath), "docker/hermes/requirements.in must exist").toBe(true);
    const content = readFileSync(requirementsInPath, "utf8");
    expect(content).toMatch(/^hermes-agent\[mcp,anthropic\]==0\.19\.0$/m);
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

      // No credentials, passwords, or tokens in requirements
      expect(content).not.toMatch(/(password|secret|token|bearer|ghp_|api[_-]?key)/i);
    }

    const allContent = combinedContent.join("\n");
    expect(totalPackages).toBeGreaterThan(30);
    expect(totalHashes).toBeGreaterThan(100);

    // Top-level packages must be pinned in the chunks
    expect(allContent).toMatch(/^hermes-agent==0\.19\.0 \\/m);
    expect(allContent).toMatch(/^mcp==[0-9.]+/m);
    expect(allContent).toMatch(/^anthropic==[0-9.]+/m);

    // Multi-architecture wheel hashes (amd64 / arm64) present
    expect(allContent).toContain("sha256:f16c709686a78c727bbbf059f92b0bf41c6fc60deec706d2dc19f529175a6125"); // cffi cp313 manylinux aarch64
    expect(allContent).toContain("sha256:a931079504ecc49efed7744c476a5c343a92fabf66dec2db95edb1b2fdc770e2"); // cffi cp313 manylinux x86_64
  });

  it("verifies hash-lock closure verification runs fully offline without uv or network on system PATH", () => {
    const compileScript = path.join(repoRoot, "scripts", "compile-hermes-requirements.py");
    expect(existsSync(compileScript), "scripts/compile-hermes-requirements.py must exist").toBe(true);

    const result = execFileSync("python3", [compileScript, "--check"], {
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
    });
    expect(result).toContain("OK: Hermes requirements hash lock closure and chunks match exactly");
    expect(result).toContain("fully offline");
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
    const fakeChunk = path.join(hermesDir, "requirements-99.txt");
    try {
      // Adding an unexpected unreferenced chunk must cause --check to fail
      writeFileSync(fakeChunk, "# Unexpected chunk\n", "utf8");
      expect(() => {
        execFileSync("python3", [compileScript, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrow();
    } finally {
      if (existsSync(fakeChunk)) {
        unlinkSync(fakeChunk);
      }
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
    expect(production).toMatch(/gosu node \/opt\/hermes\/bin\/python3 -c "import mcp"/);
    expect(production).not.toContain("_MCP_AVAILABLE");
    expect(production).not.toContain("lazy_deps");
    expect(production).not.toContain("_allow_lazy_installs");
  });

  it("proves mutation denial shell pattern fails if writable and passes when sealed", () => {
    const tempDir = path.join(repoRoot, "packages", "adapters", "hermes", ".test-tmp-" + randomUUID());
    execFileSync("sh", ["-c", `mkdir -p "${tempDir}"`]);
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
      execFileSync("sh", ["-c", `chmod 755 "${tempDir}" && rm -rf "${tempDir}"`]);
    }
  });

  it("enforces explicit mutation denial pattern in checkScript for live container tests", () => {
    const testFileContent = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Verify checkScript uses explicit if-touch-then-failure-exit-fi
    expect(testFileContent).toMatch(/if gosu node touch \/opt\/hermes\/bin\/hermes 2>\/dev\/null; then echo [^;]+; exit 1; fi/);
    expect(testFileContent).toMatch(/if gosu node touch \/opt\/hermes\/bin\/mutation_probe 2>\/dev\/null; then echo [^;]+; exit 1; fi/);
    expect(testFileContent).toMatch(/test ! -e \/opt\/hermes\/bin\/mutation_probe/);
    expect(testFileContent).toMatch(/if gosu node touch \/opt\/hermes\/lib\/python3\.13\/site-packages\/mutation_probe\.py 2>\/dev\/null; then echo [^;]+; exit 1; fi/);
    expect(testFileContent).toMatch(/test ! -e \/opt\/hermes\/lib\/python3\.13\/site-packages\/mutation_probe\.py/);

    // Verify the live checkScript does not use '|| true' or '&& exit 1'
    const liveSection = testFileContent.slice(testFileContent.indexOf("const checkScript = ["));
    const checkScriptBlock = liveSection.slice(0, liveSection.indexOf("].join("));
    expect(checkScriptBlock).not.toContain("|| true");
    expect(checkScriptBlock).not.toContain("&& exit 1");
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
      const checkScript = [
        "gosu node hermes --help >/dev/null",
        "gosu node hermes --version >/dev/null",
        "gosu node /opt/hermes/bin/python3 -c 'import mcp'",
        "if gosu node touch /opt/hermes/bin/hermes 2>/dev/null; then echo 'Security failure: /opt/hermes/bin/hermes binary was modified by node'; exit 1; fi",
        "if gosu node touch /opt/hermes/bin/mutation_probe 2>/dev/null; then echo 'Security failure: /opt/hermes/bin is writable by node'; exit 1; fi",
        "test ! -e /opt/hermes/bin/mutation_probe",
        "if gosu node touch /opt/hermes/lib/python3.13/site-packages/mutation_probe.py 2>/dev/null; then echo 'Security failure: site-packages is writable by node'; exit 1; fi",
        "test ! -e /opt/hermes/lib/python3.13/site-packages/mutation_probe.py",
      ].join(" && ");

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
            testImageTag,
            "sh",
            "-c",
            `DEBIAN_FRONTEND=noninteractive apt-get update -qq && ` +
              `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null && ` +
              `/usr/bin/python3 -m venv /opt/hermes && ` +
              `/opt/hermes/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/hermes/requirements.txt >/dev/null && ` +
              `ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes && ` +
              `chmod -R u=rwX,go=rX /opt/hermes && ` +
              `mkdir -p /paperclip && chown -R node:node /paperclip && ` +
              checkScript,
          ],
          { encoding: "utf8", timeout: 120_000 },
        );

        expect(output).toBeDefined();
      } finally {
        try {
          execFileSync("docker", ["rm", "-f", testContainerName], { stdio: "ignore" });
        } catch {
          // Cleanup
        }
      }
    }, 180_000);
  },
);
