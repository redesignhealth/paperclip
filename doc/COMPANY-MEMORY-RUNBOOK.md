# Tenant-Isolated Company Memory Runbook (TECH-6969 Phase 2)

This runbook documents the deployment, security posture, operations, state machine, and disaster recovery for Paperclip's tenant-isolated semantic memory infrastructure using dedicated per-company PostgreSQL databases with `pgvector` and `mem0`.

---

## 1. Architecture & Pilot Threat Model

### Pilot Shared-RDS Deployment Model
In the pilot phase, all company memory databases reside on a shared PostgreSQL instance (e.g. AWS RDS PostgreSQL 16+ or 17 with `pgvector` extension enabled):
- **Separate Database per Company**: Named deterministically as `pcmem_<hex32>` (derived from SHA-256 of the company UUID).
- **Dedicated Role per Company**: Named `pcmem_r_<hex32>` with attributes `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`.
- **Exclusive Ownership**: The role owns only its assigned company database and schema `public`.
- **Extension Strategy**: `pgvector` extension is preinstalled in `template1`. Target company databases inherit `vector` automatically on `CREATE DATABASE`; no `CREATE EXTENSION` is run by or in the target database context.
- **SCRAM-SHA-256 Verifier Generation**: High-entropy passwords (32 bytes base64url = 256 bits entropy) are transformed client-side into exact PostgreSQL `SCRAM-SHA-256` verifier strings (PBKDF2 HMAC-SHA256, 4096 iterations, 16-byte random salt). The SQL text sent to PostgreSQL contains **only** the verifier, never the plaintext password.
- **Credential Storage**: Passwords are encrypted and versioned in Paperclip's `company_secrets` subsystem (`local_encrypted` provider). No plaintext passwords or DSNs are stored in mapping tables or emitted in logs. If a company memory database is deprovisioned and subsequently reprovisioned, old soft-deleted secrets are bypassed and a fresh active secret is generated.

### Isolation Boundary & Accepted Residual Threat Model
Hermes runs locally as a non-interactive subprocess under `--yolo`, writing a run-scoped `0600` `mem0.json` into an isolated ephemeral temporary profile directory (`~/.hermes/profiles/paperclip-run-<id>/mem0.json`).
Because the local agent process can read its own configuration file, **the security boundary is database-enforced tenant isolation on the PostgreSQL server**, not obfuscating credentials from the agent itself. The tenant role must be strictly constrained from accessing:
1. Paperclip control plane databases (e.g. `paperclip`, `paperclip_prod`).
2. Maintenance/system databases (e.g. `postgres`, `template0`, `template1`).
3. Memory databases of other companies (`pcmem_<other_hex32>`).

#### Accepted Residual Risk: SCRAM-SHA-256 Verifier in DDL Logs & TLS Verification
- **Residual**: When PostgreSQL is configured with `log_statement=all`, the DDL statement `CREATE ROLE ... PASSWORD 'SCRAM-SHA-256$4096:...'` is captured in the database server query logs.
- **Analysis**: The verifier string is **not login-equivalent**: an attacker with access to the database query log cannot use the verifier directly to authenticate, because PostgreSQL SCRAM-SHA-256 authentication uses a mutual challenge-response protocol requiring the client to demonstrate possession of `ClientKey` derived from the raw password.
- **Offline Cracking**: The password is a cryptographically random 256-bit token (32 random bytes, encoded as 43 base64url characters). Offline brute-force cracking against PBKDF2 with 4096 iterations and 256 bits of entropy is mathematically infeasible.
- **Impersonation Capability**: Possession of `ServerKey` inside the verifier allows a rogue server to impersonate the PostgreSQL server to a connecting client. In Paperclip's architecture, clients connect via `sslmode=require` (and `rejectUnauthorized: false` on the admin DDL pool). While this encrypts wire traffic over the network, it does not perform full certificate chain validation against a trusted CA bundle (`verify-full`), so rogue server impersonation remains an accepted residual risk for pilot deployments.
  - *Tracking Ticket (TECH-6980)*: The upgrade path to `sslmode=verify-full` requires both a database migration updating the `company_memory_databases_sslmode_check` CHECK constraint (which currently enforces `sslmode = 'require'`) and configuration parser updates in `company-memory-config.ts` to accept trusted root CA bundle certificates.

---

## 2. Cluster-Wide `PUBLIC CONNECT` Security Gate

