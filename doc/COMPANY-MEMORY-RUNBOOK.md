# Tenant-Isolated Company Memory Runbook (TECH-6969 Phase 2)

This runbook documents the deployment, security posture, operations, state machine, and disaster recovery for Paperclip's tenant-isolated semantic memory infrastructure using dedicated per-company PostgreSQL databases with `pgvector` and `mem0`.

The native rollout path is separate from the parked hosted probe harness. Hermes
resolves a company's `OPENAI_API_KEY` secret reference into the adapter
environment, and the Hermes child passes it to mem0. The platform-default
OpenAI onboarding path is a separate, lazy agent-creation behavior described
below; it does not change this memory rollout's database or credential model.

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
-- (On AWS RDS, template0 was observed with PUBLIC CONNECT but `datallowconn=false`, so nobody can connect to it.
-- The preflight ignores databases with `datallowconn=false` for that reason (TECH-7126), so on RDS the template0
-- line is not needed for the check to pass. On a self-managed cluster, run it.)
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
8. Runtime `resolveRuntimeConfig` enforces a strict validation-before-secrets policy: the embedding allowlist check executes immediately upon loading the row, before any rotation convergence, credential rotation, or secret reads.
   - For rows with valid, supported embeddings, if `resolveRuntimeConfig` encounters an in-flight rotation (`operation = 'rotate'`) or pending secret version, it attempts convergence via `rotateCredential`; it **never** returns a stale credential. If rotation fails prior to staging the pending verifier, the row retains its `ready` status rather than being wedged in `failed`.
   - **Unsupported embedding rows skip rotation convergence**: If a row has an unsupported embedding model or dimensions, `resolveRuntimeConfig` fails closed immediately with `UnsupportedMemoryEmbeddingError` (non-retryable, `maxAttempts: 0`) without attempting rotation convergence. A row mid-rotation (`operation = 'rotate'` or `pendingSecretVersion`) with unsupported embedding fields will remain pending until repaired via a verified operator plan. Do not advise blind field edits or blind manual rotation triggers, and do not claim automatic recovery always occurs for such rows.

---

## 4. Configuration & Feature Flags

### Environment Variables
| Variable | Description | Default |
|---|---|---|
| `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` | Master switch for tenant memory database isolation (`"true"` only) | `false` |
| `PAPERCLIP_MEMORY_ADMIN_DATABASE_URL` | Privileged admin connection URL (`postgres://admin:pass@host:5432/postgres?sslmode=require`) | *(none)* |
| `PAPERCLIP_MEMORY_COMPANY_SCOPE` | Exact case-sensitive `allowlist` or `all` eligibility mode | `allowlist` |
| `PAPERCLIP_MEMORY_PILOT_COMPANIES` | UUID list required in `allowlist`; optional in `all`; wildcard `*` is always invalid | *(none)* |

### Platform-default OpenAI onboarding

When the platform default is configured, the control plane accepts the private
startup-only environment variable `PAPERCLIP_DEFAULT_OPENAI_API_KEY`. It
captures the value once, validates it, and removes that variable from the
server environment before normal child-environment copies are made. A missing,
blank, or invalid value only reports that the default is unavailable; it does
not fall back to ambient `OPENAI_API_KEY`. The scrub is an environment
propagation filter, not a hostile-process or `/proc` sandbox, and is not a
claim of memory zeroization.

The default is applied lazily and only when the central service creates a new
`hermes_local` agent. It requires the normal authorization for company and
agent creation. If the caller supplies an explicit agent `OPENAI_API_KEY`
value (including an empty, null, or malformed value), the existing normalizer
and provider-selection behavior remains authoritative; the platform default
does not repair or replace it. Company creation, startup sweeps, backfills,
existing agents, manual bindings, custom company keys, and non-Hermes adapter
types are unchanged.

For a new eligible Hermes agent, Paperclip creates or reuses one company-
scoped, Paperclip-managed `OPENAI_API_KEY` secret, then binds the agent to its
latest version. Reuse is metadata-only: an active matching company secret is
reused without fetching or redisplaying its value. Archived, disabled, or
revoked secrets are not reactivated, and a seeded name occupied by a different
key is skipped. The company secret remains the supported rotation boundary;
redeploying the server never overwrites an existing company secret or agent
binding. Rotate an existing secret through the supported Company Secrets
API/UI, with the binding following its latest version.

This onboarding path only supplies the OpenAI credential needed by Hermes
memory and OpenAI models. Anthropic, OpenRouter, and other model providers
still require their own valid credentials; it does not change Hermes's model
provider default or create an Anthropic default. Hermes memory remains
`hermes_local`-only, and the default memory toolset is all memory tools unless
the agent explicitly excludes tools.

The shared vendor credential is intentionally available to authorized agents
in the company and therefore shares provider billing, quota, and project
resources. Operators should use a restricted runtime project and model/rate/
budget caps rather than a broad organization-admin key. This feature does not
by itself prove perfect tenant isolation, sandbox isolation, or provider
project separation; the per-company memory database and role credentials
remain distinct tenant controls.

For DEV infrastructure, keep the onboarding gate disabled until the deployed
image has the environment-scrubbing guard. The planned ECS injection reads
the configured `openai-api-key` parameter by its existing secret ARN and
projects its value only into `PAPERCLIP_DEFAULT_OPENAI_API_KEY`; it does not
add a new server-side parameter lookup or expose the value in logs, UI,
health, or audit records. Updating the parameter affects future task starts;
existing company secrets are not reseeded automatically. The current DEV
manual-key and memory smoke paths remain valid, but automatic onboarding is
not evidence of a live hosted rollout until that image/IaC gate is enabled.

### Fail-Closed Startup Validation
At server boot (before HTTP listeners bind):
- `PAPERCLIP_MEMORY_COMPANY_SCOPE` is validated even when memory is disabled; only exact lowercase `allowlist` or `all` is accepted.
- If `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` is set:
  - It accepts **only** exact lowercase `"true"` or `"false"` (or unset/empty). Values such as `"False"`, `"0"`, or `"off"` throw `CompanyMemoryConfigurationError` and halt startup.
