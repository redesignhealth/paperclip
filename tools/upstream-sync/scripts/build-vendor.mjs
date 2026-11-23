#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const lockfilePath = path.join(toolRoot, "package-lock.json");
const pkgJsonPath = path.join(toolRoot, "package.json");
const vendorDir = path.join(toolRoot, "vendor");
const vendorOutPath = path.join(vendorDir, "pg.mjs");
const noticesOutPath = path.join(vendorDir, "THIRD_PARTY_NOTICES.md");
const entryPoint = path.join(toolRoot, "node_modules", "pg", "lib", "index.js");

const isCheck = process.argv.includes("--check");

// 1. Verify lockfile and package.json pinning
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

const esbuildPkg = lock.packages?.["node_modules/esbuild"];
if (!esbuildPkg) {
  console.error("ERROR: node_modules/esbuild not found in package-lock.json");
  process.exit(1);
}

const EXPECTED_PG_VERSION = "8.23.1";
if (pgPkg.version !== EXPECTED_PG_VERSION) {
  console.error(`ERROR: package-lock.json pg version is ${pgPkg.version}, expected ${EXPECTED_PG_VERSION}`);
  process.exit(1);
}

const EXPECTED_ESBUILD_VERSION = "0.28.2";
if (esbuildPkg.version !== EXPECTED_ESBUILD_VERSION) {
  console.error(`ERROR: package-lock.json esbuild version is ${esbuildPkg.version}, expected ${EXPECTED_ESBUILD_VERSION}`);
  process.exit(1);
}

if (!fs.existsSync(pkgJsonPath)) {
  console.error("ERROR: package.json not found at", pkgJsonPath);
  process.exit(1);
}
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
if (pkgJson.dependencies?.pg !== EXPECTED_PG_VERSION) {
  console.error(`ERROR: package.json dependencies.pg must be pinned exactly to ${EXPECTED_PG_VERSION}, found ${pkgJson.dependencies?.pg}`);
  process.exit(1);
}
if (pkgJson.devDependencies?.esbuild !== EXPECTED_ESBUILD_VERSION) {
  console.error(`ERROR: package.json devDependencies.esbuild must be pinned exactly to ${EXPECTED_ESBUILD_VERSION}, found ${pkgJson.devDependencies?.esbuild}`);
  process.exit(1);
}

// 2. Use ONLY locked local esbuild binary and verify installed dependencies match lockfile
const localEsbuildBin = path.join(toolRoot, "node_modules", ".bin", "esbuild");
if (!fs.existsSync(localEsbuildBin)) {
  console.error("ERROR: local esbuild binary not found at", localEsbuildBin);
  console.error("Run `npm ci` in tools/upstream-sync before bundling.");
  process.exit(1);
}

const installedEsbuildPkgPath = path.join(toolRoot, "node_modules", "esbuild", "package.json");
if (!fs.existsSync(installedEsbuildPkgPath)) {
  console.error("ERROR: installed esbuild package.json not found at", installedEsbuildPkgPath);
  console.error("Run `npm ci` in tools/upstream-sync before bundling.");
  process.exit(1);
}
const installedEsbuildPkg = JSON.parse(fs.readFileSync(installedEsbuildPkgPath, "utf8"));
if (installedEsbuildPkg.version !== EXPECTED_ESBUILD_VERSION) {
  console.error(`ERROR: installed esbuild version (${installedEsbuildPkg.version}) does not match locked version (${EXPECTED_ESBUILD_VERSION})`);
  process.exit(1);
}

const esbuildReportedVersion = execFileSync(localEsbuildBin, ["--version"], { encoding: "utf8" }).trim();
if (esbuildReportedVersion !== EXPECTED_ESBUILD_VERSION) {
  console.error(`ERROR: esbuild binary reported version (${esbuildReportedVersion}) does not match locked version (${EXPECTED_ESBUILD_VERSION})`);
  process.exit(1);
}

