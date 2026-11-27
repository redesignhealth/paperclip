import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  prepareConnectionOptions,
  getRdsCaBundle,
  resolveCaPath,
  DEFAULT_CA_PATH,
  connect,
} from "../lib/db.mjs";
import pg from "pg";

const DUMMY_CERT = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----\n";

test("DEFAULT_CA_PATH points to baked global-bundle.pem location", () => {
  assert.ok(DEFAULT_CA_PATH.endsWith("tools/upstream-sync/global-bundle.pem"));
});

test("resolveCaPath resolves in deterministic priority: custom -> env -> DEFAULT_CA_PATH", () => {
  const origEnv = process.env.UPSTREAM_SYNC_RDS_CA;
  try {
    delete process.env.UPSTREAM_SYNC_RDS_CA;
    assert.equal(resolveCaPath(), DEFAULT_CA_PATH);
    assert.equal(resolveCaPath("/custom/ca.pem"), "/custom/ca.pem");

    process.env.UPSTREAM_SYNC_RDS_CA = "/env/ca.pem";
    assert.equal(resolveCaPath(), "/env/ca.pem");
    assert.equal(resolveCaPath("/custom/ca.pem"), "/custom/ca.pem");
  } finally {
    if (origEnv !== undefined) process.env.UPSTREAM_SYNC_RDS_CA = origEnv;
    else delete process.env.UPSTREAM_SYNC_RDS_CA;
  }
});

