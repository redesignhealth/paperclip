// Bundle the built server into `dist-runtime/` for production startup.
//
// The server's tsc output imports the workspace packages as TypeScript source
// (their package exports point at `src/*.ts`), so production used to start
// Node with the tsx loader. Every boot then resolved and transpiled thousands
// of modules through tsx's hooks: about 8-10 s warm and over 20 s on a cold
// container, all before the server could listen. This script runs after the
// server `build` and bundles `dist/index.js`, with the workspace packages
// compiled in, so production starts with plain `node` in a few seconds.
//
// The bundle keeps runtime behavior the same as running `dist/index.js`:
//
// - Third-party packages stay external. A package the server package itself
//   resolves to the same file stays a bare specifier, so Node resolves it at
//   runtime from server/node_modules exactly as before (the cloud image adds
//   optional peers such as @sentry/node there after the build). Only a
//   dependency that pnpm's strict layout hides from the server package, one
//   that only a workspace package can see, is emitted as an absolute path.
//   Resolution follows Node's rules (the `main` field and `node` condition),
//   not bundler-only `module` builds.
// - Every bundled module keeps its own location: `import.meta.url`,
//   `import.meta.dirname` and `import.meta.filename` are replaced with the
//   module's original path, so code that finds files next to its source
//   (scripts, assets, worker entry files) keeps finding them.
// - Code splitting keeps dynamic imports as separate chunks. Bundled into a
//   single file, the server's top-level await never settled (observed on the
//   production build); split chunks keep the module evaluation order Node
//   uses for the unbundled output.
// - A `require` built from the chunk's location is provided for the few
//   modules that call `require` from ESM.
// - The bundle's entry sets `process.argv[1]` to the original entry file
//   before loading it, so the server's main-module check (and anything else
//   that reads argv[1]) sees exactly what it saw when started unbundled.

import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = join(scriptDir, "..");

const REQUIRE_SHIM = "import { createRequire as __paperclipCreateRequire } from 'node:module'; const require = __paperclipCreateRequire(import.meta.url);";

/**
 * Replace a module's `import.meta` location properties with its original
 * path, so bundling does not move where the module looks for nearby files.
 *
 * @param {string} source Module source.
 * @param {string} file Absolute path of the module's original file.
 * @returns {string}
 */
export function preserveModuleLocation(source, file) {
  return source
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(file).href))
    .replace(/\bimport\.meta\.dirname\b/g, JSON.stringify(dirname(file)))
    .replace(/\bimport\.meta\.filename\b/g, JSON.stringify(file));
}

/**
 * The bundle's entry: present the original entry file as the main module,
 * then load it.
 *
 * @param {string} entry Absolute path of the original entry file.
 * @returns {import("esbuild").Plugin}
 */
function runtimeEntry(entry) {
  return {
    name: "runtime-entry",
    setup(builder) {
      builder.onResolve({ filter: /^paperclip-runtime-entry$/ }, () => ({ path: "paperclip-runtime-entry", namespace: "runtime-entry" }));
      builder.onLoad({ filter: /.*/, namespace: "runtime-entry" }, () => ({
        contents: `process.argv[1] = ${JSON.stringify(entry)};\nawait import(${JSON.stringify(entry)});\n`,
        loader: "js",
        resolveDir: dirname(entry),
      }));
    },
  };
}

/** @type {import("esbuild").Plugin} */
const keepModuleLocations = {
  name: "keep-module-locations",
  setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|[cm]?ts)$/ }, async (args) => {
      if (args.path.includes("/node_modules/")) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta")) return undefined;
      return {
        contents: preserveModuleLocation(source, args.path),
        loader: /\.[cm]?ts$/.test(args.path) ? "ts" : "js",
        resolveDir: dirname(args.path),
      };
    });
  },
};

/**
 * @param {(specifier: string) => boolean} isBundled Whether a bare specifier is
 *   bundled (workspace packages) rather than kept external.
 * @param {string} runtimeDir A directory inside the server package, from which
 *   bare specifiers resolve at runtime.
 * @returns {import("esbuild").Plugin}
 */
function externalizeThirdParty(isBundled, runtimeDir) {
  return {
    name: "externalize-third-party",
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData?.externalizeThirdParty || isBundled(args.path)) return undefined;
        const resolved = await builder.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          pluginData: { externalizeThirdParty: true },
        });
        // Builtins and anything esbuild cannot resolve stay as written;
        // Node resolves them at runtime exactly as before.
        if (resolved.errors.length > 0 || resolved.external) return { path: args.path, external: true };
        const fromServer = await builder.resolve(args.path, {
          kind: args.kind,
          resolveDir: runtimeDir,
          pluginData: { externalizeThirdParty: true },
        });
        if (fromServer.errors.length === 0 && fromServer.path === resolved.path) return { path: args.path, external: true };
        return { path: resolved.path, external: true };
      });
    },
  };
}

/**
 * Bundle a built entry point and everything it imports from the workspace.
 *
 * @param {{
 *   entry: string,
 *   outdir: string,
 *   isBundled?: (specifier: string) => boolean,
 * }} options
 * @returns {Promise<{ outfile: string, inputs: number, chunks: number }>}
 */
export async function bundleRuntime({ entry, outdir, isBundled = (specifier) => specifier.startsWith("@paperclipai/") }) {
  await rm(outdir, { recursive: true, force: true });
  const result = await build({
    entryPoints: { index: "paperclip-runtime-entry" },
    outdir,
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunk-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    mainFields: ["main"],
    conditions: ["node"],
    banner: { js: REQUIRE_SHIM },
    sourcemap: "linked",
    metafile: true,
    logLevel: "error",
    plugins: [runtimeEntry(entry), keepModuleLocations, externalizeThirdParty(isBundled, dirname(entry))],
  });
  const outputs = Object.keys(result.metafile.outputs).filter((file) => file.endsWith(".mjs"));
  return { outfile: join(outdir, "index.mjs"), inputs: Object.keys(result.metafile.inputs).length, chunks: outputs.length };
}

async function main() {
  const started = performance.now();
  const summary = await bundleRuntime({ entry: join(serverDir, "dist", "index.js"), outdir: join(serverDir, "dist-runtime") });
  console.log(`[bundle-runtime] ${summary.inputs} inputs -> ${summary.chunks} chunks in ${Math.round(performance.now() - started)} ms: ${summary.outfile}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
