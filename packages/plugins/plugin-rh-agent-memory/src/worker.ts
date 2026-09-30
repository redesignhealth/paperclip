import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import manifest, {
  MEMORY_DELETE_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_LIST_TOOL,
  MEMORY_SET_TOOL,
} from "./manifest.js";
import {
  deleteMemory,
  getMemory,
  listMemory,
  normalizeListLimit,
  normalizeMemoryKey,
  serializeValue,
  setMemory,
} from "./store.js";
import {
  MissingRunContextTenantError,
  TenantParameterInjectionError,
  requireTenant,
  type Tenant,
} from "./tenant.js";

type ToolParams = Record<string, unknown>;

function asParams(params: unknown): ToolParams {
  return params != null && typeof params === "object" && !Array.isArray(params)
    ? (params as ToolParams)
    : {};
}

function parametersSchemaFor(ctx: PluginContext, name: string) {
  const schema = ctx.manifest.tools?.find((tool) => tool.name === name)?.parametersSchema;
  if (schema == null) {
    throw new Error(
      `RH Agent Memory: tool "${name}" is registered but has no manifest entry with a `
      + `parametersSchema. This is a registration/manifest mismatch bug — falling back to a `
      + `permissive schema would silently drop the additionalProperties:false guard.`,
    );
  }
  return schema;
}

/**
 * Wraps a handler so that:
 *   - tenancy is resolved once, from `runCtx` only (see `src/tenant.ts`);
 *   - a tenant-identity parameter aborts the call before any SQL runs;
 *   - a rejected injection attempt is written to the activity log, because a
 *     silent failure gives a prompt-injection attempt no audit trail.
 *
 * Handlers receive `(params, tenant)`. They never receive `runCtx`, so a future
 * handler cannot accidentally start trusting something else on it, and they
 * cannot reconstruct a tenant from `params` because `Tenant` is only
 * constructible by `resolveTenant`.
 */
function tenantScoped(
  ctx: PluginContext,
  toolName: string,
  handler: (params: ToolParams, tenant: Tenant) => Promise<ToolResult>,
): (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult> {
  return async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
    let tenant: Tenant;
    try {
      tenant = requireTenant(params, runCtx);
    } catch (error) {
      if (error instanceof TenantParameterInjectionError) {
        ctx.logger.warn("Rejected tenant-identity parameter on plugin tool call", {
          tool: toolName,
          rejectedKeys: error.rejectedKeys,
          runContextCompanyId: runCtx?.companyId ?? null,
          runContextAgentId: runCtx?.agentId ?? null,
          runId: runCtx?.runId ?? null,
        });
        try {
          // Audit against the runContext's own company — the host-validated
          // one where the injection attempt actually happened, never the
          // company the caller claimed. The worker→host invocation scope is
          // derived from runContext.companyId, so this is also the only
          // company this worker call is permitted to write activity for.
          const auditCompanyId = typeof runCtx?.companyId === "string" ? runCtx.companyId.trim() : "";
          if (auditCompanyId.length === 0) throw new Error("no auditable company scope");
          await ctx.activity.log({
            companyId: auditCompanyId,
            message:
              `RH Agent Memory rejected a ${toolName} call that supplied tenant identity as a `
              + `parameter (${error.rejectedKeys.join(", ")}).`,
            metadata: {
              tool: toolName,
              rejectedKeys: error.rejectedKeys,
              runContextCompanyId: runCtx?.companyId ?? null,
              runContextAgentId: runCtx?.agentId ?? null,
            },
          });
        } catch (auditError) {
          // Never let audit logging convert a clean rejection into a crash, but
          // don't swallow the failure silently either — an audit-write failure
          // for a rejected injection attempt is itself worth knowing about.
          const auditErrorMessage = auditError instanceof Error ? auditError.message : String(auditError);
          ctx.logger.warn("RH Agent Memory failed to write audit log for rejected tool call", {
            tool: toolName,
            error: auditErrorMessage,
          });
        }
        return { error: error.message };
      }
      if (error instanceof MissingRunContextTenantError) {
        ctx.logger.error("Plugin tool call had no usable runContext tenant", {
          tool: toolName,
          reason: error.message,
        });
        return { error: error.message };
      }
      throw error;
    }

    try {
      return await handler(asParams(params), tenant);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error("RH Agent Memory tool failed", { tool: toolName, error: message });
      return { error: message };
    }
  };
}

