# RH Agent Memory (`@redesignhealth/plugin-rh-agent-memory`)

Tenant-isolated per-agent key/value memory for Redesign Health's Paperclip
deployment. Replaces Paperclip's native per-agent storage mechanisms, none of
which enforce tenant isolation.

Linear: **TECH-6955** (parent TECH-6959).

## Why this exists

Two independent audits of the Paperclip source found no enforced tenant
isolation on any of the three native per-agent storage paths:

| Mechanism | Problem |
| --- | --- |
| `plugin_state` ("per-agent memory") | No `company_id` column anywhere; no ownership check in `server/src/services/plugin-state-store.ts` or `plugin-host-services.ts`. Plugin workers run instance-wide, so the host has no company context to check against — `plugin-host-services.ts` contains an explicit `ensurePluginAvailableForCompany` no-op commented "Plugins are instance-wide in the current runtime". |
| `plugin_entities` | Has a `company_id` column, but the plugin SDK write path (`ctx.entities.upsert`) cannot populate it, so every row lands `NULL`. A `NULLS NOT DISTINCT` unique index then lets two companies writing the same `(entityType, externalId)` silently overwrite each other. Reads have no company filter. |
| `database.namespace` | The registry has no company/agent column *by design* — scoping is 100% the plugin author's job. The one shipped example does its SQL scoping correctly but sources `company_id` from a model-supplied tool parameter (see below), so it is exploitable anyway. |

So we use `database.namespace` — the only one where correct isolation is even
*possible* — and do the scoping ourselves.

## The one hard rule

> **Tenant identity comes from the host-validated `runContext`, never from a
> caller-supplied parameter.**

`server/src/services/tool-gateway.ts` builds `runContext` from the server-side
gateway session and validates `actor.companyId === runContext.companyId` before
a plugin tool runs. That makes `runContext` trusted. It does **not** cross-check
`requestedParameters.companyId`, so `params` is attacker-controlled — an agent
under prompt injection can put any company's UUID there.

The shipped reference plugin `plugin-llm-wiki` gets this wrong. From
`packages/plugins/plugin-llm-wiki/src/wiki/core.ts`:

```ts
}, async (params: unknown): Promise<ToolResult> => {
  const input = params as ToolParams;
  const companyId = requireString(input.companyId, "companyId");
```

The handler does not even accept the `runCtx` argument. All ten of its tools do
this, and its manifest declares `required: ["companyId", ...]`. That is the
exact vulnerability class this package exists to make impossible.

## How the rule is enforced

Two layers, both in `src/tenant.ts`, both covered by tests:

1. **Ignore** — `resolveTenant()` accepts *only* a `ToolRunContext`. It has no
   parameter through which `params` could reach it, so this is a type-level
   guarantee rather than a convention. A `Tenant` is only constructible by
   `resolveTenant`, and handlers receive `(params, tenant)` — never `runCtx` —
   so a future handler cannot start trusting something else.
2. **Reject** — `assertNoTenantParams()` fails the call, before any SQL runs, if
   the caller supplied any tenant-identity-shaped parameter (`companyId`,
   `company_id`, `companyID`, `company-id`, `agentId`, `tenantId`, `scopeId`,
   `runId`, `projectId`, `userId`, …). Rejection is unconditional — even a
   parameter that *matches* the real `runContext` is refused, because a model
   sending tenancy at all is a signal worth surfacing. Every rejection is
   written to `ctx.activity.log` against the caller's own host-validated
   company, so an injection attempt leaves an audit trail instead of failing
   silently.

Additionally: every SQL statement filters on both `company_id = $1` and
`agent_id = $2` with bound parameters, the upsert's `ON CONFLICT` targets the
`(company_id, agent_id, memory_key)` unique index so it can never reach another
tenant's row, and no tool's `parametersSchema` declares a tenant property
(`additionalProperties: false` everywhere).

## Tenancy model

One Paperclip company per RH employee, so `company_id` alone is a sufficient
tenant key; `agent_id` narrows further to a single agent's memory. No agent
ownership grants are consulted.

## Schema

Postgres schema `plugin_rh_agent_memory_ce4b575f82`, which is the host-derived
namespace `plugin_${namespaceSlug}_${sha256(pluginId).slice(0, 10)}` (see
`server/src/services/plugin-database.ts#derivePluginDatabaseNamespace`). The
migration must hardcode it; `tests/host-contract.spec.ts` asserts the hardcoded
value still matches the host's derivation.

```sql
CREATE TABLE plugin_rh_agent_memory_ce4b575f82.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  memory_key text NOT NULL,
  value_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_key_not_blank CHECK (length(btrim(memory_key)) > 0),
  CONSTRAINT agent_memory_key_max_len CHECK (length(memory_key) <= 512),
  UNIQUE (company_id, agent_id, memory_key)
);

CREATE INDEX agent_memory_tenant_idx
  ON plugin_rh_agent_memory_ce4b575f82.agent_memory (company_id, agent_id);
CREATE INDEX agent_memory_tenant_updated_idx
  ON plugin_rh_agent_memory_ce4b575f82.agent_memory (company_id, agent_id, updated_at DESC);
```

Every column in the tenant key is `NOT NULL` deliberately: `plugin_entities`
permits a `NULL` `company_id`, which combined with `NULLS NOT DISTINCT` is how
cross-tenant overwrites happen there.

## Tools

