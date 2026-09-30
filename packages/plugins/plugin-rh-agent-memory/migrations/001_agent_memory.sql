-- RH Agent Memory — tenant-scoped per-agent key/value memory.
--
-- PRECONDITION FOR EDITING THIS FILE IN PLACE (2026-09-30, TECH-6955 PR #18,
-- Argus round 3): this migration has never been applied to any environment
-- -- it was introduced in this PR's own first commit and has no entry in any
-- plugin_migrations/journal tracker anywhere in this repo (verified via
-- repo-wide search prior to the agent_memory_agent_id_idx addition below).
-- The host's per-migration checksum guard (plugin-database.ts) only matters
-- once a migration has actually executed somewhere; editing an unapplied
-- migration in place is safe. Once this migration HAS been applied anywhere
-- (including a developer's local install), stop editing this file --
-- any further change must be a new NNN_*.sql migration instead.
--
-- The schema name below is the host-derived plugin namespace for plugin key
-- "redesignhealth.plugin-rh-agent-memory" with namespaceSlug "rh_agent_memory":
--   plugin_${slug}_${sha256(pluginKey).slice(0, 10)}
-- See server/src/services/plugin-database.ts#derivePluginDatabaseNamespace.
--
-- Tenancy contract: one Paperclip "company" per RH employee, so company_id is a
-- sufficient tenant key. agent_id narrows further to a single agent's memory.
-- Every column in the uniqueness/lookup key is NOT NULL on purpose: Paperclip's
-- native plugin_entities table allows NULL company_id and uses a
-- NULLS NOT DISTINCT unique index, which is how cross-tenant overwrites happen
-- there. We refuse to allow a NULL tenant key at all.

-- IF NOT EXISTS guards make a partial-migration-then-retry idempotent instead
-- of failing with a relation-already-exists error.
CREATE TABLE IF NOT EXISTS plugin_rh_agent_memory_ce4b575f82.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  memory_key text NOT NULL,
  value_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_key_not_blank CHECK (length(btrim(memory_key)) > 0),
  CONSTRAINT agent_memory_key_max_len CHECK (length(memory_key) <= 512),
  UNIQUE (company_id, agent_id, memory_key)
);

-- No `agent_memory_tenant_idx` on (company_id, agent_id) here: the UNIQUE
-- (company_id, agent_id, memory_key) constraint above already provides this
-- as a B-tree leading-columns index, so a separate index would just be
-- redundant write overhead.
--
-- No index on (company_id, agent_id, updated_at) either: nothing in this
-- plugin queries or sorts by `updated_at` today. If a future feature needs
-- "most recently updated memory" ordering, add the index then.

-- A standalone index on agent_id alone IS needed: the UNIQUE constraint above
-- has company_id as its leading column, so Postgres can't use it for an
-- ON DELETE CASCADE that filters solely on agent_id (agent deletion) --
-- without this, every agent delete does a full sequential scan of this table.
-- Not CONCURRENTLY: this is a brand-new table with no existing rows (this
-- whole migration has never run anywhere -- see precondition note above),
-- so there's no populated table to lock. Do not copy this pattern for an
-- index added to a table that may already have rows.
CREATE INDEX IF NOT EXISTS agent_memory_agent_id_idx
  ON plugin_rh_agent_memory_ce4b575f82.agent_memory (agent_id);