### The PostgreSQL Default Problem
By default, PostgreSQL grants `CONNECT` privilege on all newly created and default databases to the pseudo-role `PUBLIC`. If `PUBLIC CONNECT` remains active:
- Any valid role on the cluster (including `pcmem_r_<hex32>`) can connect to `postgres`, `template0`, `template1`, `paperclip`, or other company databases.
- Database-level isolation is **completely defeated**.

### Mandatory Cluster Hardening
Before enabling tenant memory isolation, database administrators **must** execute:
```sql
-- Preinstall vector in template1 so all newly created tenant DBs inherit it automatically
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

-- Revoke default public connect cluster-wide on existing databases
\connect postgres
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template0 FROM PUBLIC;
REVOKE CONNECT ON DATABASE paperclip FROM PUBLIC;

-- Explicitly grant connect only to authorized administrative/service users
GRANT CONNECT ON DATABASE paperclip TO paperclip_service_role;
GRANT CONNECT ON DATABASE postgres TO rds_superuser;
```

### Automated Preflight Gate
During `ensureProvisioned(companyId)`:
1. Paperclip creates the company role with SCRAM verifier, grants role membership to provisioner `WITH SET TRUE, INHERIT FALSE`, creates the database with `OWNER "pcmem_r_<hex32>"`, switches role via dedicated connection `SET ROLE "pcmem_r_<hex32>"`, revokes `CONNECT` on the new database from `PUBLIC`, grants `CONNECT` only to `"pcmem_r_<hex32>"`, and resets role.
2. Paperclip connects **as the newly minted company role** and verifies all invariants:
   - Tenant role authenticates successfully to target DB.
   - `pgvector` extension exists in target DB.
   - `PUBLIC` does not have `CONNECT` on target DB (`has_database_privilege('public', current_database(), 'CONNECT') = false`).
   - Tenant role has `CONNECT` on **NO OTHER DATABASE** in the cluster (including `postgres`, `template0`, `template1`, control-plane DBs).
   - Provisioner role does NOT retain permanent `CONNECT` on target database (`has_database_privilege(provisioner, current_database(), 'CONNECT') = false`), unless the provisioner is a true PostgreSQL superuser (`rolsuper = true`) where `CONNECT` is unrevocable (in which case a warning is logged).
3. If any check fails (e.g. `template0` or `postgres` has public connect, or a non-superuser provisioner retains connect), Paperclip **fails closed immediately**, disables connections, transitions the mapping status to `failed`, and throws `CompanyMemorySecurityIsolationError`. It will **never** claim isolation or mark the database `ready` on an unhardened cluster.

---

## 3. Durable Fenced Leases & State Machine

### State Machine Architecture
To prevent holding long database transactions across network DDL and secret encryption I/O, `company_memory_databases` uses a durable, cross-process fenced lease mechanism:
- **Operations**: `'idle' | 'provision' | 'rotate' | 'archive' | 'unarchive' | 'deprovision'`
- **Lease Tracking**: `lease_token` (UUID), `lease_owner`, `lease_acquired_at`, `lease_expires_at` (120-second TTL), `attempts`, `backoff_until`, `credential_epoch`.
- **Short Transactions Only**:
  1. *Lease Claim*: Atomic update with `WHERE lease_expires_at IS NULL OR lease_expires_at < now() OR lease_token = $token`.
  2. *External Work*: DDL operations and secret encryption run outside any database transaction block.
  3. *Fenced Commit*: Short transaction updating state with `WHERE id = $id AND lease_token = $token`. If lease expired or was superseded, the commit aborts safely.

### Stale Lease Reconciliation Sweep
To recover from crashed workers or network timeouts during active operations:
- **Synchronous Boot-Time Sweep**: At server boot before HTTP listeners bind, `reconcileStaleLeases()` runs synchronously. If this initial sweep fails, server startup is blocked (fail-closed / startup-blocking).
- **Background Periodic Reconciliation**: A background timer runs `reconcileStaleLeases()` every 60 seconds (registered with drain tracking for graceful server shutdown).
- **Transition Semantics**: For any row where `lease_expires_at < now()` and `operation != 'idle'`:
  - `provision`: transitions status to `failed`, sets `operation = 'idle'`, clears lease.
  - `rotate`: if a `pending_secret_version` was staged, transitions status to `failed` (retaining pending metadata for crash recovery); if staged before verifier preparation, resets status to `ready`. Sets `operation = 'idle'`, clears lease.
  - `archive`: resets status to `ready`, sets `operation = 'idle'`, clears lease.
  - `unarchive`: resets status to `archived`, sets `operation = 'idle'`, clears lease.
  - `deprovision`: transitions status to `failed`, sets `operation = 'idle'`, clears lease.
