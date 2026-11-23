import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "../vendor/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(here, "..");
const lockfilePath = path.join(toolRoot, "package-lock.json");
const vendorFile = path.join(toolRoot, "vendor", "pg.mjs");

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

test("vendor/THIRD_PARTY_NOTICES.md exists and contains bundled package licenses", () => {
  const noticesFile = path.join(toolRoot, "vendor", "THIRD_PARTY_NOTICES.md");
  assert.ok(fs.existsSync(noticesFile), "THIRD_PARTY_NOTICES.md must exist in vendor dir");
  const notices = fs.readFileSync(noticesFile, "utf8");

  assert.ok(notices.includes("## pg 8.23.1 (MIT)"), "must contain pg license notice");
  assert.ok(notices.includes("## pg-pool 3.14.0 (MIT)"), "must contain pg-pool license notice");
  assert.ok(notices.includes("## pg-protocol 1.16.1 (MIT)"), "must contain pg-protocol license notice");
  assert.ok(notices.includes("## pg-connection-string 2.14.1 (MIT)"), "must contain pg-connection-string license notice");
  assert.ok(notices.includes("Brian Carlson"), "must contain Brian Carlson MIT copyright notice");
});
