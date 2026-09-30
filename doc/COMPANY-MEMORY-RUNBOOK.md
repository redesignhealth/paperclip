# Tenant-Isolated Company Memory Runbook (TECH-6969 Phase 2)

This runbook documents the deployment, security posture, operations, state machine, and disaster recovery for Paperclip's tenant-isolated semantic memory infrastructure using dedicated per-company PostgreSQL databases with `pgvector` and `mem0`.

---

## 1. Architecture & Pilot Threat Model

### Pilot Shared-RDS Deployment Model
In the pilot phase, all company memory databases reside on a shared PostgreSQL instance (e.g. AWS RDS PostgreSQL 16+ or 17 with `pgvector` extension enabled):
- **Separate Database per Company**: Named deterministically as `pcmem_<hex12>` (derived from SHA-256 of the company UUID).
- **Dedicated Role per Company**: Named `pcmem_r_<hex12>` with attributes `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`.
- **Exclusive Ownership**: The role owns only its assigned company database and schema `public`.
- **Extension Strategy**: `pgvector` extension is preinstalled in `template1`. Target company databases inherit `vector` automatically on `CREATE DATABASE`; no `CREATE EXTENSION` is run by or in the target database context.
- **SCRAM-SHA-256 Verifier Generation**: High-entropy passwords (32 bytes base64url = 256 bits entropy) are transformed client-side into exact PostgreSQL `SCRAM-SHA-256` verifier strings (PBKDF2 HMAC-SHA256, 4096 iterations, 16-byte random salt). The SQL text sent to PostgreSQL contains **only** the verifier, never the plaintext password.
- **Credential Storage**: Passwords are encrypted and versioned in Paperclip's `company_secrets` subsystem (`local_encrypted` provider). No plaintext passwords or DSNs are stored in mapping tables or emitted in logs.

### Isolation Boundary & Accepted Residual Threat Model
Hermes runs locally as a non-interactive subprocess under `--yolo`, writing a run-scoped `0600` `mem0.json` into an isolated ephemeral temporary profile directory (`~/.hermes/profiles/paperclip-run-<id>/mem0.json`).
Because the local agent process can read its own configuration file, **the security boundary is database-enforced tenant isolation on the PostgreSQL server**, not obfuscating credentials from the agent itself. The tenant role must be strictly constrained from accessing:
1. Paperclip control plane databases (e.g. `paperclip`, `paperclip_prod`).
2. Maintenance/system databases (e.g. `postgres`, `template0`, `template1`).
3. Memory databases of other companies (`pcmem_<other_hex12>`).

#### Accepted Residual Risk: SCRAM-SHA-256 Verifier in DDL Logs
- **Residual**: When PostgreSQL is configured with `log_statement=all`, the DDL statement `CREATE ROLE ... PASSWORD 'SCRAM-SHA-256$4096:...'` is captured in the database server query logs.
- **Analysis**: The verifier string is **not login-equivalent**: an attacker with access to the database query log cannot use the verifier directly to authenticate, because PostgreSQL SCRAM-SHA-256 authentication uses a mutual challenge-response protocol requiring the client to demonstrate possession of `ClientKey` derived from the raw password.
- **Offline Cracking**: The password is a cryptographically random 256-bit token (32 base64url characters). Offline brute-force cracking against PBKDF2 with 4096 iterations and 256 bits of entropy is mathematically infeasible.
- **Impersonation Capability**: Possession of `ServerKey` inside the verifier allows a rogue server to impersonate the PostgreSQL server to a connecting client. In Paperclip's architecture, clients connect via strict TLS (`sslmode=require`) to the verified RDS hostname, mitigating rogue server impersonation.

---

## 2. Cluster-Wide `PUBLIC CONNECT` Security Gate

### The PostgreSQL Default Problem
By default, PostgreSQL grants `CONNECT` privilege on all newly created and default databases to the pseudo-role `PUBLIC`. If `PUBLIC CONNECT` remains active:
- Any valid role on the cluster (including `pcmem_r_<hex12>`) can connect to `postgres`, `template0`, `template1`, `paperclip`, or other company databases.
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
1. Paperclip creates the company role with SCRAM verifier, grants role membership to provisioner `WITH SET TRUE, INHERIT FALSE`, creates the database with `OWNER "pcmem_r_<hex>"`, switches role via `SET ROLE "pcmem_r_<hex>"`, revokes `CONNECT` on the new database from `PUBLIC`, grants `CONNECT` only to `"pcmem_r_<hex>"`, and resets role.
2. Paperclip connects **as the newly minted company role** and verifies all invariants:
   - Tenant role authenticates successfully to target DB.
   - `pgvector` extension exists in target DB.
   - `PUBLIC` does not have `CONNECT` on target DB (`has_database_privilege('public', current_database(), 'CONNECT') = false`).
   - Tenant role has `CONNECT` on **NO OTHER DATABASE** in the cluster (including `postgres`, `template0`, `template1`, control-plane DBs).
3. If any check fails (e.g. `template0` or `postgres` has public connect), Paperclip **fails closed immediately**, disables connections, transitions the mapping status to `failed`, and throws `CompanyMemorySecurityIsolationError`. It will **never** claim isolation or mark the database `ready` on an unhardened cluster.

