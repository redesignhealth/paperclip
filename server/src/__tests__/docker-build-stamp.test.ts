import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the Docker build-stamp wiring.
 *
 * The server build runs scripts/write-build-stamp.mjs, which stamps the built
 * commit into dist/build-info.json. The build context has no .git, so the
 * script reads PAPERCLIP_BUILD_COMMIT instead. Docker exposes an ARG to the
 * next RUN as an environment variable, but an ARG goes out of scope at the end
 * of its stage. So the build stage must declare `ARG PAPERCLIP_BUILD_COMMIT`
 * before the server build; the production ARG alone stamps nothing, because
 * the server build already ran in the earlier stage.
 *
 * This guard fails if a refactor drops the build-stage ARG, moves it after the
 * server build, or removes the build-arg the docker workflow passes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");
const cloudWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker-cloud.yml"), "utf8");

/**
 * Return the text of the Dockerfile stage that starts at the named target.
 * A stage runs from its `FROM ... AS <name>` line to the next `FROM` line.
 */
function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS\\s+${stageName}(?:\\s|$)`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

it("keeps per-build runtime metadata out of the weekly CLI-install cache", () => {
  const production = stageBody(dockerfile, "production");
  const tools = production.search(/^RUN echo "cli-tools-epoch:/m);
  const entrypoint = production.search(/^RUN chmod \+x \/usr\/local\/bin\/docker-entrypoint\.sh/m);
  const runtime = production.search(/^ENV NODE_ENV=production/m);
  const epoch = production.search(/^ARG CLI_TOOLS_CACHE_EPOCH\b/m);
  expect(tools).toBeGreaterThanOrEqual(0);
  expect(entrypoint).toBeGreaterThan(tools);
  expect(epoch).toBeGreaterThanOrEqual(0);
  expect(epoch).toBeLessThan(tools);
  for (const name of ["PAPERCLIP_BUILD_VERSION", "PAPERCLIP_BUILD_COMMIT"]) {
    const declarations = [...production.matchAll(new RegExp(`^ARG ${name}\\b`, "gm"))];
    expect(declarations).toHaveLength(1);
    expect(declarations[0].index).toBeGreaterThan(entrypoint);
    expect(declarations[0].index).toBeLessThan(runtime);
    expect(production.slice(runtime)).toContain(`${name}=\${${name}}`);
  }
});

describe("docker build-stamp wiring", () => {
  it("declares PAPERCLIP_BUILD_COMMIT in the build stage before the server build", () => {
    const build = stageBody(dockerfile, "build");
    const argIdx = build.search(/^ARG PAPERCLIP_BUILD_COMMIT\b/m);
    const serverBuildIdx = build.search(/^RUN pnpm --filter @paperclipai\/server build\b/m);
    expect(argIdx, "build stage must declare ARG PAPERCLIP_BUILD_COMMIT").toBeGreaterThanOrEqual(0);
    expect(serverBuildIdx, "build stage must run the server build").toBeGreaterThanOrEqual(0);
    expect(
      argIdx,
      "ARG PAPERCLIP_BUILD_COMMIT must precede the server build so the stamp script reads it",
    ).toBeLessThan(serverBuildIdx);
  });

  it("passes PAPERCLIP_BUILD_COMMIT as a build-arg for both image targets", () => {
    const argLines = [...`${workflow}\n${cloudWorkflow}`.matchAll(/^\s*PAPERCLIP_BUILD_COMMIT=.*$/gm)];
    expect(
      argLines.length,
      "the docker workflow must pass PAPERCLIP_BUILD_COMMIT for the production and cloud builds",
    ).toBeGreaterThanOrEqual(2);
  });

  it("declares stage-scoped ARG NODE_OPTIONS with 4096 default in build stage before server build and prevents exposure in runtime target topology", () => {
    const build = stageBody(dockerfile, "build");
    const base = stageBody(dockerfile, "base");
    const production = stageBody(dockerfile, "production");
    const cloud = stageBody(dockerfile, "cloud");
    const cloudPlugins = stageBody(dockerfile, "cloud-plugins");
    const cloudServerDeps = stageBody(dockerfile, "cloud-server-deps");

    const argDeclarations = [...dockerfile.matchAll(/^\s*ARG\s+(?:[^\n\\]|\\(?:\r?\n|[\s\S]))*?\bNODE_OPTIONS\b/gm)];
    expect(
      argDeclarations,
      "Dockerfile must declare ARG NODE_OPTIONS exactly once to avoid redundant re-declarations across stages",
    ).toHaveLength(1);

    const argIdx = build.search(/^ARG NODE_OPTIONS=--max-old-space-size=4096\b/m);
    const serverBuildIdx = build.search(/^RUN pnpm --filter @paperclipai\/server build\b/m);
    expect(argIdx, "build stage must declare ARG NODE_OPTIONS with the 4096 default").toBeGreaterThanOrEqual(0);
    expect(serverBuildIdx, "build stage must run the server build").toBeGreaterThanOrEqual(0);
    expect(
      argIdx,
      "ARG NODE_OPTIONS must precede the server build so the build step receives the increased heap limit",
    ).toBeLessThan(serverBuildIdx);

    const envInstruction = /^\s*ENV\s+(?:[^\n\\]|\\(?:\r?\n|[\s\S]))*?\bNODE_OPTIONS\b/m;
    const argInstruction = /^\s*ARG\s+(?:[^\n\\]|\\(?:\r?\n|[\s\S]))*?\bNODE_OPTIONS\b/m;

    expect(dockerfile, "Dockerfile must not declare ENV NODE_OPTIONS anywhere").not.toMatch(envInstruction);
    expect(build, "build stage must not declare ENV NODE_OPTIONS").not.toMatch(envInstruction);

    expect(
      cloudPlugins,
      "cloud-plugins stage must inherit FROM build (automatically inheriting build's in-scope ARG NODE_OPTIONS)",
    ).toContain("FROM build AS cloud-plugins");
    expect(
      cloudServerDeps,
      "cloud-server-deps stage must inherit FROM build (automatically inheriting build's in-scope ARG NODE_OPTIONS)",
    ).toContain("FROM build AS cloud-server-deps");

    for (const [stageName, stageContent] of Object.entries({
      "cloud-plugins": cloudPlugins,
      "cloud-server-deps": cloudServerDeps,
    })) {
      expect(
        stageContent,
        `${stageName} stage must not redeclare ARG NODE_OPTIONS (child stages FROM build inherit in-scope build ARGs automatically per Docker scoping)`,
      ).not.toMatch(argInstruction);
      expect(
        stageContent,
        `${stageName} stage must not declare ENV NODE_OPTIONS`,
      ).not.toMatch(envInstruction);
    }

    expect(
      production,
      "production stage must inherit from base (preventing inheritance of build-stage ARGs)",
    ).toContain("FROM base AS production");
    expect(
      cloud,
      "cloud stage must inherit from production (preventing inheritance of build-stage ARGs)",
    ).toContain("FROM production AS cloud");

    for (const [stageName, stageContent] of Object.entries({ base, production, cloud })) {
      expect(
        stageContent,
        `${stageName} stage must not declare ARG NODE_OPTIONS (runtime stages descend from base/production and do not inherit build-stage ARGs)`,
      ).not.toMatch(argInstruction);
      expect(
        stageContent,
        `${stageName} stage must not declare ENV NODE_OPTIONS (build ARGs do not persist as runtime ENV metadata)`,
      ).not.toMatch(envInstruction);
    }
  });
});


describe("Docker Rust dependency cache", () => {
  it("caches the locked dependency recipe separately from source and per-build metadata", () => {
    const chef = stageBody(dockerfile, "rust-chef");
    const planner = stageBody(dockerfile, "runner-plan");
    const dependencies = stageBody(dockerfile, "runner-deps");
    expect(chef).toContain("FROM rust-toolchain AS rust-chef");
    expect(chef).toMatch(/cargo install cargo-chef --version \d+\.\d+\.\d+ --locked/);
    expect(planner).toContain("COPY packages/paperclip-runner/runner ./runner");
    expect(planner).toContain("cargo chef prepare --recipe-path /tmp/runner-recipe.json");
    expect(dependencies).toContain("FROM rust-chef AS runner-deps");
    expect(dependencies).toContain("COPY --from=runner-plan /tmp/runner-recipe.json /tmp/runner-recipe.json");
    expect(dependencies).toContain("cargo chef cook --release --locked --package paperclip-runner-core --bin paperclip-runnerd");
    expect(dependencies).not.toMatch(/COPY .*\.\/runner|COPY .*\.\/protocol|COPY \. \.|PAPERCLIP_BUILD_COMMIT/);
  });

  it("rebuilds real workspace code and embedded protocol inputs after cooking dependencies", () => {
    const native = stageBody(dockerfile, "runner-build");
    expect(native).toContain("FROM runner-deps AS runner-build");
    for (const source of ["runner", "protocol"]) {
      expect(native.indexOf(`COPY packages/paperclip-runner/${source} ./${source}`))
        .toBeLessThan(native.indexOf("cargo build --release"));
      expect(native).toContain(`COPY packages/paperclip-runner/${source} ./${source}`);
    }
    expect(native).toContain("cargo build --release --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --bin paperclip-runnerd");
    expect(stageBody(dockerfile, "build")).toContain("FROM runner-build AS build");
  });
});
