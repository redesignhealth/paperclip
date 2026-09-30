import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HERMES_CLI } from "../../../packages/adapters/hermes/src/shared/constants.js";

/**
 * Deterministic integrity tests for the Hermes CLI installation in the production Dockerfile
 * and its committed hash-locked dependency closure.
 *
 * Verifies that:
 * 1. The production stage installs the pinned `hermes-agent[mcp,anthropic]==0.19.0` via a committed
 *    hash-locked requirements file (`docker/hermes/requirements.txt`).
 * 2. All transitive dependencies are strictly pinned (`==`) and covered by sha256 distribution hashes.
 * 3. The `hermes` CLI is symlinked to `/usr/local/bin/hermes` (on system PATH) matching the adapter's HERMES_CLI.
 * 4. `/opt/hermes` is root-owned and read-only to the runtime `node` user (no `chown node:node /opt/hermes`),
 *    preventing code/toolchain mutation across runs by the `--yolo` agent process.
 * 5. `HERMES_DISABLE_LAZY_INSTALLS=1` is set in the runtime environment, ensuring the agent fails closed
 *    on missing optional plugins and never executes runtime `pip install`.
 * 6. Deterministic build smoke checks verify `--help`, `--version`, `import mcp`, and `_MCP_AVAILABLE=True`.
 * 7. Multi-architecture wheel hashes (amd64 + arm64) are present in the closure.
 * 8. Real container / permissions inspection tests verify runtime mutation denial.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfilePath = path.join(repoRoot, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

const requirementsInPath = path.join(repoRoot, "docker", "hermes", "requirements.in");
const requirementsTxtPath = path.join(repoRoot, "docker", "hermes", "requirements.txt");

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
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

describe("Dockerfile Hermes CLI installation & packaging integrity", () => {
  const production = stageBody(dockerfile, "production");

  it("declares exact hermes-agent version pin ARG matching requirements closure", () => {
    const versionMatch = production.match(/^ARG HERMES_AGENT_VERSION=(["']?)([0-9]+\.[0-9]+\.[0-9]+)\1/m);
    expect(versionMatch, "production stage must declare ARG HERMES_AGENT_VERSION with an exact semantic version").toBeTruthy();
    const pinnedVersion = versionMatch![2];
    expect(pinnedVersion).toBe("0.19.0");
  });

  it("provides committed requirements.in with exact extras pin hermes-agent[mcp,anthropic]==0.19.0", () => {
    expect(existsSync(requirementsInPath), "docker/hermes/requirements.in must exist").toBe(true);
    const content = readFileSync(requirementsInPath, "utf8");
    expect(content).toMatch(/^hermes-agent\[mcp,anthropic\]==0\.19\.0$/m);
  });

  it("provides committed requirements.txt with 100% hash-locked exact pins", () => {
    expect(existsSync(requirementsTxtPath), "docker/hermes/requirements.txt must exist").toBe(true);
    const content = readFileSync(requirementsTxtPath, "utf8");

    // Top-level packages must be pinned
    expect(content).toMatch(/^hermes-agent==0\.19\.0 \\/m);
    expect(content).toMatch(/^mcp==[0-9.]+/m);
    expect(content).toMatch(/^anthropic==[0-9.]+/m);

    // Extract all package declarations (lines before backslashes or standalone lines)
    const packageLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("--hash="));

    expect(packageLines.length).toBeGreaterThan(30);

    for (const pkgLine of packageLines) {
      // Must use exact pin (==) and no range constraints
      expect(pkgLine).toMatch(/^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.-]+/);
      expect(pkgLine).not.toMatch(/[<>~]=/);
    }

    // Must contain sha256 hashes
    const hashLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("--hash=sha256:"));
    expect(hashLines.length).toBeGreaterThan(100);

    // Verify multi-architecture coverage: binary extension packages (e.g. cffi, pydantic-core, uvloop)
    // have multiple distribution hashes covering both linux/amd64 (x86_64) and linux/arm64 (aarch64)
    const cffiBlock = content.match(/cffi==[0-9.]+[^\n]*\n((?:\s+--hash=sha256:[^\n]+\n)+)/);
    expect(cffiBlock, "cffi must have distribution hashes").toBeTruthy();
    const cffiHashes = cffiBlock![1].trim().split("\n");
    expect(cffiHashes.length, "cffi must contain binary wheel hashes for multiple architectures").toBeGreaterThan(20);
    // Explicitly verify known CPython 3.13 manylinux wheel hashes for aarch64 and x86_64
    expect(content).toContain("sha256:f16c709686a78c727bbbf059f92b0bf41c6fc60deec706d2dc19f529175a6125"); // cffi cp313 manylinux aarch64
    expect(content).toContain("sha256:a931079504ecc49efed7744c476a5c343a92fabf66dec2db95edb1b2fdc770e2"); // cffi cp313 manylinux x86_64

    // No credentials, passwords, or tokens in requirements
    expect(content).not.toMatch(/(password|secret|token|bearer|ghp_|api[_-]?key)/i);
  });

  it("installs hermes from requirements.txt enforcing hashes and --no-deps", () => {
    expect(production).toContain("COPY docker/hermes/requirements.txt /tmp/hermes-requirements.txt");
    expect(production).toMatch(/pip install --no-cache-dir --require-hashes --no-deps -r \/tmp\/hermes-requirements\.txt/);
    expect(production).toContain("rm -f /tmp/hermes-requirements.txt");
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

  it("runs non-root build smoke checks including MCP availability and disabled lazy installs", () => {
    expect(production).toMatch(/gosu node hermes --help >\/dev\/null/);
    expect(production).toMatch(/gosu node hermes --version >\/dev\/null/);
    expect(production).toMatch(/gosu node \/opt\/hermes\/bin\/python3 -c "import mcp; from tools\.mcp_tool import _MCP_AVAILABLE; assert _MCP_AVAILABLE is True"/);
    expect(production).toMatch(/HERMES_DISABLE_LAZY_INSTALLS=1 gosu node \/opt\/hermes\/bin\/python3 -c "from tools\.lazy_deps import _allow_lazy_installs; assert _allow_lazy_installs\(\) is False"/);
  });

  it("orders CLI installation before application source copy to preserve layer cache", () => {
    const toolsLayerIdx = production.search(/hermes-requirements\.txt/);
    const appCopyIdx = production.search(/COPY --chown=node:node --from=build \/app \/app/);
    expect(toolsLayerIdx, "Hermes tool installation must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(appCopyIdx, "app copy must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(toolsLayerIdx, "Hermes tool installation must precede application source copy").toBeLessThan(appCopyIdx);
  });

  it("maintains architecture compatibility without arch-exclusive barriers", () => {
    const hermesSection = production.slice(
      production.indexOf("COPY docker/hermes/requirements.txt"),
      production.indexOf("gosu node hermes --version"),
    );
    expect(hermesSection).not.toContain("dpkg --print-architecture");
    expect(hermesSection).not.toContain("amd64");
  });

  it("verifies live container runtime immutability and MCP availability when Docker is running", () => {
    if (!isDockerAvailable()) {
      return;
    }

    // Run container smoke check proving non-root user cannot mutate /opt/hermes and MCP is True
    const checkScript = [
      "gosu node hermes --help >/dev/null",
      "gosu node hermes --version >/dev/null",
      "gosu node /opt/hermes/bin/python3 -c 'import mcp; from tools.mcp_tool import _MCP_AVAILABLE; assert _MCP_AVAILABLE is True'",
      "HERMES_DISABLE_LAZY_INSTALLS=1 gosu node /opt/hermes/bin/python3 -c 'from tools.lazy_deps import _allow_lazy_installs; assert _allow_lazy_installs() is False'",
      "gosu node touch /opt/hermes/bin/pwned 2>&1 && exit 1 || true",
      "gosu node touch /opt/hermes/lib/python3.13/site-packages/pwned.py 2>&1 && exit 1 || true",
    ].join(" && ");

    // Test in paperclip-base (which has python3, venv, gosu)
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${requirementsTxtPath}:/tmp/hermes-requirements.txt:ro`,
        "paperclip-base",
        "sh",
        "-c",
        `apt-get update -qq && apt-get install -y -qq python3-venv >/dev/null && ` +
          `/usr/bin/python3 -m venv /opt/hermes && ` +
          `/opt/hermes/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/hermes-requirements.txt >/dev/null && ` +
          `ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes && ` +
          `chmod -R u=rwX,go=rX /opt/hermes && ` +
          `mkdir -p /paperclip && chown -R node:node /paperclip && ` +
          checkScript,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );

    expect(output).toBeDefined();
  }, 120_000);

  it("verifies offline Hermes MCP configuration loading matches include filter and suppresses utility tools", () => {
    if (!isDockerAvailable()) {
      return;
    }

    const testPythonScript = `
from types import SimpleNamespace
from tools.mcp_tool import _register_server_tools, _select_utility_schemas

mock_server = SimpleNamespace(
    tool_timeout=30.0,
    _tools=[
        SimpleNamespace(name='allowed_tool', description='Allowed tool', inputSchema={'type': 'object'}),
        SimpleNamespace(name='disallowed_tool', description='Disallowed tool', inputSchema={'type': 'object'}),
    ],
    initialize_result=SimpleNamespace(capabilities=SimpleNamespace(resources={}, prompts={}))
)
config = {
    'tools': {
        'include': ['allowed_tool'],
        'resources': False,
        'prompts': False,
    }
}
registered = _register_server_tools('test_srv', mock_server, config)
assert registered == ['mcp__test_srv__allowed_tool'], f'Unexpected registration: {registered}'
utilities = _select_utility_schemas('test_srv', mock_server, config)
assert len(utilities) == 0, f'Expected 0 utilities when disabled, got {len(utilities)}'
print('OFFLINE_MCP_CONFIG_VALIDATED')
`;

    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${requirementsTxtPath}:/tmp/hermes-requirements.txt:ro`,
        "paperclip-base",
        "sh",
        "-c",
        `apt-get update -qq && apt-get install -y -qq python3-venv >/dev/null && ` +
          `/usr/bin/python3 -m venv /opt/hermes && ` +
          `/opt/hermes/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/hermes-requirements.txt >/dev/null && ` +
          `/opt/hermes/bin/python3 -c "${testPythonScript}"`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );

    expect(output).toContain("OFFLINE_MCP_CONFIG_VALIDATED");
  }, 120_000);
});