- If `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED` is true:
  - Validates `PAPERCLIP_MEMORY_ADMIN_DATABASE_URL` is a valid `postgres:` or `postgresql:` URL with exactly one `sslmode=require` parameter.
  - In `allowlist` mode, validates a non-empty UUID-only pilot list. In `all` mode, the list may be empty or omitted, but any supplied entries must be UUIDs.
  - Any misconfiguration throws immediately and halts server startup.

### Rollback Procedure
If unexpected database contention or provisioning errors occur during pilot:
1. Set `PAPERCLIP_MEMORY_TENANT_ISOLATION_ENABLED=false` in the Paperclip environment (must be exact lowercase `"false"`).
2. Restart or reload Paperclip.
3. The adapter execution layer omits `runtimeMemory`, allowing Hermes to operate without tenant memory databases; no host-memory fallback is used. The `all` scope remains valid while the master switch is false, but memory is off and the admin secret is not projected. Company deletion while isolation is disabled is blocked if an un-deprovisioned tenant database exists, guarding against orphaned databases.

### Native rollout scope

Only the supported `hermes_local` adapter consumes this runtime memory contract;
universal company eligibility does not add memory to Claude, Codex, gateway, or
other adapters. A configured company secret reference is required for the
provider key used by a native memory run. Missing-key JSON is a readiness/config
failure, not a reason to silently skip memory or distribute a shared key.

The native local E2E harness uses disposable local PostgreSQL/Paperclip
containers and generated local credentials. It can accept provider key values
or SSM parameter names in-process, but it does not test a remote dev endpoint,
and its auth bootstrap must not be reused as hosted auth evidence. Its default
mode-0700 work directory and mode-0600 secret material are deleted on exit;
`E2E_KEEP=1` retains credentials and should not be recommended with real keys
without an approved security procedure.

The native universal test uses two owned synthetic companies and does not wake
a real agent. The local harness destroys its disposable database/containers on
exit by default; a hosted/native canary must instead retain the two records and
archive them rather than deleting/deprovisioning them. The native suite currently reports the pinned
Hermes `0.21.3` memory toolset group and trace assertions, but those tool claims
are source/test evidence—not a hosted production proof.

---

## 5. Operational Lifecycle & Maintenance

### 5.1. Zero-Downtime Credential Rotation
```typescript
const result = await companyMemoryDatabaseService(db).rotateCredential(companyId);
// Returns: { secretVersion: N+1, lastRotatedAt: Date }
```

### 5.2. Company Offboarding & Deletion
- **Archiving a Company**:
  Paperclip sets role `NOLOGIN`, alters database `ALLOW_CONNECTIONS false`, terminates active sessions via `pg_terminate_backend`, and transitions status to `archived`.
- **Reactivating a Company**:
  Paperclip restores `LOGIN`, re-enables `ALLOW_CONNECTIONS true`, runs preflight checks, and returns status to `ready`. If unarchiving fails, the company row remains archived and can be reconciled or retried.
- **Hard Deletion (`remove`)**:
  Paperclip terminates active sessions, executes `DROP DATABASE "pcmem_<hex32>" WITH (FORCE)`, `REVOKE ... FROM CURRENT_USER`, `DROP ROLE "pcmem_r_<hex32>"`, verifies absence in system catalogs, soft-deletes the secret, and retains the tombstone until the company hard-delete transaction completes. If `DROP DATABASE` completes but subsequent cleanup fails, the mapping is marked `failed` rather than `ready` to prevent resurrecting deleted state. If tenant isolation is disabled while a company memory row exists in a non-`deprovisioned` state, company deletion is rejected to prevent orphaning tenant infrastructure.

### 5.3. Backup and Disaster Recovery
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

### 5.4. Agent-Scoped Mem0 Scope Migration (TECH-8191)

To isolate Mem0 memories per agent rather than sharing a global `"company"` scope, Mem0 uses `user_id = agent.id` instead of `"company"`.

#### Operational Rules & Cutover Architecture

- **Gated Runtime Scoping**: Runtime scoping is gated behind BOTH the `agent-scoped-mem0` hardening flag AND a per-company completion marker (`company_memory_databases.scope_migration_completed_at`). The flag alone has NO operational effect on any company without its completion marker: recall stays company-scoped (`user_id = 'company'`) and emits a warning naming the company ID only.
- **Live, no-outage cutover**: Every legacy row carries `payload.agent_id`; a write from a pre-flip run arriving after the flip can be routed and converted by a later catch-up sweep. Staging uses separate tables, and publish inserts the live row and marks its staging row published in one transaction. Do not set the tenant role to `NOLOGIN` or terminate tenant connections.
- **Flag scope**: `agent-scoped-mem0` is per agent, never server-wide. A server-environment setting switches every Hermes agent in every company at once. For a narrow pilot, set it in that agent's `adapterConfig.env`; adapter environment updates replace the whole environment, so resend every existing key.
- **Flag and marker are both required**: A marker without the flag still reads company scope; a flag without the marker reads company scope and warns. The marker is set only by `flip`, after publishable sources are converted and published.
- **Do not hand-edit migration fields**: Never edit `scope_migration_completed_at`, `scope_migration_mode`, or `scope_migration_agent_scope_observed_at`. The tools are the only supported path. A marker set while the upgrade is still `sweeping` cannot be cleared by any command; investigate instead.
- **Ordering**: Run `census`, then `sweep` and `publish` until every publishable source is complete, then `flip`, `drain`, and `verify`. `flip` refuses and names outstanding publishable sources. Quarantined sources never block `flip` and retain staging rows by design. See [COMPANY-MEMORY-LIFECYCLE-CLI.md](COMPANY-MEMORY-LIFECYCLE-CLI.md).
- **Automatic sync**: `mem0-auto-sync-off` disables Hermes' automatic end-of-turn Mem0 sync (run metadata and assistant replies); explicit `mem0_add` still works. It is per agent; absent the flag, behavior is unchanged.
- **Observation Evidence Column (`scope_migration_agent_scope_observed_at`)**:
  - The runtime observation recorder writes to `company_memory_databases.scope_migration_agent_scope_observed_at` when runtime memory is resolved for a run under agent scope (`user_id = agent.id`) in a migrated company, before adapter dispatch. It is recorded at runtime memory resolution before dispatch (it does not check run outcome) and is not proof of run success.
  - **Hourly Throttle**: To prevent database write amplification on every heartbeat run, updates to `scope_migration_agent_scope_observed_at` are throttled in the database query to at most once per hour (`lt(scopeMigrationAgentScopeObservedAt, cutoff)`).
  - **Observation, Not Cutover Verification**: This column is runtime telemetry evidence that an agent-scoped run was observed in the wild. It is NOT proof that all historical memories were migrated, that cutover verification succeeded, or that the run executed successfully.
   - **No Hand Edits**: Operators must not manually edit or clear `scope_migration_agent_scope_observed_at`.

