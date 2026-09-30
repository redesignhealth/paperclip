-- RH Agent Memory — tenant-scoped per-agent key/value memory.
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