export function registerMemoryTools(ctx: PluginContext): void {
  ctx.tools.register(
    MEMORY_GET_TOOL,
    {
      displayName: "Get Agent Memory",
      description: manifest.tools?.find((tool) => tool.name === MEMORY_GET_TOOL)?.description ?? "",
      parametersSchema: parametersSchemaFor(ctx, MEMORY_GET_TOOL),
    },
    tenantScoped(ctx, MEMORY_GET_TOOL, async (params, tenant) => {
      const key = normalizeMemoryKey(params.key);
      const record = await getMemory(ctx.db, tenant, key);
      if (!record) {
        return {
          content: `No memory found for key "${key}".`,
          data: { found: false, key, value: null },
        };
      }
      return {
        content: JSON.stringify(record.value),
        data: { found: true, ...record },
      };
    }),
  );

  ctx.tools.register(
    MEMORY_SET_TOOL,
    {
      displayName: "Set Agent Memory",
      description: manifest.tools?.find((tool) => tool.name === MEMORY_SET_TOOL)?.description ?? "",
      parametersSchema: parametersSchemaFor(ctx, MEMORY_SET_TOOL),
    },
    tenantScoped(ctx, MEMORY_SET_TOOL, async (params, tenant) => {
      const key = normalizeMemoryKey(params.key);
      if (!Object.prototype.hasOwnProperty.call(params, "value")) {
        throw new Error("`value` is required");
      }
      const valueJson = serializeValue(params.value);
      await setMemory(ctx.db, tenant, key, valueJson);
      return { content: `Stored memory "${key}".`, data: { key, stored: true } };
    }),
  );

  ctx.tools.register(
    MEMORY_DELETE_TOOL,
    {
      displayName: "Delete Agent Memory",
      description: manifest.tools?.find((tool) => tool.name === MEMORY_DELETE_TOOL)?.description ?? "",
      parametersSchema: parametersSchemaFor(ctx, MEMORY_DELETE_TOOL),
    },
    tenantScoped(ctx, MEMORY_DELETE_TOOL, async (params, tenant) => {
      const key = normalizeMemoryKey(params.key);
      const result = await deleteMemory(ctx.db, tenant, key);
      const deleted = (result?.rowCount ?? 0) > 0;
      return {
        content: deleted ? `Deleted memory "${key}".` : `No memory found for key "${key}".`,
        data: { key, deleted },
      };
    }),
  );

  ctx.tools.register(
    MEMORY_LIST_TOOL,
    {
      displayName: "List Agent Memory",
      description: manifest.tools?.find((tool) => tool.name === MEMORY_LIST_TOOL)?.description ?? "",
      parametersSchema: parametersSchemaFor(ctx, MEMORY_LIST_TOOL),
    },
    tenantScoped(ctx, MEMORY_LIST_TOOL, async (params, tenant) => {
      const limit = normalizeListLimit(params.limit);
      const entries = await listMemory(ctx.db, tenant, limit);
      return {
        content: entries.length === 0
          ? "This agent has no stored memory."
          : entries.map((entry) => `${entry.key}: ${JSON.stringify(entry.value)}`).join("\n"),
        data: { count: entries.length, limit, entries },
      };
    }),
  );
}

const plugin = definePlugin({
  async setup(ctx) {
    registerMemoryTools(ctx);
    ctx.logger.info("RH Agent Memory plugin ready", {
      namespace: ctx.db.namespace,
      tools: manifest.tools?.map((tool) => tool.name) ?? [],
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "RH Agent Memory plugin worker is running",
      details: { surfaces: ["tools", "database"] },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
