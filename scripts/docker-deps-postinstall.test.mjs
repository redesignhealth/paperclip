import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const lifecycleNames = ["preinstall", "install", "postinstall", "prepare"];

async function verifyDependencyStage(dockerfile) {
  const stage = dockerfile.split(/^FROM .* AS deps\s*$/im)[1]?.split(/^FROM /im)[0];
  assert.ok(stage, "dependency stage exists");
  const install = stage.search(/^RUN pnpm install\b/m);
  assert.ok(install >= 0, "dependency stage runs pnpm install");
  const fixture = await mkdtemp(path.join(tmpdir(), "paperclip-docker-postinstall-"));
  try {
    for (const line of stage.slice(0, install).split("\n")) {
      if (!line.startsWith("COPY ")) continue;
      const args = line.trim().split(/\s+/).slice(1);
      const destination = args.pop();
      if (args[0] === "--parents") {
        for (const source of args.slice(1)) {
          const match = /^(.*)\/\.\/\*\/package\.json$/.exec(source);
          assert.ok(match, `unsupported parent COPY source: ${source}`);
          for (const entry of await readdir(path.join(repo, match[1]), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const sourcePath = path.join(repo, match[1], entry.name, "package.json");
            try {
              await stat(sourcePath);
            } catch (error) {
              if (error.code === "ENOENT") continue;
              throw error;
            }
            const target = path.join(fixture, destination, entry.name, "package.json");
            await mkdir(path.dirname(target), { recursive: true });
            await cp(sourcePath, target);
          }
        }
        continue;
      }
      assert.ok(!args[0].startsWith("--"), `unsupported COPY flag: ${line}`);
      for (const source of args) {
        const target = destination.endsWith("/")
          ? path.join(fixture, destination, path.basename(source))
          : path.join(fixture, destination);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(repo, source), target, { recursive: true });
      }
    }

    const manifests = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name === "package.json") manifests.push(file);
      }
    }
    await walk(fixture);
    assert.ok(manifests.length > 1, "workspace manifests were copied");
    let hooks = 0;
    for (const manifest of manifests) {
      const scripts = JSON.parse(await readFile(manifest, "utf8")).scripts ?? {};
      for (const name of lifecycleNames) {
        if (!scripts[name]) continue;
        hooks += 1;
        const match = /^node\s+(\S+\.m?js)$/.exec(scripts[name]);
        assert.ok(match, `${path.relative(fixture, manifest)} ${name}: unsupported lifecycle command`);
        await assert.doesNotReject(
          stat(path.join(path.dirname(manifest), match[1])),
          `${path.relative(fixture, manifest)} ${name}: dependency stage must copy ${match[1]}`,
        );
      }
    }
    assert.ok(hooks >= 1, "expected at least the root postinstall hook");
    // The fork has no Copilot postinstall hooks; execute its actual root hook.
    const root = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8"));
    assert.equal(root.scripts.postinstall, "node scripts/link-plugin-dev-sdk.mjs");
    execFileSync(process.execPath, ["scripts/link-plugin-dev-sdk.mjs"], {
      cwd: fixture, encoding: "utf8", timeout: 10_000,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("dependency-layer inputs supply the fork's install lifecycle scripts before compilation", async () => {
  await verifyDependencyStage(await readFile(path.join(repo, "Dockerfile"), "utf8"));
});

test("dependency-layer validation rejects a missing postinstall script", async () => {
  const dockerfile = await readFile(path.join(repo, "Dockerfile"), "utf8");
  const withoutHook = dockerfile.replace(/^COPY scripts\/link-plugin-dev-sdk\.mjs scripts\/\r?\n/m, "");
  assert.notEqual(withoutHook, dockerfile, "negative fixture removes the lifecycle COPY");
  await assert.rejects(verifyDependencyStage(withoutHook), /dependency stage must copy scripts\/link-plugin-dev-sdk\.mjs/);
});