const installedPgPkgPath = path.join(toolRoot, "node_modules", "pg", "package.json");
if (!fs.existsSync(installedPgPkgPath)) {
  console.error("ERROR: installed pg package.json not found at", installedPgPkgPath);
  console.error("Run `npm ci` in tools/upstream-sync before bundling.");
  process.exit(1);
}
const installedPgPkg = JSON.parse(fs.readFileSync(installedPgPkgPath, "utf8"));
if (installedPgPkg.version !== EXPECTED_PG_VERSION) {
  console.error(`ERROR: installed pg version (${installedPgPkg.version}) does not match locked version (${EXPECTED_PG_VERSION})`);
  process.exit(1);
}

// 3. Ensure entry point exists
if (!fs.existsSync(entryPoint)) {
  console.error("ERROR: pg entry point not found at", entryPoint);
  console.error("Run `npm ci` in tools/upstream-sync before bundling.");
  process.exit(1);
}

// 4. Bundle with locked local esbuild and derive bundled packages via metafile
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const tmpBundlePath = path.join(toolRoot, ".tmp-pg-bundle.mjs");
const tmpMetaPath = path.join(toolRoot, ".tmp-pg-meta.json");

let bundled = "";
const derivedPackages = new Set();

try {
  execFileSync(
    localEsbuildBin,
    [
      entryPoint,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      `--banner:js=${banner}`,
      `--outfile=${tmpBundlePath}`,
      `--metafile=${tmpMetaPath}`,
    ],
    { cwd: toolRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );

  bundled = fs.readFileSync(tmpBundlePath, "utf8");
  const meta = JSON.parse(fs.readFileSync(tmpMetaPath, "utf8"));

  for (const input of Object.keys(meta.inputs || {})) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) {
      derivedPackages.add(match[1]);
    }
  }
} finally {
  if (fs.existsSync(tmpBundlePath)) fs.unlinkSync(tmpBundlePath);
  if (fs.existsSync(tmpMetaPath)) fs.unlinkSync(tmpMetaPath);
}

if (derivedPackages.size === 0) {
  console.error("ERROR: failed to derive any bundled dependencies from esbuild metafile");
  process.exit(1);
}

// 5. Generate THIRD_PARTY_NOTICES.md covering all bundled packages without silent placeholders
const noticesLines = [
  "# Third-Party Software Notices and Information",
  "",
  "This directory contains third-party software components bundled offline for the Paperclip upstream-sync tool.",
  "Each component is licensed under its respective license terms below (all MIT or ISC).",
  "",
];

function extractLicenseFromReadme(readmeContent) {
  const match = readmeContent.match(/##\s+license\s*\n+([\s\S]*)$/i);
  if (match) {
    return match[1].trim();
  }
  return null;
}

const sortedPackages = Array.from(derivedPackages).sort();

for (const pkgName of sortedPackages) {
  const pkgDir = path.join(toolRoot, "node_modules", pkgName);
  if (!fs.existsSync(pkgDir)) {
    console.error(`ERROR: bundled package directory does not exist: ${pkgDir}`);
    process.exit(1);
  }

  const pkgMeta = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const version = pkgMeta.version;
  const licenseType = pkgMeta.license || "MIT";

  let licenseText = "";
  const files = fs.readdirSync(pkgDir);
  const licFile = files.find((f) => /^licen[sc]e/i.test(f));

  if (licFile) {
    licenseText = fs.readFileSync(path.join(pkgDir, licFile), "utf8").trim();
  } else {
    // Upstream packages like pg-types and pgpass record their full MIT license + copyright in README.md
    const readmeFile = files.find((f) => /^readme/i.test(f));
    if (readmeFile) {
      const readme = fs.readFileSync(path.join(pkgDir, readmeFile), "utf8");
      const extracted = extractLicenseFromReadme(readme);
      if (extracted) {
        licenseText = extracted;
      }
    }
  }

  // Avoid silent placeholder generation: require complete text with copyright declaration
  if (!licenseText || licenseText.startsWith("Licensed under the")) {
    console.error(`ERROR: missing full license notice for bundled dependency "${pkgName}" (${version}). Placeholder text rejected.`);
    process.exit(1);
  }

  if (!/copyright|©|\(c\)/i.test(licenseText)) {
    console.error(`ERROR: license notice for "${pkgName}" (${version}) lacks required copyright declaration`);
    process.exit(1);
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
console.log(`Wrote vendor/THIRD_PARTY_NOTICES.md (${(noticesContent.length / 1024).toFixed(1)} KB, ${sortedPackages.length} packages covered)`);
