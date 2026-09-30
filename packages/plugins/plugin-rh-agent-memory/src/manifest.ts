import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "redesignhealth.plugin-rh-agent-memory";
export const NAMESPACE_SLUG = "rh_agent_memory";
/**
 * Host-derived Postgres schema for this plugin, i.e.
 * `plugin_${NAMESPACE_SLUG}_${sha256(PLUGIN_ID).slice(0, 10)}`.
 * Must match the schema hardcoded in `migrations/001_agent_memory.sql`.
 * @see server/src/services/plugin-database.ts#derivePluginDatabaseNamespace
 */
export const EXPECTED_DB_NAMESPACE = "plugin_rh_agent_memory_ce4b575f82";

export const MEMORY_GET_TOOL = "memory_get";
export const MEMORY_SET_TOOL = "memory_set";
export const MEMORY_DELETE_TOOL = "memory_delete";
export const MEMORY_LIST_TOOL = "memory_list";

export const MEMORY_TOOL_NAMES = [
  MEMORY_GET_TOOL,
  MEMORY_SET_TOOL,
  MEMORY_DELETE_TOOL,
  MEMORY_LIST_TOOL,
] as const;

/**
 * NOTE FOR REVIEWERS: none of these parameter schemas declares a `companyId`,
 * `agentId`, or any other tenant-identity property, and `additionalProperties`
 * is `false` everywhere. Tenancy comes from the host-validated
 * `ToolRunContext`. See `src/tenant.ts`.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "RH Agent Memory",
  description:
    "Tenant-isolated per-agent key/value memory for Redesign Health. Scopes every read and "
    + "write to the host-validated runContext company and agent, never to a caller-supplied parameter.",
  author: "Redesign Health <dan.costanza@redesignhealth.com>",
  categories: ["workspace", "automation"],
  capabilities: [
    "agent.tools.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: NAMESPACE_SLUG,
    migrationsDir: "migrations",
    // `companies` only, and only so the migration's
    // `company_id ... REFERENCES public.companies(id) ON DELETE CASCADE` FK is
    // accepted by the host migration validator (which requires every non-
    // namespace reference to be a whitelisted `public.*` table). No runtime
    // query in this plugin reads or joins a core table; keeping the whitelist
    // to one entry keeps the blast radius of a scoping mistake minimal.
    coreReadTables: ["companies"],
  },
  tools: [
    {
      name: MEMORY_GET_TOOL,
      displayName: "Get Agent Memory",
      description:
        "Read one value from this agent's private memory by key. Scoped automatically to the "
        + "calling agent and company; you cannot read another agent's or company's memory.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        required: ["key"],
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Memory key to read.",
          },
        },
      },
    },
    {
      name: MEMORY_SET_TOOL,
      displayName: "Set Agent Memory",
      description:
        "Write one JSON value into this agent's private memory under the given key, replacing any "
        + "existing value. Scoped automatically to the calling agent and company.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Memory key to write.",
          },
          value: {
            description: "Any JSON-serializable value to store (max 256 KB encoded).",
          },
        },
      },
    },
    {
      name: MEMORY_DELETE_TOOL,
      displayName: "Delete Agent Memory",
      description:
        "Delete one key from this agent's private memory. Scoped automatically to the calling "
        + "agent and company.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        required: ["key"],
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Memory key to delete.",
          },
        },
      },
    },
    {
      name: MEMORY_LIST_TOOL,
      displayName: "List Agent Memory",
      description:
        "List the keys and values in this agent's private memory. Scoped automatically to the "
        + "calling agent and company.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum number of entries to return. Defaults to 100.",
          },
        },
      },
    },
  ],
};

export default manifest;