- **Idempotency & Concurrency**: Updates use an atomic CAS conditioned on `WHERE id = $id AND lease_token = $token`, ensuring concurrent sweeps or active workers never clobber superseded lease tokens.

### Status Lifecycle & State Variants
The `company_memory_databases.status` column supports the following states:
- `pending`: Initial record created, awaiting provisioning.
- `ready`: Successfully provisioned, preflight ACL checks passed, actively serving traffic.
- `failed`: Provisioning, rotation, or deprovisioning encountered an error. Stale lease sweeps or subsequent requests will attempt recovery.
- `archived`: Company has been archived; role has `NOLOGIN` and database has `ALLOW_CONNECTIONS false`.
- `deprovisioning`: Reserved in the database CHECK constraint for asynchronous multi-step deprovisioning workflows. In the current synchronous implementation, deprovisioning transitions directly to `deprovisioned` upon success or `failed` upon error.
- `deprovisioned`: Tombstone record retained after physical PostgreSQL database and role are dropped with `DROP DATABASE ... WITH (FORCE)` and `DROP ROLE`. Retained until the parent company deletion transaction completes.

### Recoverable Credential Rotation Protocol
1. Process claims lease for `operation = 'rotate'`.
2. If `pending_scram_verifier` exists from a prior crashed run, rotation converges using the existing pending verifier.
3. If no pending verifier exists, a new 32-byte password, 16-byte salt, and SCRAM verifier are generated.
4. A pending secret version is persisted in `company_secret_versions` with `status = 'disabled'`, and `pending_scram_*` metadata is committed to the lease row.
5. Outside the database transaction, `ALTER ROLE "pcmem_r_<hex32>" WITH PASSWORD '<verifier>'` is executed.
6. The new credentials are authenticated against the database.
7. A short fenced transaction activates the pending secret version to `status = 'current'`, demotes the previous version to `'archived'`, advances `secret_version`, updates `last_rotated_at`, advances `credential_epoch`, and clears pending metadata.
8. If runtime `resolveRuntimeConfig` encounters an in-flight rotation or pending secret, it automatically attempts recovery or fails closed; it **never** returns a stale credential. If rotation fails prior to staging the pending verifier, the row retains its `ready` status rather than being wedged in `failed`.

---

## 4. Configuration & Feature Flags

### Environment Variables
| Variable | Description | Default |
|---|---|---|
| `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` | Master switch for tenant memory database isolation (`"true"` only) | `false` |
| `PAPERCLIP_MEMORY_ADMIN_DATABASE_URL` | Privileged admin connection URL (`postgres://admin:pass@host:5432/postgres?sslmode=require`) | *(none)* |
| `PAPERCLIP_MEMORY_PILOT_COMPANIES` | Mandatory non-empty, comma-separated company UUID allowlist (wildcard `*` forbidden) | *(none)* |

### Fail-Closed Startup Validation
At server boot (before HTTP listeners bind):
- If `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` is set:
  - It accepts **only** exact lowercase `"true"` or `"false"` (or unset/empty). Values such as `"False"`, `"0"`, or `"off"` throw `CompanyMemoryConfigurationError` and halt startup.
- If `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` is true:
  - Validates `PAPERCLIP_MEMORY_ADMIN_DATABASE_URL` is a valid `postgres:` or `postgresql:` URL with exactly one `sslmode=require` parameter.
  - Validates `PAPERCLIP_MEMORY_PILOT_COMPANIES` is non-empty and contains only valid UUIDs.
  - Any misconfiguration throws immediately and halts server startup.

### Rollback Procedure
If unexpected database contention or provisioning errors occur during pilot:
1. Set `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED=false` in the Paperclip environment (must be exact lowercase `"false"`).
2. Restart or reload Paperclip.
3. The adapter execution layer will cleanly omit `runtimeMemory`, allowing Hermes to operate without tenant memory databases (no host memory fallback is ever used). Note: company deletion while isolation is disabled is blocked if an un-deprovisioned tenant database exists, guarding against orphaned databases.

---

## 5. Operational Lifecycle & Maintenance

### 1. Zero-Downtime Credential Rotation
```typescript
const result = await companyMemoryDatabaseService(db).rotateCredential(companyId);
// Returns: { secretVersion: N+1, lastRotatedAt: Date }
```