#### State and command behavior

The lifecycle follows the state machine in §3. `census` is read-only. `sweep` converts legacy rows into staging using the company's OpenAI key and does not write the live collection. `publish` is the first live write and atomically inserts converted rows and marks them published; it refuses malformed staging. `flip` sets the marker and moves through `flipping` to `draining`; `--ack-agent-scope-flag` is an operator assertion, not proof. `drain` requires two clean probes at least 10 minutes apart, no unfinished pre-flip runs, and an observed agent-scoped run after the marker. `--max-drain-hours` exits non-zero and leaves state `draining`. `verify` gates `verified`; `--allow-quarantined` explicitly permits quarantined sources. `rollback` clears the marker before moving state, reports but never deletes agent-scoped rows, and is refused once pruning starts. `recover` is the supported atomic exit from `needs_recovery`, restores the recorded prior state, releases the lease, and never touches the marker. `status` and `prune` are not built; do not attempt them manually.

Rollback is near-final: re-upgrading after rollback creates a new upgrade, reconverts legacy content, incurs model cost, and publishes duplicate agent-scoped content alongside retained rows (TECH-8326).

#### Single-company pilot

Flip one company at a time and enable the flag in the intended agents' `adapterConfig.env`. After flip, an enabled agent loses access to memories written by other agents; this intended isolation is a real behavior change. While other agents continue writing company-scoped rows, `drain` and `verify` will typically not confirm. Never run prune on a partially flipped company; originals are retained.

#### Quarantine policy

Quarantined sources remain only in company scope and never reach agent scope. They keep staging rows forever by design. `verify` blocks on them unless `--allow-quarantined` is supplied. Do not routinely override this gate: decide and record a source-specific policy before using the override.

#### What verification does not prove

`verify` does not prove recall quality; that every agent observed agent scope (only at least one run is observed); that the observed run succeeded (observation occurs before dispatch); that no further company-scoped write can occur; that legacy rows are safe to delete; or that configuration is durable. Removing `agent-scoped-mem0` silently reverts reads to company scope.

#### Pre-enable checklist

Before the first production company enables the flag:
1. Run the read-only `census` and confirm the supported embedding pair; see §5.5.
2. Complete a real pinned Hermes run confirming config keys and per-agent `user_id`.
3. Deploy the parser code and rebuilt Hermes image containing patch 0002 (`TECH-8191-MEM0-AUTO-SYNC`) before any agent sets `mem0-auto-sync-off`.
4. Exercise recall and isolation tests, and rehearse rollback and `recover`.
5. When updating adapter environment, resend all existing keys.

### 5.5 Changing the Embedding Model (TECH-8193)

The external Hermes Mem0 OSS backend inspects the vector column dimension on start and, if it differs from the configured embedding dims, executes `DROP TABLE IF EXISTS <collection>` inside `suppress(Exception)`. A configuration change of embedding model or dimensions without a coordinated data migration will silently delete a company's memories.

To guard against silent data loss, Paperclip enforces an **explicit, unconditional** fail-closed allowlist check (`SUPPORTED_COMPANY_MEMORY_EMBEDDINGS`) in `resolveRuntimeConfig` before any credentials leave the heartbeat service. If a row's `(embedding_model, embedding_dimensions)` pair is not present in the allowlist, the run fails closed immediately with `UnsupportedMemoryEmbeddingError` (non-retryable, `maxAttempts: 0`). The runtime does not perform automatic model conversions, data migrations, or recovery for unsupported pairs.

#### Invariants & Operational Rules
- **Explicit guard is unconditional**: The allowlist check executes before any rotation convergence or secret dispatch. Any company record whose embedding pair is not explicitly present in `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS` fails closed on every run.
- **Never just edit configuration or replace allowlist in place**: Matching against `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS` is exact. Because the allowlist defines supported pairs, replacing an existing entry before all companies are migrated will immediately fail closed all unmigrated companies.
- **Provisioner default must be supported by allowlist**: Shipping a provisioner default change (`DEFAULT_COMPANY_MEMORY_EMBEDDING` in `@paperclipai/db`) without the pair being present in the allowlist will cause every newly provisioned company run to fail closed immediately.
- **Safe Expand/Contract Requirement**: Changing the embedding model cannot be done in a single breaking deploy. It requires a multi-phase expand/contract rollout across code and data.
- **pgvector dimension limits**: Note that `text-embedding-3-large` at 3072 dimensions exceeds `pgvector`'s 2000-dimension HNSW indexing limit for `vector` columns (PostgreSQL `pgvector` limits HNSW indexes to 2000 dimensions).

#### Preflight Census Requirement
Before ANY deployment that introduces the embedding guard, modifies `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS`, or alters `DEFAULT_COMPANY_MEMORY_EMBEDDING`, operators **must** run a read-only census on the Paperclip control-plane database to inspect existing model/dimension pairs and identify any unsupported rows:

