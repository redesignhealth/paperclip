#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const lockfilePath = path.join(toolRoot, "package-lock.json");
const vendorDir = path.join(toolRoot, "vendor");
const vendorOutPath = path.join(vendorDir, "pg.mjs");
const noticesOutPath = path.join(vendorDir, "THIRD_PARTY_NOTICES.md");
const entryPoint = path.join(toolRoot, "node_modules", "pg", "lib", "index.js");

const isCheck = process.argv.includes("--check");

// 1. Verify lockfile
if (!fs.existsSync(lockfilePath)) {
  console.error("ERROR: package-lock.json not found at", lockfilePath);
  process.exit(1);
}
const lock = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
const pgPkg = lock.packages?.["node_modules/pg"];
if (!pgPkg) {
  console.error("ERROR: node_modules/pg not found in package-lock.json");
  process.exit(1);
}

const EXPECTED_PG_VERSION = "8.23.1";
if (pgPkg.version !== EXPECTED_PG_VERSION) {
  console.error(`ERROR: package-lock.json pg version is ${pgPkg.version}, expected ${EXPECTED_PG_VERSION}`);
  process.exit(1);
}

// 2. Find esbuild strictly without host-specific paths
function findEsbuild() {
  const localBin = path.join(toolRoot, "node_modules", ".bin", "esbuild");
  if (fs.existsSync(localBin)) return localBin;

  const parentBin = path.join(toolRoot, "..", "..", "node_modules", ".bin", "esbuild");
  if (fs.existsSync(parentBin)) return parentBin;

  try {
    const resolved = require.resolve("esbuild/bin/esbuild");
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  try {
    const which = execFileSync("which", ["esbuild"], { encoding: "utf8" }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {}

  return null;
}

const esbuildBin = findEsbuild();
if (!esbuildBin) {
  console.error("ERROR: esbuild binary not found. Run `npm install` in tools/upstream-sync.");
  process.exit(1);
}

// 3. Ensure entry point exists
if (!fs.existsSync(entryPoint)) {
  console.error("ERROR: pg entry point not found at", entryPoint);
  console.error("Run `npm ci` in tools/upstream-sync before bundling.");
  process.exit(1);
}

// 4. Bundle with esbuild
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const bundled = execFileSync(
  esbuildBin,
  [
    entryPoint,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    `--banner:js=${banner}`,
  ],
  { cwd: toolRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);

// 5. Generate THIRD_PARTY_NOTICES.md
const BUNDLED_PACKAGES = [
  "pg",
  "pg-cloudflare",
  "pg-connection-string",
  "pg-int8",
  "pg-pool",
  "pg-protocol",
  "pg-types",
  "pgpass",
  "postgres-array",
  "postgres-bytea",
  "postgres-date",
  "postgres-interval",
  "split2",
  "xtend",
];

const noticesLines = [
  "# Third-Party Software Notices and Information",
  "",
  "This directory contains third-party software components bundled offline for the Paperclip upstream-sync tool.",
  "Each component is licensed under its respective license terms below (all MIT or ISC).",
  "",
];

for (const pkgName of BUNDLED_PACKAGES) {
  const pkgDir = path.join(toolRoot, "node_modules", pkgName);
  let version = "unknown";
  let licenseType = "MIT";
  let licenseText = "";

  if (fs.existsSync(pkgDir)) {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    version = pkgJson.version || version;
    licenseType = pkgJson.license || licenseType;
    const files = fs.readdirSync(pkgDir);
    const licFile = files.find((f) => /^licen[sc]e/i.test(f));
    if (licFile) {
      licenseText = fs.readFileSync(path.join(pkgDir, licFile), "utf8").trim();
    }
  }

  if (!licenseText) {
    licenseText = `Licensed under the ${licenseType} License.`;
  }

  noticesLines.push(`## ${pkgName} ${version} (${licenseType})`);
  noticesLines.push("");
  noticesLines.push("```");
  noticesLines.push(licenseText);
  noticesLines.push("```");
  noticesLines.push("");
}

const noticesContent = noticesLines.join("\n");

if (isCheck) {
  if (!fs.existsSync(vendorOutPath)) {
    console.error("ERROR: vendor/pg.mjs does not exist. Run `npm run build:vendor`.");
    process.exit(1);
  }
  const existing = fs.readFileSync(vendorOutPath, "utf8");
  if (existing !== bundled) {
    console.error("ERROR: vendor/pg.mjs does not match reproducible esbuild output. Run `npm run build:vendor`.");
    process.exit(1);
  }
  if (!fs.existsSync(noticesOutPath)) {
    console.error("ERROR: vendor/THIRD_PARTY_NOTICES.md does not exist. Run `npm run build:vendor`.");
    process.exit(1);
  }
  const existingNotices = fs.readFileSync(noticesOutPath, "utf8");
  if (existingNotices !== noticesContent) {
    console.error("ERROR: vendor/THIRD_PARTY_NOTICES.md does not match generated notices. Run `npm run build:vendor`.");
    process.exit(1);
  }
  console.log("vendor/pg.mjs and THIRD_PARTY_NOTICES.md are up to date and match lockfile-pinned build.");
  process.exit(0);
}

// 6. Write vendor artifacts
if (!fs.existsSync(vendorDir)) {
  fs.mkdirSync(vendorDir, { recursive: true });
}
fs.writeFileSync(vendorOutPath, bundled, "utf8");
fs.writeFileSync(noticesOutPath, noticesContent, "utf8");

const hash = crypto.createHash("sha256").update(bundled).digest("hex");
console.log(`Built vendor/pg.mjs (${(bundled.length / 1024).toFixed(1)} KB, sha256: ${hash})`);
console.log(`Wrote vendor/THIRD_PARTY_NOTICES.md (${(noticesContent.length / 1024).toFixed(1)} KB)`);
