#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const caPath = path.join(toolRoot, "global-bundle.pem");

export const CA_BUNDLE_PROVENANCE = {
  sourceUrl: "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
  documentationUrl: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html",
  expectedSha256: "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b",
  expectedCertCount: 114,
  description: "Amazon RDS and Aurora global root and intermediate Certificate Authority bundle for TLS verification",
};

const isCheck = process.argv.includes("--check");

export function inspectCaBundle(pemContent) {
  const sha256 = crypto.createHash("sha256").update(pemContent).digest("hex");
  const beginMatches = pemContent.match(/-----BEGIN CERTIFICATE-----/g) || [];
  const endMatches = pemContent.match(/-----END CERTIFICATE-----/g) || [];
  return {
    sha256,
    certCount: beginMatches.length,
    validMarkers: beginMatches.length > 0 && beginMatches.length === endMatches.length,
  };
}

async function main() {
  if (isCheck) {
    if (!fs.existsSync(caPath)) {
      console.error(`ERROR: CA bundle not found at ${caPath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(caPath, "utf8");
    const info = inspectCaBundle(content);

    if (!info.validMarkers) {
      console.error("ERROR: CA bundle contains mismatched or missing PEM certificate boundaries");
      process.exit(1);
    }
    if (info.certCount < CA_BUNDLE_PROVENANCE.expectedCertCount) {
      console.error(`ERROR: CA bundle contains ${info.certCount} certificates, expected at least ${CA_BUNDLE_PROVENANCE.expectedCertCount}`);
      process.exit(1);
    }
    if (info.sha256 !== CA_BUNDLE_PROVENANCE.expectedSha256) {
      console.error(`ERROR: CA bundle SHA-256 digest ${info.sha256} does not match pinned hash ${CA_BUNDLE_PROVENANCE.expectedSha256}`);
      console.error(`If refreshing AWS RDS certificates intentionally, update the pinned hash and documentation.`);
      process.exit(1);
    }

    console.log(`Amazon RDS CA bundle verified (${info.certCount} certificates, sha256: ${info.sha256})`);
    process.exit(0);
  }

  console.log(`Fetching Amazon RDS global CA bundle from ${CA_BUNDLE_PROVENANCE.sourceUrl}...`);
  const response = await fetch(CA_BUNDLE_PROVENANCE.sourceUrl);
  if (!response.ok) {
    console.error(`ERROR: Failed to download CA bundle: HTTP ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const fetchedPem = await response.text();
  const info = inspectCaBundle(fetchedPem);

  if (!info.validMarkers || info.certCount < CA_BUNDLE_PROVENANCE.expectedCertCount) {
    console.error(`ERROR: Downloaded CA bundle is invalid or has insufficient certificates (${info.certCount} found)`);
    process.exit(1);
  }

  fs.writeFileSync(caPath, fetchedPem, "utf8");
  console.log(`Refreshed ${caPath}:`);
  console.log(`- Certificates: ${info.certCount}`);
  console.log(`- SHA-256: ${info.sha256}`);
  if (info.sha256 !== CA_BUNDLE_PROVENANCE.expectedSha256) {
    console.log(`NOTICE: Pinned hash differs from current upstream; update CA_BUNDLE_PROVENANCE if upstream rotated certificates.`);
  } else {
    console.log(`- Hash matches pinned provenance.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