```sql
-- 1. Grouped census: count existing embedding pairs across all tenant records
SELECT embedding_model, embedding_dimensions, count(*)
FROM company_memory_databases
GROUP BY embedding_model, embedding_dimensions;

-- 2. Identify unsupported or unexpected rows relative to target allowlist
-- Example: when allowlist expects ('text-embedding-3-small', 1536)
SELECT id, company_id, embedding_model, embedding_dimensions, status
FROM company_memory_databases
WHERE (embedding_model, embedding_dimensions) NOT IN (
    ('text-embedding-3-small', 1536)
);
```

If the census reveals any rows with unsupported pairs or unexpected NULL values, deployment must not proceed until those rows are investigated and remediated.

#### Read-Only Memory Upgrade Census CLI (TECH-8191)

Paperclip provides a strictly read-only inspection CLI to evaluate Mem0 memory data and estimate conversion budgets prior to upgrades:

```bash
pnpm memory:upgrade census --database-url <tenant-dsn> [options]
```

Key Options and Environment Variables:
- `--database-url <dsn>`: Tenant PostgreSQL DSN (or `COMPANY_MEMORY_DATABASE_URL` env var).
- `--control-plane-url <dsn>`: Paperclip control-plane DSN to verify company existence and agent routing (or `CONTROL_PLANE_DATABASE_URL` env var).
- `--company <uuid>`: Target company UUID (validated against control plane or derived names).
- `--prod`: Flag required alongside `MEMORY_UPGRADE_ALLOW_PROD=1` whenever target host is non-localhost.
- `MEMORY_UPGRADE_ALLOW_PROD=1`: Environment variable required alongside `--prod` for non-local database hosts.

> **Production Safety Notice**: Host locality is not proof of environment. A production database reached over an SSH tunnel or port-forward presents as a local host and will not trigger this gate. Always verify connection targets before running operational tooling.

#### Conversion Sweep (TECH-8191)

Paperclip provides an online, tenant-isolated sweep command to classify legacy company-scoped Mem0 memories, convert substantive records into atomic sentences, re-embed them, and record outcomes in the tenant upgrade ledger and staging table:

```bash
pnpm memory:upgrade sweep \
  --database-url <tenant-dsn> \
  --control-plane-url <cp-dsn> \
  --company <uuid> \
  --confirm <uuid> \
  [options]
```

Key Options and Safety Rules:
- `--database-url <dsn>`: Tenant PostgreSQL DSN (or `COMPANY_MEMORY_DATABASE_URL` env var).
- `--control-plane-url <dsn>`: Control-plane PostgreSQL DSN (or `CONTROL_PLANE_DATABASE_URL` env var).
- `--company <uuid>`: Target company UUID (validated against control-plane binding).
- `--confirm <uuid>`: Required confirmation matching `--company` exactly; prevents accidental cutover execution.
- `--table <name>`: Target Mem0 collection table name (default: "mem0_memories").
- `--model <name>`: Converter LLM model (default: "gpt-5.4-mini").
- `--openai-key-file <path>`: External 0600 key file path (bypasses control-plane `company_secrets` resolution).
- `--page-size <int>`: Keyset page size for scanning sources (default: 1000).
- `--max-rows <int>`: Maximum number of live source rows to scan.
- `--max-cost-usd <num>`: Maximum cumulative cost in USD before aborting sweep. Capped at an operational maximum of $1,000,000 (same cap applies to every `--*-usd-per-mtok` price override). Internally, cost is tracked as a pure bigint nanodollar count (1 USD = 1,000,000,000 nanodollars) to avoid floating-point drift over a long-running sweep; the figure is an **operational estimate used to gate spend, not an OpenAI billing guarantee**.
- `--chat-rpm <int>`: Chat completions rate limit cap (RPM, default: 500).
- `--chat-tpm <int>`: Chat completions token limit cap (TPM, default: 200,000).
- `--embedding-rpm <int>`: Embeddings rate limit cap (RPM, default: 3,000).
- `--embedding-tpm <int>`: Embeddings token limit cap (TPM, default: 1,000,000).
- `--chat-input-usd-per-mtok <num>`: Override chat input price in USD per 1M tokens.
- `--chat-output-usd-per-mtok <num>`: Override chat output price in USD per 1M tokens.
- `--embedding-usd-per-mtok <num>`: Override embedding price in USD per 1M tokens.
- `--operator-label <text>`: Operator-provided label for upgrade record identification (1-64 characters matching `[A-Za-z0-9._:@-]`).
- `--output, --out <path>`: Write sweep report to external path (mode 0600, exclusive create).
- `--format <text|json>`: Output format: human summary (`text`, default) or JSON (`json`).
- `--pause-when-active-runs <n>`: Threshold of active runs (`queued`, `scheduled_retry`, `running`) at or above which the sweep pauses (default: 1, set to 0 to disable).
- `--active-run-poll-ms <int>`: Polling interval while waiting for active runs to subside (default: 15000ms).
- `--max-pause-seconds <int>`: Maximum total pause time allowed before failing closed with `paused_too_long` (default: 0 = unbounded).
- `--prod`: Flag required alongside `MEMORY_UPGRADE_ALLOW_PROD=1` for any non-localhost database host (enforced on both tenant and control-plane DSNs).