---

## 3. Durable Fenced Leases & State Machine

### State Machine Architecture
To prevent holding long database transactions across network DDL and secret encryption I/O, `company_memory_databases` uses a durable, cross-process fenced lease mechanism:
- **Operations**: `'idle' | 'provision' | 'rotate' | 'archive' | 'unarchive' | 'deprovision'`
- **Lease Tracking**: `lease_token` (UUID), `lease_owner`, `lease_acquired_at`, `lease_expires_at` (30-second TTL), `attempts`, `backoff_until`, `credential_epoch`.
- **Short Transactions Only**:
  1. *Lease Claim*: Atomic update with `WHERE lease_expires_at IS NULL OR lease_expires_at < now() OR lease_token = $token`.
  2. *External Work*: DDL operations and secret encryption run outside any database transaction block.
  3. *Fenced Commit*: Short transaction updating state with `WHERE id = $id AND lease_token = $token`. If lease expired or was superseded, the commit aborts safely.

### Recoverable Credential Rotation Protocol
1. Process claims lease for `operation = 'rotate'`.
2. If `pending_scram_verifier` exists from a prior crashed run, rotation converges using the existing pending verifier.
3. If no pending verifier exists, a new 32-byte password, 16-byte salt, and SCRAM verifier are generated.
4. A pending secret version is persisted in `company_secret_versions` with `status = 'disabled'`, and `pending_scram_*` metadata is committed to the lease row.
5. Outside the database transaction, `ALTER ROLE "pcmem_r_<hex>" WITH PASSWORD '<verifier>'` is executed.
6. The new credentials are authenticated against the database.
7. A short fenced transaction activates the pending secret version to `status = 'current'`, demotes the previous version to `'archived'`, advances `secret_version`, updates `last_rotated_at`, and clears pending metadata.
8. If runtime `resolveRuntimeConfig` encounters an in-flight rotation or pending secret, it automatically attempts recovery or fails closed; it **never** returns a stale credential.

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
- If `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` is true:
  - Validates `PAPERCLIP_MEMORY_ADMIN_DATABASE_URL` is a valid `postgres:` or `postgresql:` URL with `sslmode=require`.
  - Validates `PAPERCLIP_MEMORY_PILOT_COMPANIES` is non-empty and contains only valid UUIDs.
  - Any misconfiguration throws immediately and halts server startup.

### Rollback Procedure
If unexpected database contention or provisioning errors occur during pilot:
1. Set `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED=false` in the Paperclip environment.
2. Restart or reload Paperclip.
3. The adapter execution layer will cleanly omit `runtimeMemory`, allowing Hermes to operate without tenant memory databases (no host memory fallback is ever used).

---

## 5. Operational Lifecycle & Maintenance

### 1. Zero-Downtime Credential Rotation
```typescript
const result = await companyMemoryDatabaseService(db).rotateCredential(companyId);
// Returns: { secretVersion: N+1, lastRotatedAt: Date }
```

### 2. Company Offboarding & Deletion
- **Archiving a Company**:
  Paperclip sets role `NOLOGIN`, alters database `ALLOW_CONNECTIONS false`, terminates active sessions via `pg_terminate_backend`, and transitions status to `deprovisioned`.
- **Reactivating a Company**:
  Paperclip restores `LOGIN`, re-enables `ALLOW_CONNECTIONS true`, runs preflight checks, and returns status to `ready`.
- **Hard Deletion (`remove`)**:
  Paperclip terminates active sessions, executes `DROP DATABASE "pcmem_<hex>" WITH (FORCE)`, `REVOKE ... FROM CURRENT_USER`, `DROP ROLE "pcmem_r_<hex>"`, verifies absence in system catalogs, soft-deletes the secret, and retains the tombstone until the company hard-delete transaction completes. If deprovisioning fails, the deletion aborts and preserves company and mapping intact.

### 3. Backup and Disaster Recovery
- **Shared Instance Backup**: AWS RDS automated snapshots and point-in-time recovery (PITR) protect the shared instance.
- **Per-Tenant Logical Dump**:
  ```bash
  pg_dump -Fc -h <rds_host> -U <admin_user> -d pcmem_<hex12> -f /backup/pcmem_<hex12>.dump
  ```
- **Per-Tenant Logical Restore**:
  ```bash
  pg_restore -h <rds_host> -U <admin_user> -d pcmem_<hex12> /backup/pcmem_<hex12>.dump
  ```

---

## 6. Capacity Planning & Production Placement

### Connection Budgeting on Shared RDS
- Each active Hermes run connects directly to the company database for memory operations.
- Postgres `max_connections` on shared RDS must be sized according to:
  $$\text{Max Connections} \ge \text{Max Concurrent Hermes Heartbeats} \times 3 + \text{Paperclip Control Pool}$$
- For high-concurrency production deployments exceeding single-instance connection or memory limits, migrate from shared RDS to dedicated RDS instances per company tier or AWS Aurora Serverless v2 with tenant data partitioning.
