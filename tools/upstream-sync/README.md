# Upstream-Sync Tooling

This directory provides tooling for tracking, classifying, and syncing changes from upstream `paperclipai/paperclip` into `redesignhealth/paperclip`.

## Offline Dependencies & Sandbox Pods (TECH-9777)

In Kubernetes sandbox environments, runner pods operate under default-deny network egress policies where outgoing requests to public package registries like `npm` are blocked. To allow upstream-sync tooling to execute deterministically without runtime package installs:

1. **Vendored `pg` Driver**:
   - `pg` (pinned at `8.23.1`) and its direct transitives (`pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, etc.) are bundled offline into `tools/upstream-sync/vendor/pg.mjs` via esbuild.
   - Build scripts and verification checks run reproducibly in CI.
   - Third-party licenses and copyright notices are compiled into `tools/upstream-sync/vendor/THIRD_PARTY_NOTICES.md` directly from upstream source packages without placeholders.

2. **Pinned Amazon RDS CA Trust Bundle**:
   - Upstream source: `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
   - Canonical SHA-256 digest: `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`
   - Path: `tools/upstream-sync/global-bundle.pem`
   - Purpose: TLS server certificate validation for Amazon RDS / Aurora PostgreSQL instances without runtime downloads.
   - Review visibility: This bundle is committed without `linguist-generated` attributes so certificate changes are fully auditable during code review.

3. **Slice Architecture**:
   - **Slice 1 (PR #502)**: Vendors `pg` 8.23.1, generates authoritative third-party notices, pins the Amazon RDS root CA bundle with provenance and verification tooling, and adds scoped CI gates.
   - **Slice 2 (PR #484)**: Migrates upstream-sync runtime services and CLI scripts (`cli.mjs`, database clients) to use the vendored offline bundle and pinned CA bundle.

## Maintenance Commands

Run from `tools/upstream-sync`:

```bash
# Install tool dependencies (uses locked esbuild and pg)
npm ci

# Rebuild offline vendor bundle and third-party notices
npm run build:vendor

# Verify vendor bundle matches reproducible locked build
npm run check:vendor

# Verify pinned Amazon RDS CA bundle integrity
npm run check:ca

# Refresh Amazon RDS CA bundle from upstream AWS PKI endpoint
npm run refresh:ca

# Run scoped upstream-sync unit tests
npm test
```

From the repository root:

```bash
# Verify upstream-sync vendor bundle integrity
pnpm check:upstream-sync-vendor

# Run upstream-sync unit tests
pnpm test:upstream-sync
```