test("prepareConnectionOptions enforces strict verified TLS for RDS endpoints and strips URL params", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-tls-test-"));
  const tmpCa = path.join(tmpDir, "test-ca.pem");
  fs.writeFileSync(tmpCa, DUMMY_CERT, "utf8");

  try {
    const rdsUrl = "postgresql://upstream_sync_runner:secret@paperclip-prod-db.cyiyszqxlqoa.us-east-1.rds.amazonaws.com:5432/paperclip?sslmode=require&application_name=test";
    const opts = prepareConnectionOptions(rdsUrl, tmpCa);

    assert.ok(opts.ssl, "SSL config must be defined for RDS endpoint");
    assert.equal(opts.ssl.rejectUnauthorized, true, "rejectUnauthorized must be true (no TLS downgrade)");
    assert.equal(opts.ssl.servername, "paperclip-prod-db.cyiyszqxlqoa.us-east-1.rds.amazonaws.com", "servername must be set for SNI/SAN hostname verification");
    assert.equal(opts.ssl.ca, DUMMY_CERT, "CA bundle must match configured cert");

    // Verify ssl query params are stripped so node-postgres does not override ssl options
    assert.ok(!opts.connectionString.includes("sslmode="), "connectionString must strip sslmode");
    assert.ok(opts.connectionString.includes("application_name=test"), "connectionString must preserve unrelated params");

    // Verify actual client initialization preserves our configured CA and does not drop it to {}
    const client = new pg.Client({ connectionString: opts.connectionString, ssl: opts.ssl });
    assert.ok(client.ssl, "client.ssl must be defined");
    assert.equal(client.ssl.rejectUnauthorized, true);
    assert.equal(client.ssl.servername, "paperclip-prod-db.cyiyszqxlqoa.us-east-1.rds.amazonaws.com");
    assert.equal(client.ssl.ca, opts.ssl.ca, "client.ssl.ca must match configured bundle");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("prepareConnectionOptions fails closed on insecure SSL modes for RDS endpoints", () => {
  const insecureModes = ["disable", "allow", "prefer", "no-verify", "false"];
  for (const mode of insecureModes) {
    const url = `postgresql://user:pass@paperclip-prod-db.cyiyszqxlqoa.us-east-1.rds.amazonaws.com:5432/paperclip?sslmode=${mode}`;
    assert.throws(
      () => prepareConnectionOptions(url),
      /Insecure SSL mode .* is rejected for Amazon RDS endpoint/,
      `must reject sslmode=${mode} on RDS host`,
    );
  }
});

test("prepareConnectionOptions throws sanitized error on invalid database URL (no credential leak)", () => {
  const badUrl = "postgresql://user:super_secret_password@bad:port:host/db";
  try {
    prepareConnectionOptions(badUrl);
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.message, "Invalid database URL");
    assert.ok(!err.message.includes("super_secret_password"), "error must not leak database credentials");
  }
});

test("prepareConnectionOptions throws when CA bundle file is not found for RDS endpoint", () => {
  const rdsUrl = "postgresql://user:pass@paperclip-prod-db.cyiyszqxlqoa.us-east-1.rds.amazonaws.com:5432/paperclip";
  assert.throws(
    () => prepareConnectionOptions(rdsUrl, "/nonexistent/path/never-found.pem"),
    /RDS database connection requires CA certificate bundle, but not found/,
  );
});

test("prepareConnectionOptions preserves non-RDS TLS / CA / mTLS query params and leaves ssl undefined", () => {
  // Generic non-RDS host with standard sslmode / cert parameters
  const nonRdsUrl = "postgres://user:pass@db.internal.example.com:5432/paperclip?sslmode=verify-full&sslrootcert=/etc/ssl/custom.pem&sslcert=/etc/ssl/client.crt&sslkey=/etc/ssl/client.key";
  const opts = prepareConnectionOptions(nonRdsUrl);

  // Must not force RDS CA or strip params
  assert.equal(opts.ssl, undefined, "non-RDS host must leave ssl undefined to let pg handle native libpq params");
  assert.equal(opts.connectionString, nonRdsUrl, "non-RDS connectionString must remain completely untouched");

  // Local dev unencrypted Postgres
  const devUrl = "postgres://user:pass@localhost:5432/paperclip_dev";
  const devOpts = prepareConnectionOptions(devUrl);
  assert.equal(devOpts.ssl, undefined, "dev local Postgres should not force TLS");
  assert.equal(devOpts.connectionString, devUrl);
});

test("prepareConnectionOptions supports explicit RDS trust opt-in for aliases/CNAMEs via options or env", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-alias-test-"));
  const tmpCa = path.join(tmpDir, "alias-ca.pem");
  fs.writeFileSync(tmpCa, DUMMY_CERT, "utf8");

  try {
    const aliasUrl = "postgresql://upstream_sync_runner:secret@db.prod.redesignhealth.com:5432/paperclip?sslmode=require&app=test";

    // 1. Without opt-in: treated as generic non-RDS host
    const defaultOpts = prepareConnectionOptions(aliasUrl);
    assert.equal(defaultOpts.ssl, undefined);
    assert.equal(defaultOpts.connectionString, aliasUrl);

    // 2. With explicit option { rdsTrust: true, caFile: tmpCa }
    const trustedOpts = prepareConnectionOptions(aliasUrl, { rdsTrust: true, caFile: tmpCa });
    assert.ok(trustedOpts.ssl, "must configure SSL when rdsTrust is true");
    assert.equal(trustedOpts.ssl.rejectUnauthorized, true);
    assert.equal(trustedOpts.ssl.servername, "db.prod.redesignhealth.com");
    assert.equal(trustedOpts.ssl.ca, DUMMY_CERT);
    assert.ok(!trustedOpts.connectionString.includes("sslmode="), "must strip sslmode");
    assert.ok(trustedOpts.connectionString.includes("app=test"));

    // 3. With UPSTREAM_SYNC_RDS_TRUST=true environment variable
    process.env.UPSTREAM_SYNC_RDS_TRUST = "true";
    const envTrustedOpts = prepareConnectionOptions(aliasUrl, tmpCa);
    assert.ok(envTrustedOpts.ssl);
    assert.equal(envTrustedOpts.ssl.rejectUnauthorized, true);
    assert.equal(envTrustedOpts.ssl.servername, "db.prod.redesignhealth.com");
  } finally {
    delete process.env.UPSTREAM_SYNC_RDS_TRUST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("prepareConnectionOptions with explicit RDS trust fails closed on insecure SSL modes for aliases", () => {
  const insecureModes = ["disable", "allow", "prefer", "no-verify", "false"];
  for (const mode of insecureModes) {
    const aliasUrl = `postgresql://user:pass@db.prod.redesignhealth.com:5432/paperclip?sslmode=${mode}`;
    assert.throws(
      () => prepareConnectionOptions(aliasUrl, { rdsTrust: true }),
      /Insecure SSL mode .* is rejected for Amazon RDS endpoint/,
      `must reject sslmode=${mode} on RDS-trusted alias`,
    );
  }
});

test("getRdsCaBundle respects custom CA path and env override", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-ca-test-"));
  const tmpCa = path.join(tmpDir, "custom.pem");
  fs.writeFileSync(tmpCa, DUMMY_CERT, "utf8");

  try {
    assert.equal(getRdsCaBundle(tmpCa), DUMMY_CERT);
    assert.equal(getRdsCaBundle("/nonexistent/path.pem"), null);

    process.env.UPSTREAM_SYNC_RDS_CA = tmpCa;
    assert.equal(getRdsCaBundle(), DUMMY_CERT);
  } finally {
    delete process.env.UPSTREAM_SYNC_RDS_CA;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("connect(cfg) wires prepareConnectionOptions through to pg.Pool configuration", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rds-connect-test-"));
  const tmpCa = path.join(tmpDir, "connect-ca.pem");
  fs.writeFileSync(tmpCa, DUMMY_CERT, "utf8");

  try {
    // 1. RDS configuration
    const rdsCfg = {
      databaseUrl: "postgresql://runner:pass@prod.cyiyszqxlqoa.us-east-1.rds.amazonaws.com:5432/db?sslmode=require",
      caFile: tmpCa,
    };
    const poolRds = await connect(rdsCfg);
    assert.ok(poolRds.options.ssl);
    assert.equal(poolRds.options.ssl.servername, "prod.cyiyszqxlqoa.us-east-1.rds.amazonaws.com");
    assert.equal(poolRds.options.ssl.rejectUnauthorized, true);
    assert.equal(poolRds.options.ssl.ca, DUMMY_CERT);
    await poolRds.end();

    // 2. Non-RDS configuration
    const nonRdsCfg = {
      databaseUrl: "postgresql://runner:pass@localhost:5432/db",
    };
    const poolNonRds = await connect(nonRdsCfg);
    assert.equal(poolNonRds.options.ssl, undefined);
    await poolNonRds.end();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("when global-bundle.pem is present on disk, it matches authoritative sha256 digest", () => {
  if (!fs.existsSync(DEFAULT_CA_PATH)) {
    return; // File is downloaded during image build; skipped in local checkouts without bundle
  }
  const bundle = fs.readFileSync(DEFAULT_CA_PATH, "utf8");
  assert.ok(bundle.includes("-----BEGIN CERTIFICATE-----"), "CA bundle must contain PEM certificates");
  const hash = crypto.createHash("sha256").update(bundle).digest("hex");
  const EXPECTED_HASH = "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b";
  assert.equal(hash, EXPECTED_HASH, "AWS RDS CA bundle sha256 must match authoritative Amazon truststore digest");
});