Operational Prerequisites:
- **Role restrictions**: The tenant role must NOT be a superuser and must NOT have `BYPASSRLS`. The role must have `SELECT` privilege on the live collection table, and `CREATE`/`USAGE` privileges to manage upgrade tables (`paperclip_memory_upgrade_ledger`, `paperclip_memory_upgrade_staging`, `paperclip_memory_upgrade_dedupe`, `paperclip_memory_upgrade_fence`). Pre-provisioning the tables and granting DML privileges alone (`SELECT, INSERT, UPDATE` on `paperclip_memory_upgrade_fence`, and `SELECT, INSERT, UPDATE, DELETE` on `paperclip_memory_upgrade_ledger`, `paperclip_memory_upgrade_staging`, and `paperclip_memory_upgrade_dedupe` for reconciliation deletes) is **not** sufficient under a non-owner role: `ensureUpgradeTables` issues `CREATE TABLE IF NOT EXISTS` and `CREATE [UNIQUE] INDEX IF NOT EXISTS` unconditionally, and PostgreSQL checks schema `CREATE` privilege and table ownership before the `IF NOT EXISTS` check. The tenant role must additionally own the four upgrade tables and hold `CREATE` on their schema, or table initialisation is refused. A grant failure during table initialisation surfaces as a raw `42501` and is recorded as `last_error = unexpected_failure` (CLI: `[unexpected_failure]`). Only a `42501` raised on the fence claim itself — `INSERT`/`UPDATE` on `paperclip_memory_upgrade_fence` — is recorded as `last_error = tenant_fence_claim_failed`. (A dedicated CREATE-privilege preflight that fails early with a bounded code is tracked in TECH-8222.) The control-plane role must have read/write access to upgrade tracking and agent tables.
- **pgvector search_path resolution**: pgvector must resolve in the tenant role's `search_path` (for example, not only in an `extensions` schema), allowing unqualified `vector(1536)` resolution. If the vector type resolves to a schema-qualified column type such as `extensions.vector(1536)`, the preflight check rejects the database and the sweep refuses with `UNSUPPORTED_VECTOR_TYPE` (`last_error = schema_init_failed`) before any upgrade row is opened on the control plane.
- **Tenant write fence**: every tenant write presents `(lease_token, fence_epoch)` from `paperclip_memory_upgrade_fence`. A stalled tenant round trip is bounded server-side inside the tenant transaction; if the worker process itself wedges, the control-plane backend is terminated by `idle_in_transaction_session_timeout` at roughly 20 s (`boundMs + 10 s`), releasing the control-plane row lock without operator action. A fence claim failure (`TENANT_FENCE_CLAIM_FAILED` / `last_error = tenant_fence_claim_failed`) can be caused by control-plane connectivity failures (e.g. `ECONNREFUSED`, `CONNECTION_CONNECT_TIMEOUT`, or terminated admission transactions) as well as tenant database unreachability, stalls, or missing role privileges on `paperclip_memory_upgrade_fence`; operators diagnosing this code must verify both control-plane connectivity and tenant database connectivity/privileges. A failed claim may still have committed a fence-epoch bump; this is safe — the epoch is held by no worker and the next successful claim supersedes it — but a successor that claimed in the interim will fail closed with `lease_fenced_out` and the upgrade will need one recovery cycle.
- **Ready binding**: The company memory database record (`company_memory_databases`) must have status `ready`. The sweep strictly refuses bindings in `pending`, `failed`, `deprovisioning`, or `archived` states.
- **Key Sourcing**: The OpenAI API key is sourced EXCLUSIVELY from either (a) the company-scoped `openai_api_key` secret in control-plane `company_secrets` (`local_encrypted` provider only; other providers must use `--openai-key-file`), or (b) an external key file via `--openai-key-file`. There is no third source and no programmatic dependency-injection shortcut in production code. External key files must reside outside the repository tree both lexically and under `realpath` resolution (a symlinked PARENT directory that resolves inside the repo is rejected, not just a symlinked leaf file); the leaf path is opened with a single `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` open (symlinks and indefinitely-blocking FIFOs are refused atomically, never via a separate stat-then-open step); the open file descriptor is `fstat`-checked to be a regular file with mode `0600`/`0400` (group/other bits strictly refused, and permissions are never auto-corrected/chmod'd); the descriptor's resolved identity (device+inode) is re-validated against a fresh `realpath` lookup so a pathname swap between validation and read cannot cause one file to be validated while a different file is read; and the content must be 20..512 printable non-whitespace ASCII characters. `process.env.OPENAI_API_KEY` is strictly ignored.
- **Lease release behaviour**: Upon successful sweep completion or clean error termination, the worker immediately stops the heartbeat timer and releases its lease on the upgrade record. A cleanly released upgrade does not lapse and remains claimable by future sweeps.
- **Crash-expiry and recovery**: If a worker crashes ungracefully without releasing, its lease expires after the lease TTL (default 10 minutes / 600s). Background reconciliation (`reconcileLapsedUpgradeLeases`) transitions the active upgrade to `needs_recovery`; future sweep attempts are refused with `STATE_MISMATCH`. Run the supported `pnpm memory:upgrade recover` command before resuming. `status` is not built; rollback has state-dependent refusal rules documented in §5.4 and the CLI reference.

> **WARNING: NON-TERMINAL SWEEP BLOCKS COMPANY DELETION**
> Every memory upgrade sweep creates or adopts an active non-terminal upgrade record in `sweeping` (or `needs_recovery`) state. The company deletion admission gate (`admitCompanyDeletion`) strictly refuses deletion while an active memory upgrade exists (`company_memory_upgrade_active`). Consequently, once a company is swept in this PR slice, it CANNOT be deleted until later lifecycle completion tooling ships.
>
> Use `--prod sweep` only after the §5.4 pre-enable checklist and tenant privilege preflight are complete. Even if tenant DDL fails during initialization (e.g., if the tenant role lacks CREATE privilege when executing `ensureUpgradeTables`), an active upgrade row may already exist on the control plane, leaving the company in a non-terminal upgrade state that blocks deletion until the lifecycle is recovered or completed. CREATE privilege preflight checks are tracked in TECH-8222; operators must ensure proper tenant database privileges before running sweep.
> NEVER perform manual SQL bypasses (e.g. deleting or mutating `company_memory_upgrades` rows) or attempt ad-hoc auto-clearing to work around deletion blocks. Manual tampering invalidates upgrade invariants and risks catastrophic memory corruption.

#### Publish (TECH-8191)

Paperclip provides a tenant-isolated, fenced publish command to copy staged converted memories into the live Mem0 collection table (`mem0_memories`) under `user_id = agent.id`:

```bash
# Preview (dry run): validates preflights and reports counts without mutation
pnpm memory:upgrade publish --database-url <tenant-dsn> --control-plane-url <cp-dsn> --company <uuid> --dry-run

# Confirmed run: inserts live rows and marks published_at under tenant fence
pnpm memory:upgrade publish --database-url <tenant-dsn> --control-plane-url <cp-dsn> --confirm <uuid> [options]
```

Full CLI options, verification SQL, and remediation are in [doc/COMPANY-MEMORY-PUBLISH-CLI.md](./COMPANY-MEMORY-PUBLISH-CLI.md).

Operational Prerequisites:
- **Tenant role permissions**: Must hold schema `CREATE` and own upgrade tables (`ensureUpgradeTables`).
- **Live table unique constraint**: The live table must have a unique index / PK on `id` (`LIVE_TABLE_ID_NOT_UNIQUE`).
- **Live table insertability**: No non-null columns without defaults beyond `id`, payload, vector (`LIVE_TABLE_NOT_INSERTABLE`).
- **Active upgrade state**: Must be in `sweeping` state with matching converter contract (`CONVERTER_CONTRACT_MISMATCH`).

What Publish Does and Does Not Do:
- **Does not prune**: Legacy company-scoped rows remain untouched in the live collection.
- **Does not flip runtime flags**: Neither `agent-scoped-mem0` nor `scope_migration_completed_at` is altered.
- **Quarantined sources**: Retained in staging and ledger; never pruned and never published.
- **Dropped / unroutable sources**: Unpublished staging and dedupe rows are cleared under tenant fence.
- **Row budget enforcement**: `--max-rows` bounds work at source granularity; a source's rows are never split across runs. If a source would exceed the remaining budget AFTER some rows were already consumed/published in the run, publish halts without advancing the cursor so the next run resumes there. If instead the very FIRST eligible source already exceeds `--max-rows` on its own (nothing consumed/published yet), publish refuses with `[INVALID_ARGUMENT]` rather than silently completing with zero rows published and stalling identically on every repeat run; increase `--max-rows` to at least that source's row count and re-run.
- **Atomic live batching**: Each batch commits live rows (`ON CONFLICT (id) DO NOTHING`) and sets `published_at = now()` in a single tenant transaction under fence.
- **Failure remediation**: Safe remediation for `LIVE_TABLE_ID_NOT_UNIQUE` (restore PK), `LIVE_TABLE_NOT_INSERTABLE` (add column defaults), `PUBLISH_LEDGER_INCONSISTENT` (re-run sweep), and `PUBLISH_CONFLICT_UNEXPECTED` (investigate ID collision).

Updated Invariants (PR4 Publish):
- **Invariant 1 (Staging & Publish Guarantee)**: Sweep stages with `published_at = NULL`. Publish inserts staged records with `outcome = 'published'` into live collection under `user_id = agent.id` and marks `published_at = now()` in a single tenant transaction under fence.
- **Invariant 4 (Authoritative Ledger vs. Cumulative Counters)**: `published_count` stays 0 during sweep, and increments honestly as batches commit during publish. Surviving published rows (`published_at IS NOT NULL`) are never deleted by tombstones or superseding.
- **Invariant 7 (Live Table Access)**: In sweep, access is strictly SELECT. In publish, access includes `INSERT INTO ... ON CONFLICT (id) DO NOTHING`. Zero UPDATE, DELETE, or DDL index modifications are issued against live collection.
- **Invariant 9 (Tenant Write Fencing)**: Live publish inserts and `published_at` marking commit in a single tenant transaction under fence. Publish batches take per-source L1 advisory locks in ascending canonical key order before validating fence (L1 before L2, batch size 100).

Operational Invariants:
1. **Staging-Only Guarantee (PR3b)**:
   - Routable, non-noise, non-sensitive rows are converted into 1 to 3 atomic memory sentences via `gpt-5.4-mini` and re-embedded via `text-embedding-3-small` (1536 dims).
   - Records are written to `paperclip_memory_upgrade_staging` with `published_at = NULL` (unambiguously not live).
   - In reports, logs, and CLI output, these are explicitly labeled **"staged (pending publish)"**, never "published".
   - **Zero rows are published to the live collection table.**
2. **Rate Limiting & Concurrency**:
   - Outgoing OpenAI API calls are rate-limited across dual token buckets (RPM and TPM for both chat and embeddings) with concurrency hard-capped at 2.
   - 429 and 5xx responses are retried using Retry-After-aware exponential backoff with jitter.
3. **Quarantine Halt & Resume**:
   - A row is quarantined if schema validation or repair retries fail.
   - The sweep halts immediately if quarantine threshold is exceeded: `quarantined > 50 || (considered >= 200 && quarantined / considered > 0.02)`.
   - On halt, the worker flushes cumulative counters with `last_error = "conversion_failed"`, prints a histogram of reject codes, stops the heartbeat, and cleanly releases its lease. The upgrade state remains `sweeping`.
   - Because already-ledgered rows are skipped on re-run, resuming a sweep after fixing upstream issues safely picks up from where it left off without re-evaluating or re-converting processed sources.
4. **Authoritative Ledger vs. Cumulative Activity Counters**:
   - The tenant database table `paperclip_memory_upgrade_ledger` is authoritative for source classifications, content hashes, and outcomes.
   - Counters on `company_memory_upgrades` (including `superseded_count`) record cumulative **activity**, tracking lifecycle transition events over time rather than a gauge of rows currently in that state.
   - `published_count` on `company_memory_upgrades` stays at **zero** throughout this sweep phase (including on the quarantine-halt flush path): this phase only ever *stages* records (`published_at` stays `NULL`); it never publishes to the live collection table, so there is nothing to attribute to that column yet. To see this phase's staged activity, use the report's `stagedPendingPublishCount`, or query the tenant ledger directly: `SELECT count(*) FROM paperclip_memory_upgrade_ledger WHERE upgrade_id = $1 AND outcome = 'published'` (these rows mean "staged, pending publish" in this phase's vocabulary, not "live").
   - When a source's content or agent routing changes between sweeps, `reconcileChangedContent` clears unpublished staging/dedupe rows for that source. If no staged-and-published rows remain afterward, the stale ledger entry is deleted so the source reclassifies cleanly; if published rows DO remain (a prior publish/flip step made them live), the ledger row is instead marked `superseded` and its `output_ids` are recomputed to reference exactly the surviving published rows, never left pointing at deleted ones.
   - **Reconciliation semantics**: `superseded` retains the live rows and now carries the new source content hash and agent. A `superseded` row is always re-convertible and is never treated as "unchanged" by a later sweep; `superseded_count` therefore increments exactly once per real change rather than on repeated sweeps.
   - **Ledger/staging referential invariant**: after every mutation (tombstone reconciliation, changed-content reconciliation, and both the "won" and "all-duplicate" branches of staging a source), `output_ids` on the relevant ledger row is recomputed directly from `paperclip_memory_upgrade_staging`, not assembled from only the ids touched by that single call. Every staging row that is still live is referenced by some ledger row; no staging row is ever orphaned, and no ledger row ever references a staging row that no longer exists.
5. **Sensitive Rows are Never Auto-Pruned**:
   - Sources identified by `detectSensitiveFamilies` (or sensitive pattern echoes on model output) are recorded with outcome `dropped_sensitive` and reason codes naming matched family categories (e.g. `apiKey,passwordAssignment`), never raw text.
   - A source can also be classified `dropped_sensitive` by the MODEL's own decision (no regex family matched the model's text, but the model itself judged the content sensitive). This case is recorded with the single exact reason code literal `model_classified` -- it is never combined with family tokens into a CSV, and is validated as a distinct bounded literal, not a looser pattern.
   - `dropped_sensitive` rows are **never** automatically pruned or published. They remain retained in the ledger for operator audit and manual inspection.
6. **Active-Run Quiescence, Polling Throttle, and Leases**:
   - The active-run gate throttles polling: active heartbeat runs are re-counted at most once every `active-run-poll-ms` (default 15,000ms / 15s) while scanning continues, avoiding excessive control-plane query load.
   - When active runs reach or exceed the threshold, the sweep pauses. While paused, lease heartbeat timers remain active and periodically renew the lease in the background (approximately every 2 minutes, or `min(120s, ttl/3)`), while the active-run gate sleeps in bounded 5-second slices and asserts lease health between slices. If the lease lapses or is lost, the sweep aborts cleanly.
   - Total paused duration is tracked accurately using a finally guard so all elapsed pause time is accounted for even if lease assertions or sleep intervals fail.
7. **Read-Only Access to Live Collection**:
   - The live Mem0 collection table is accessed **strictly via SELECT statements**.
   - No UPDATE, DELETE, INSERT, or DDL index modifications are ever issued against the live Mem0 collection table during sweep.
   - The live Mem0 collection table is accessed **strictly via SELECT statements**.
   - No UPDATE, DELETE, INSERT, or DDL index modifications are ever issued against the live Mem0 collection table during sweep.
8. **Cost Accounting: Preflight Ceiling Before Spend, Bigint Nanodollars, Page-Delta Flush**:
   - Before resolving any OpenAI API key or making any paid call for a given source, the sweep computes a worst-case nanodollar cost ceiling for that ONE source (up to 2 chat calls -- one initial plus one repair retry -- each capped at 600 output tokens, plus up to 3 embedding calls). The initial chat request is projected conservatively from its ACTUAL serialized request bytes (real system prompt, schema, wrapper tags, and source text). The repair retry echoes the model's first reply, which is unknown at preflight, so its echo is projected analytically rather than from actual bytes: the sweep serializes a base repair body with an empty echo and adds a heuristic allowance of 24 bytes per output token (assuming up to 4 chars per token expanding to up to 6 bytes under JSON `\u00XX` string escaping) across 600 max completion tokens (`PREFLIGHT_MAX_COMPLETION_TOKENS`), totaling 14,400 bytes (roughly 12,000 more input-token equivalents per source than a plain 4-bytes-per-token estimate). Embedding calls are also projected analytically from the maximum possible converted record size (up to 3 records capped at 400 characters at 4 UTF-8 bytes/char). All token projections use UTF-8 byte length as a conservative ceiling (never a fixed ASCII characters-per-token heuristic, which silently undercounts multi-byte Unicode). This conservative preflight ceiling does not change actual billed spend, though small `--max-cost-usd` budgets may refuse sources earlier than a naive estimate suggests. The 24-byte echo allowance is a heuristic, enforced fail-closed at runtime: before issuing a paid repair call, the actual serialized repair request body is built and compared against the projection (`isRepairRequestBodyOversize`); if oversize, the source is quarantined immediately without making the repair call. If spending the worst case would meet or exceed `--max-cost-usd`, the sweep aborts for that source with **zero** additional API calls.
   - All cost arithmetic is pure bigint nanodollars (1 USD = 1,000,000,000 nanodollars), using CEILING division against the per-million-token rate so a fractional nanodollar is never silently truncated away (e.g. 1 token at $0.15/M tokens is 150 nanodollars, not 1).
   - After each page of sources is processed, the sweep flushes ONLY that page's incremental cost delta to the control-plane counter (never the cumulative running total mislabeled as a delta), and resets its in-memory page-delta accumulator ONLY after that flush has durably succeeded -- so a failed flush never silently loses track of spend, and a page is never double-counted.
9. **Tenant Write Fencing (Cross-Database Takeover Protection)**:
   - In addition to the control-plane lease (`company_memory_upgrades.lease_token` / `lease_expires_at`), every tenant data-write transaction (ledger commits, staging, and reconciliation, including tombstone batches) validates a SEPARATE tenant-local fence row (`paperclip_memory_upgrade_fence`, one row per `upgrade_id`) carrying its own `(lease_token, fence_epoch)` pair, held under a `SELECT ... FOR SHARE` lock to commit. A mismatch throws `LEASE_FENCED_OUT` and the transaction rolls back with no partial writes.
   - This exists because the control-plane lease and the tenant database are never in the same transaction: a worker can hold a valid CP lease while its tenant connection stalls long enough for the CP lease to lapse and a successor to be admitted, and a naive tenant fence would let the original (by-then-stale) worker claim the fence LATER and supersede the legitimate successor. To close this, claiming/bumping the tenant fence (`claimTenantFenceGuarded`) is itself guarded by a control-plane row lock: the claimant must prove, under that lock, that it is STILL the verifiably current CP-admitted lease holder (matching token, `sweeping` state, unexpired) before the tenant fence is bumped, and the CP lock is held across the whole tenant round trip (bounded by a server-enforced `statement_timeout`) so a concurrent successor's admission blocks until the claim resolves one way or the other.
   - **Guarantee actually provided**: a worker whose CP admission has already been revoked by the time it takes the row lock can never win the tenant fence afterwards -- the "delayed stale claimant supersedes a legitimate successor" ordering bug is closed. This does **not** claim perfect cross-database atomicity (Postgres offers no multi-database atomic commit); the residual window is bounded to the time between CP admission validation and the tenant fence commit, during which no OTHER worker can also be mid-claim for the same upgrade (they serialize on the same CP row lock). The real guarantee this protocol provides should only be asserted as "a successor tenant takeover has definitively occurred" after that successor's own `claimTenantFenceGuarded` call has returned successfully, not merely after its CP lease claim.
   - Lock order within a single upgrade's data path (always acquired in this relative sequence to avoid lock-order deadlocks): the per-upgrade takeover advisory lock (held only while bumping the fence row during a claim), then a per-source advisory lock (ascending `source_id` order when a transaction touches more than one source, serializing two workers racing the same source's dedupe/ledger bookkeeping), then the fence row `FOR SHARE` lock, then ordinary data-table locks. Tombstone batches now take per-source L1 advisory locks in ascending canonical key order before validating the fence (L1 before L2), with default batch size 200 (reduced from 500 to bound per-transaction advisory locks in shared RDS instances where `max_locks_per_transaction` pools are shared).