| Tool | Parameters | Notes |
| --- | --- | --- |
| `memory_get` | `key` | Returns `{ found, key, value, createdAt, updatedAt }`. |
| `memory_set` | `key`, `value` | Upsert. `value` is any JSON, max 256 KB encoded. |
| `memory_delete` | `key` | Returns `{ key, deleted }`. |
| `memory_list` | `limit?` | Default 100, max 500, ordered by key. |

No tool takes a company or agent parameter. That is not an oversight.

## Capabilities

`agent.tools.register`, `database.namespace.migrate`,
`database.namespace.read`, `database.namespace.write`, `activity.log.write`.

`database.coreReadTables` is `["companies"]` and only so the migration's
`ON DELETE CASCADE` foreign key is accepted by the host's migration validator
(which requires every non-namespace reference to be a whitelisted `public.*`
table). No runtime query reads or joins a core table. There is no UI surface, so
the tool gateway — where `runContext` is host-validated — is the only way in.

## Tests

```bash
pnpm --filter @redesignhealth/plugin-rh-agent-memory test
pnpm --filter @redesignhealth/plugin-rh-agent-memory typecheck
pnpm --filter @redesignhealth/plugin-rh-agent-memory build
```

No Postgres required. This mirrors `plugin-llm-wiki`'s own approach — the
in-memory SDK harness (`createTestHarness` from
`@paperclipai/plugin-sdk/testing`) plus a monkey-patched `ctx.db` — with one
upgrade. The SDK harness's `ctx.db.query` always returns `[]`, which cannot
distinguish "correctly scoped out" from "query never ran", so
`tests/fake-db.ts` is a real in-memory store keyed by the **bound SQL
parameters**. If a handler ever sourced `company_id` from `params`, the bound
`$1` would change and the fake would hand back the foreign tenant's row. It
also throws on any statement not filtered by both `company_id = $1` and
`agent_id = $2`.

Two suites:

- `tests/tenant-isolation.spec.ts` — the attack tests, runContext validation,
  SQL scoping invariants, functional behavior, manifest contract.
- `tests/host-contract.spec.ts` — runs the manifest through the host's own
  `pluginManifestV1Schema` and every SQL statement through the host's
  `validatePluginMigrationStatement` / `validatePluginRuntimeQuery` /
  `validatePluginRuntimeExecute`. This caught a real defect on its first run
  (the `public.companies` FK was rejected with an empty `coreReadTables`), which
  the in-memory harness could not have detected.

### The attack test

`tests/tenant-isolation.spec.ts` simulates a prompt-injected agent in company B
passing company A's UUID as a tool parameter, and asserts the victim's data is
neither read, overwritten, nor deleted. It covers all four tools, nine
parameter aliases, cross-company and same-company-cross-agent, and asserts the
rejection is audited.

It has been **mutation-tested**: reintroducing the `plugin-llm-wiki` pattern
(preferring `params.companyId` over `runContext.companyId`) fails 15 tests,
including the cross-tenant read, write, and delete. The test is load-bearing,
not decorative.

## Code review checklist

Required for any change to this package. Also in the header of `src/tenant.ts`.

- [ ] No handler reads `companyId` / `agentId` / `company_id` / `agent_id` — or
      any alias — out of `params`.
- [ ] Every tool handler goes through `tenantScoped(...)`, i.e.
      `assertNoTenantParams(params)` then `resolveTenant(runCtx)`.
- [ ] Every SQL statement filters on **both** `company_id = $n` and
      `agent_id = $n`, bound from the resolved `Tenant`, never interpolated.
- [ ] Any new table has `company_id NOT NULL`, `agent_id NOT NULL`, and a
      unique constraint whose leading columns are the tenant key.
- [ ] No `parametersSchema` declares a tenant-identity property, and
      `additionalProperties` stays `false`.
- [ ] Any new tool ships with its own cross-tenant-parameter-injection test.
- [ ] `tests/host-contract.spec.ts` still passes — new SQL is accepted by the
      host's real validators, not just by our fake.

## Deviations from the ticket

The ticket offered two shapes: (1) `database.namespace` inside Paperclip's
Postgres, or (2) fully external storage via `http.outbound` / a direct DB
connection, and leaned toward (2).

**Built (1).** Reasons found in the source:

- The risk in option 2 is not actually lower. The plugin worker is the process
  that would hold the external connection, and it is the same process that must
  get the tenant key right. Whether the row lands in Paperclip's Postgres or
  ours, the only thing standing between tenants is "did this handler read
  `runContext` or `params`". Option 2 moves the data, not the decision.
- Option 1 gets real host-enforced guardrails that option 2 does not:
  `validatePluginRuntimeQuery` restricts `ctx.db.query` to a single `SELECT`
  inside our namespace, `validatePluginRuntimeExecute` restricts
  `ctx.db.execute` to namespace-local `INSERT`/`UPDATE`/`DELETE` and forbids
  referencing any other schema, and the migration runner checksums applied
  migrations and refuses changed ones. A raw `pg` client from the worker has
  none of that.
- Option 2 needs a separate database, secret distribution to every worker, and
  its own migration and backup story, for a benefit that reduces to "the bytes
  are somewhere else".
- `database.namespace` gives a private schema per plugin, so we are not sharing
  tables with Paperclip's unaudited isolation model. The audit findings are
  against `plugin_state` and `plugin_entities` specifically, not against the
  namespace mechanism, whose only documented property is that scoping is the
  author's job — which this package does, and tests.

Postgres RLS on `agent_memory` is a reasonable follow-up (see the companion RLS
ticket) if this ever holds PHI-adjacent data, as defence in depth behind the
application-level scoping. It is not a substitute for it: RLS would need a
session variable set from the same `runContext`, so it inherits the same
correctness requirement.
