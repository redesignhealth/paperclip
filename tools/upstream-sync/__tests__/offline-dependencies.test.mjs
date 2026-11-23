import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "../vendor/pg.mjs";
import { CA_BUNDLE_PROVENANCE, inspectCaBundle } from "../scripts/refresh-ca-bundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(here, "..");
const lockfilePath = path.join(toolRoot, "package-lock.json");
const vendorFile = path.join(toolRoot, "vendor", "pg.mjs");
const caBundlePath = path.join(toolRoot, "global-bundle.pem");
const buildVendorScript = path.join(toolRoot, "scripts", "build-vendor.mjs");
const refreshCaScript = path.join(toolRoot, "scripts", "refresh-ca-bundle.mjs");

test("vendor/pg.mjs exists and matches lockfile pin", () => {
  assert.ok(fs.existsSync(vendorFile), "vendor/pg.mjs must exist");
  assert.ok(fs.existsSync(lockfilePath), "package-lock.json must exist");

  const lock = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  const pgEntry = lock.packages?.["node_modules/pg"];
  assert.ok(pgEntry, "pg package must be in lockfile");
  assert.equal(pgEntry.version, "8.23.1", "locked pg version must be 8.23.1");

  const content = fs.readFileSync(vendorFile, "utf8");
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const EXPECTED_HASH = "dce1ce7add89014f13cede8af8d3c6658d64205d888a467b9681cdb29df9d48a";
  assert.equal(hash, EXPECTED_HASH, "vendor/pg.mjs sha256 digest must match reproducible build");
});

test("vendor/pg.mjs exports Pool and Client", () => {
  assert.equal(typeof pg.Pool, "function", "pg.Pool must be a constructor function");
  assert.equal(typeof pg.Client, "function", "pg.Client must be a constructor function");

  const pool = new pg.Pool({ connectionString: "postgres://user:pass@localhost:5432/test" });
  assert.ok(pool, "pool instance must be created");
  assert.equal(typeof pool.connect, "function", "pool must have connect method");
  assert.equal(typeof pool.query, "function", "pool must have query method");
});

test("vendor/THIRD_PARTY_NOTICES.md exists and contains full bundled package licenses without placeholders", () => {
  const noticesFile = path.join(toolRoot, "vendor", "THIRD_PARTY_NOTICES.md");
  assert.ok(fs.existsSync(noticesFile), "THIRD_PARTY_NOTICES.md must exist in vendor dir");
  const notices = fs.readFileSync(noticesFile, "utf8");

  // Verify all bundled packages have entries
  const expectedPackages = [
    "pg 8.23.1",
    "pg-cloudflare",
    "pg-connection-string",
    "pg-int8",
    "pg-pool",
    "pg-protocol",
    "pg-types 2.2.0",
    "pgpass 1.0.5",
    "postgres-array",
    "postgres-bytea",
    "postgres-date",
    "postgres-interval",
    "split2",
    "xtend",
  ];
  for (const pkg of expectedPackages) {
    assert.ok(notices.includes(`## ${pkg}`), `must contain notice for ${pkg}`);
  }

  // Verify full MIT text with explicit copyright notices for pg-types and pgpass
  assert.ok(notices.includes("Brian M. Carlson"), "must contain Brian M. Carlson copyright notice for pg-types");
  assert.ok(notices.includes("Hannes Hörl"), "must contain Hannes Hörl copyright notice for pgpass");
  assert.ok(notices.includes("Permission is hereby granted, free of charge"), "must contain full MIT grant text");

  // Rejection of silent placeholder generation
  assert.ok(!notices.includes("Licensed under the MIT License."), "must not contain generic placeholder license text");
  assert.ok(!notices.includes("Licensed under the ISC License."), "must not contain generic placeholder license text");
});

test("global-bundle.pem exists, has valid structure, and matches pinned RDS CA hash", () => {
  assert.ok(fs.existsSync(caBundlePath), "global-bundle.pem must exist");
  const content = fs.readFileSync(caBundlePath, "utf8");
  const info = inspectCaBundle(content);

  assert.ok(info.validMarkers, "CA bundle must have valid matching PEM markers");
  assert.equal(info.certCount, CA_BUNDLE_PROVENANCE.expectedCertCount, `must contain exactly ${CA_BUNDLE_PROVENANCE.expectedCertCount} certificates`);
  assert.equal(info.sha256, CA_BUNDLE_PROVENANCE.expectedSha256, `SHA-256 digest must match pinned Amazon RDS CA bundle hash`);
});

test("scripts/build-vendor.mjs --check succeeds against committed vendor artifacts", () => {
  const output = execFileSync("node", [buildVendorScript, "--check"], {
    cwd: toolRoot,
    encoding: "utf8",
  });
  assert.ok(output.includes("vendor/pg.mjs and THIRD_PARTY_NOTICES.md are up to date"), "build-vendor --check must report up to date");
});

test("scripts/refresh-ca-bundle.mjs --check succeeds against committed CA bundle", () => {
  const output = execFileSync("node", [refreshCaScript, "--check"], {
    cwd: toolRoot,
    encoding: "utf8",
  });
  assert.ok(output.includes("Amazon RDS CA bundle verified"), "refresh-ca-bundle --check must report verified");
});