#### Safe Expand/Contract Migration Procedure
Transitioning to a new embedding model or dimension must follow a multi-phase expand/contract lifecycle. The runtime does not support arbitrary live migrations; all data transitions require planned offline cutovers with operator verification. Never execute arbitrary or automatic production actions.

1. **Phase 1: Census and Expand Allowlist (Code Deploy)**
   - Run the read-only preflight census query above to verify the current state of all tenant records.
   - Deploy a code update that **expands** `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS` to contain **BOTH** the old and new `(model, dimensions)` pairs.
   - **Never replace the old entry before migration**: Both pairs must remain simultaneously valid in the running service so that existing companies continue serving traffic while new target collections are prepared.
   - At this stage, the provisioner default (`DEFAULT_COMPANY_MEMORY_EMBEDDING`) may remain on the old model, or be switched in coordination once the dual-allowlist is live.

2. **Phase 2: Offline Re-Embedding & Atomic Per-Company Swap (Data Migration)**
   - Because concurrent writes during active runs bypass control-plane locks, re-embedding must be performed under a **verified offline/quiesced cutover** per company (e.g., setting the tenant database role to `NOLOGIN` and draining active backends, matching §5.4 offline cutover guarantees).
   - Take a full per-tenant logical dump (`pg_dump -Fc`) of the affected memory database before touching any tables.
   - Create a new collection table (e.g., `<collection>_v2`) in the tenant database with the target vector dimensions.
   - Read existing memory records from the old collection and re-embed memory text from `payload->>'data'` using the new embedding model into the new collection table.
   - **Atomically swap per company**: In a single database transaction on the control plane, update `collection_name`, `embedding_model`, and `embedding_dimensions` together on the `company_memory_databases` row to point to the new collection table with its matching model and dimensions. Updating collection name without updating model/dimensions causes Hermes Mem0 to drop the new table on dimension mismatch.
   - Re-enable tenant access (`ALTER ROLE ... LOGIN`) and verify run execution.
   - **Retain old collection**: Retain the legacy collection table in the tenant database until the migration is fully verified, soaked, and rollback/retention requirements are satisfied.

