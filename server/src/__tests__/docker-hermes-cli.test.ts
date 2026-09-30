import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HERMES_CLI } from "../../../packages/adapters/hermes/src/shared/constants.js";

/**
 * Deterministic integrity test for the Hermes CLI installation in the production Dockerfile.
 *
 * Verifies that:
 * 1. The production stage installs the pinned `hermes-agent` PyPI package in a dedicated venv.
 * 2. The `hermes` CLI is symlinked to `/usr/local/bin/hermes` (on system PATH) matching the adapter's HERMES_CLI.
 * 3. The virtual environment is owned by the non-root `node` user to support non-root execution and lazy-deps.
 * 4. A non-root smoke check (`gosu node hermes --help` and `--version`) is executed during the image build without network calls.
 * 5. CLI installation happens in the stable tool layer before `/app` source copy to preserve Docker layer caching.
 * 6. Installation is multi-architecture compatible (no amd64-only guards).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfilePath = path.join(repoRoot, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\b`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

describe("Dockerfile Hermes CLI installation", () => {
  const production = stageBody(dockerfile, "production");

  it("declares exact hermes-agent version pin without unbounded install", () => {
    const versionMatch = production.match(/^ARG HERMES_AGENT_VERSION=(["']?)([0-9]+\.[0-9]+\.[0-9]+)\1/m);
    expect(versionMatch, "production stage must declare ARG HERMES_AGENT_VERSION with an exact semantic version").toBeTruthy();
    const pinnedVersion = versionMatch![2];
    expect(pinnedVersion).toBe("0.19.0");

    // Must not install without an exact version pin
    expect(production).not.toMatch(/pip install [^"\n]*\bhermes-agent\b(?![ =<>]|==)/);
    // Must use exact pin hermes-agent==...
    expect(production).toMatch(/pip install [^"\n]*--no-cache-dir [^"\n]*"hermes-agent==\$\{HERMES_AGENT_VERSION\}"/);
  });

  it("installs python3-venv runtime dependency and isolates in /opt/hermes", () => {
    expect(production).toMatch(/apt-get install -y --no-install-recommends [^\n]*\bpython3-venv\b/);
    expect(production).toContain("/usr/bin/python3 -m venv /opt/hermes");
    expect(production).toContain("/opt/hermes/bin/pip install --no-cache-dir");
  });

  it("makes hermes available on PATH matching adapter HERMES_CLI", () => {
    expect(HERMES_CLI).toBe("hermes");
    expect(production).toContain(`/usr/local/bin/${HERMES_CLI}`);
    expect(production).toMatch(new RegExp(`ln -sf /opt/hermes/bin/${HERMES_CLI} /usr/local/bin/${HERMES_CLI}`));
  });

  it("sets /opt/hermes non-root ownership for unprivileged execution and lazy-deps", () => {
    // /opt/hermes must be owned by node:node so the runtime non-root user can run and install lazy-deps
    expect(production).toMatch(/chown -R node:node [^\n]*\/opt\/hermes/);
  });

  it("runs non-root build smoke checks without network or provider calls", () => {
    // Verifies the smoke check runs as unprivileged user `node` using gosu
    expect(production).toMatch(/gosu node hermes --help >\/dev\/null/);
    expect(production).toMatch(/gosu node hermes --version >\/dev\/null/);
  });

  it("orders CLI installation before application source copy to preserve layer cache", () => {
    const toolsLayerIdx = production.search(/hermes-agent/);
    const appCopyIdx = production.search(/COPY --chown=node:node --from=build \/app \/app/);
    expect(toolsLayerIdx, "Hermes tool installation must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(appCopyIdx, "app copy must exist in production stage").toBeGreaterThanOrEqual(0);
    expect(toolsLayerIdx, "Hermes tool installation must precede application source copy").toBeLessThan(appCopyIdx);
  });

  it("maintains architecture compatibility without arch-exclusive barriers", () => {
    // Hermes installation should not be gated behind an amd64-only check
    const hermesSection = production.slice(
      production.indexOf("/usr/bin/python3 -m venv /opt/hermes"),
      production.indexOf("gosu node hermes --version"),
    );
    expect(hermesSection).not.toContain("dpkg --print-architecture");
    expect(hermesSection).not.toContain("amd64");
  });
});