### 2. Company Offboarding & Deletion
- **Archiving a Company**:
  Paperclip sets role `NOLOGIN`, alters database `ALLOW_CONNECTIONS false`, terminates active sessions via `pg_terminate_backend`, and transitions status to `archived`.
- **Reactivating a Company**:
  Paperclip restores `LOGIN`, re-enables `ALLOW_CONNECTIONS true`, runs preflight checks, and returns status to `ready`. If unarchiving fails, the company row remains archived and can be reconciled or retried.
- **Hard Deletion (`remove`)**:
  Paperclip terminates active sessions, executes `DROP DATABASE "pcmem_<hex32>" WITH (FORCE)`, `REVOKE ... FROM CURRENT_USER`, `DROP ROLE "pcmem_r_<hex32>"`, verifies absence in system catalogs, soft-deletes the secret, and retains the tombstone until the company hard-delete transaction completes. If `DROP DATABASE` completes but subsequent cleanup fails, the mapping is marked `failed` rather than `ready` to prevent resurrecting deleted state. If tenant isolation is disabled while a company memory row exists in a non-`deprovisioned` state, company deletion is rejected to prevent orphaning tenant infrastructure.

### 3. Backup and Disaster Recovery
- **Shared Instance Backup**: AWS RDS automated snapshots and point-in-time recovery (PITR) protect the shared instance.
- **Per-Tenant Logical Dump**:
  *Note:* Because the provisioner role is explicitly revoked from having `CONNECT` privileges on tenant databases as part of security preflight invariants, dumping with the provisioner or non-superuser admin will fail with a permission error. Furthermore, granting CONNECT to the provisioner role causes `assertPreflightInvariants` to fail closed because the provisioner must not have persistent access.
  To perform a per-tenant dump:
  1. **Primary Method (Tenant Role)**: Use the tenant role credentials `pcmem_r_<hex32>` (fetching the active password from Paperclip's `company_secrets` store):
     ```bash
     pg_dump -Fc -h <rds_host> -U pcmem_r_<hex32> -d pcmem_<hex32> -f /backup/pcmem_<hex32>.dump
     ```
  2. **Alternative Method (Dedicated Read-Only Replica Role)**: If using centralized automation, create a dedicated read-only backup role that has CONNECT and SELECT granted across the cluster or read from a physical RDS replica without granting the provisioner role CONNECT privileges.
- **Per-Tenant Logical Restore**:
  Because tenant roles lack `SUPERUSER` and `CREATEDB` privileges, the database must be created beforehand from `template1` (which already contains `pgvector`):
  1. Create the database from `template1` as an administrative user, then assume the tenant role (the database owner) before changing connect privileges, matching what the provisioner does. `REVOKE CONNECT` fails with `must be owner of database` if run as the admin user directly:
     ```sql
     CREATE DATABASE "pcmem_<hex32>" TEMPLATE template1 OWNER "pcmem_r_<hex32>";
     SET ROLE "pcmem_r_<hex32>";
     REVOKE CONNECT ON DATABASE "pcmem_<hex32>" FROM PUBLIC;
     GRANT CONNECT ON DATABASE "pcmem_<hex32>" TO "pcmem_r_<hex32>";
     RESET ROLE;
     ```
  2. Restore schema and data as the tenant role without creating database or extension objects:
     ```bash
     pg_restore --clean --if-exists --no-owner --no-privileges -h <rds_host> -U pcmem_r_<hex32> -d pcmem_<hex32> /backup/pcmem_<hex32>.dump
     ```

---

## 6. Capacity Planning & Production Placement

### Connection Budgeting on Shared RDS
- Each active Hermes run connects directly to the company database for memory operations. While mem0's PostgreSQL client opens connections during memory operations (typically ~3 connections per heartbeat process), lazy provisioning, health checks, and DDL operations can temporarily open up to 4–5 administrative connections from the Paperclip provisioner pool.
- Postgres `max_connections` on shared RDS must be sized according to:
  $$\text{Max Connections} \ge \text{Max Concurrent Hermes Heartbeats} \times 3 + \text{Paperclip Provisioner Pool (up to 5)} + \text{Paperclip Control Pool}$$
- For high-concurrency production deployments exceeding single-instance connection or memory limits, migrate from shared RDS to dedicated RDS instances per company tier or AWS Aurora Serverless v2 with tenant data partitioning.