3. **Phase 3: Coordinated Provisioner Default Switch (Code Deploy)**
   - Update the provisioner default (`DEFAULT_COMPANY_MEMORY_EMBEDDING` in `@paperclipai/db`) to the new embedding pair.
   - This phase occurs in a coordinated phase only while `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS` still supports **both** old and new pairs, ensuring that any companies newly provisioned under the old default prior to deploy remain fully valid and accounted for until the default switches.
   - Run the preflight census again to confirm newly provisioned rows and existing migrated rows align with expectations.

4. **Phase 4: Contract Allowlist (Code Deploy)**
   - Run the read-only census query. Confirm that the count of rows consuming the old embedding pair is **exactly zero** (`count = 0`).
   - Confirm that all operational verification, retention periods, and rollback windows for the old collections have elapsed.
   - Deploy a follow-up code change that removes the old `(model, dimensions)` entry from `SUPPORTED_COMPANY_MEMORY_EMBEDDINGS`, contracting the allowlist back to the active pair(s).

---

## 6. Capacity Planning & Production Placement

### Connection Budgeting on Shared RDS
- Each active Hermes run connects directly to the company database for memory operations. While mem0's PostgreSQL client opens connections during memory operations (typically ~3 connections per heartbeat process), lazy provisioning, health checks, and DDL operations can temporarily open up to 4–5 administrative connections from the Paperclip provisioner pool.
- Postgres `max_connections` on shared RDS must be sized according to:
  $$\text{Max Connections} \ge \text{Max Concurrent Hermes Heartbeats} \times 3 + \text{Paperclip Provisioner Pool (up to 5)} + \text{Paperclip Control Pool}$$
- For high-concurrency production deployments exceeding single-instance connection or memory limits, migrate from shared RDS to dedicated RDS instances per company tier or AWS Aurora Serverless v2 with tenant data partitioning.
