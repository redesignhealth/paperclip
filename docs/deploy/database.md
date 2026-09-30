---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling (transaction mode), disable prepared statements via the environment — no source edits needed:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

Related optional client tuning: `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_MAX_LIFETIME_SECONDS`, `DATABASE_APPLICATION_NAME`. Driver defaults apply when unset, except that idle pooled connections close after 60 seconds (`DATABASE_IDLE_TIMEOUT_SECONDS=0` keeps them open) and the pool reports `application_name=paperclip`. See [Connection pool settings](#connection-pool-settings).

## Connection Pool Settings

The server opens one postgres.js pool for its own queries (and a second one when `DATABASE_MIGRATION_URL` points at a different connection). Every setting is optional:

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_POOL_MAX` | `10` (driver) | Maximum pooled connections. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | Close a pooled connection after this much idle time. `0` keeps idle connections open forever (the driver default). |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `30` (driver) | Give up on a connection attempt after this long. |
| `DATABASE_MAX_LIFETIME_SECONDS` | 30–60 min, randomized (driver) | Recycle a pooled connection once it is this old. |
| `DATABASE_APPLICATION_NAME` | `paperclip` | Value of `application_name` in `pg_stat_activity`, so you can find Paperclip's backends: `SELECT * FROM pg_stat_activity WHERE application_name = 'paperclip';` |
| `DATABASE_PREPARED_STATEMENTS` | `true` (driver) | Set `false` behind a transaction-mode pooler (see above). |

The server ends its pools during shutdown (SIGINT/SIGTERM) and when startup fails after the pool was opened, so a restarting server does not leave idle backends behind. Size `max_connections` on the PostgreSQL side for at least `DATABASE_POOL_MAX` per server process plus your other clients.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.

## Tenant-isolation row-level security (TECH-6956)

Migration `0288_tenant_isolation_rls.sql` puts a `tenant_isolation` RLS policy
on every tenant-scoped table (185 of them; the list is derived from the schema
by `packages/db/src/rls.ts`). Each policy reads the trusted company id from the
`app.current_company_id` session variable:

- **Unset** — rows pass through unchanged. This is what makes the migration
  additive: migrations, the CLI, and background schedulers keep working
  untouched.
- **Set** — rows are filtered to that company. Reads silently return zero
  cross-tenant rows; writes that would cross the boundary raise.

The server binds the variable per unit of work: `assertCompanyAccess` records
the company it just authorized, plugin RPCs record theirs via
`ensureCompanyId`, and `createDb` emits the `set_config` at the start of each
transaction. `withCompanyScope(db, companyId, fn)` is the explicit primitive
for code with no ambient request to inherit from.

### Role requirements

**RLS does not apply to superusers or to roles with `BYPASSRLS`**, and no
table-level setting overrides that. Every policy is paired with `FORCE ROW
LEVEL SECURITY` so it does apply to the table *owner* (which Postgres
otherwise exempts, and which is the role Paperclip connects as) — but for the
backstop to mean anything, `DATABASE_URL` must point at a **non-superuser**
role without `BYPASSRLS`. The server logs a loud warning at boot when it is
not. Embedded PostgreSQL always trips this warning, by design: it runs as the
initdb bootstrap superuser.

### Boot check

The server verifies the policies are in force before serving traffic, so a
future upstream rebase that drops the migration fails loudly instead of
silently losing tenant isolation. `PAPERCLIP_RLS_BOOT_CHECK` controls it:

| Value | Behavior |
|-------|----------|
| unset | `error` on authenticated public deployments, `warn` otherwise |
| `error` | Refuse to start if any covered table is missing its policy |
| `warn` | Log and start anyway |
| `off` | Skip the check (logs a warning that there is no backstop) |
