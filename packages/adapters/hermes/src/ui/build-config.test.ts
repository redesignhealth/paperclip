/**
 * TECH-7239 regression tests for buildHermesConfig's `quiet` handling.
 *
 * Pre-fix failure: the builder never persisted `quiet`, so the create form's
 * "Quiet output" toggle (schema default true, see server/config-schema.ts)
 * had no effect on the stored adapterConfig, and execute() then defaulted to
 * non-quiet. These tests reproduce that scenario through the real builder
 * call shapes:
 *
 * - The Paperclip UI invokes this builder with a SINGLE CreateConfigValues
 *   argument (ui/src/adapters/types.ts `buildAdapterConfig`, called from
 *   AgentConfigForm / OnboardingWizard / NewAgentSetup / CompanyImport).
 * - On create, SchemaConfigFields (ui/src/adapters/schema-config-fields.tsx)
 *   applies every schema field default into `adapterSchemaValues`, so
 *   `adapterSchemaValues.quiet` arrives as a boolean (true from the schema
 *   default, false once the user toggles the field off).
 * - The optional second `existingConfig` argument is the builder's declared
 *   update API. No UI caller passes it yet (edit mode merges the stored
 *   config without this builder), so update cases here call it directly.
 */

import { describe, expect, it } from "vitest";
import type { ConfigFieldSchema, CreateConfigValues } from "@paperclipai/adapter-utils";

import { buildHermesConfig } from "./build-config.js";
import { getConfigSchema } from "../server/config-schema.js";

/**
 * Mirrors the required (non-optional) fields of
 * ui/src/components/agent-config-defaults.ts `defaultCreateValues` -- the
 * base state the create form holds when `buildAdapterConfig(val!)` runs.
 */
function makeCreateValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "hermes_local",
    cwd: "",
    promptTemplate: "",
    model: "anthropic/claude-sonnet-4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

/**
 * Mirrors getDefaultValue in ui/src/adapters/schema-config-fields.tsx so the
 * fixture derives `adapterSchemaValues` the same way the form's
 * defaults-application effect does.
 */
function schemaDefaultValue(field: ConfigFieldSchema): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "toggle":
      return false;
    case "number":
      return 0;
    case "select":
      return field.options?.[0]?.value ?? "";
    default:
      return "";
  }
}

/**
 * The adapterSchemaValues the create form holds after SchemaConfigFields'
 * defaults effect: every schema field default, skipping undefined and "".
 */
function schemaDefaultsAsTheFormApplies(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const field of getConfigSchema().fields) {
    const def = schemaDefaultValue(field);
    if (def !== undefined && def !== "") {
      defaults[field.key] = def;
    }
  }
  return defaults;
}

describe("buildHermesConfig quiet handling (TECH-7239)", () => {
  describe("create -- actual UI call shape (single CreateConfigValues argument)", () => {
    it("persists the schema-default quiet: true the create form carries", () => {
      // Pre-fix failure scenario: the form's "Quiet output" toggle defaulted
      // on (schema default true), but the builder dropped it, so the stored
      // config had no quiet and execute() ran non-quiet.
      const values = makeCreateValues({
        adapterSchemaValues: schemaDefaultsAsTheFormApplies(),
      });

      const config = buildHermesConfig(values);

      expect(config.quiet).toBe(true);
    });

    it("keeps the user's quiet opt-out from the create-form toggle", () => {
      // What writeValue() stores after the user turns the toggle off: a
      // boolean false in adapterSchemaValues.
      const values = makeCreateValues({
        adapterSchemaValues: { ...schemaDefaultsAsTheFormApplies(), quiet: false },
      });

      const config = buildHermesConfig(values);

      // Strictly boolean so execute()'s cfgBoolean honors the opt-out.
      expect(config.quiet).toBe(false);
    });

    it("defaults quiet to true when the form carries no schema values", () => {
      // The schema defaults effect can lag (schema still loading), so a
      // create call may carry no adapterSchemaValues at all.
      const config = buildHermesConfig(makeCreateValues());

      expect(config.quiet).toBe(true);
    });

    it("defaults quiet to true when adapterSchemaValues carry other fields but no quiet", () => {
      const values = makeCreateValues({
        adapterSchemaValues: { toolsets: "terminal,file" },
      });

      const config = buildHermesConfig(values);

      expect(config.quiet).toBe(true);
    });
  });

  describe("string quiet values are normalized to booleans before storage", () => {
    it("normalizes a string quiet opt-out from the form values to boolean false", () => {
      const values = makeCreateValues({ adapterSchemaValues: { quiet: "false" } });

      const config = buildHermesConfig(values);

      // Boolean, never the raw string: execute()'s cfgBoolean only honors
      // booleans, so a stored string would silently run quiet.
      expect(config.quiet).toBe(false);
    });

    it("normalizes a string quiet \"true\" from the form values to boolean true", () => {
      const values = makeCreateValues({ adapterSchemaValues: { quiet: "true" } });

      const config = buildHermesConfig(values);

      expect(config.quiet).toBe(true);
    });

    it("accepts a top-level quiet opt-out on the values object", () => {
      // The builder also reads an undeclared top-level `quiet` key ahead of
      // adapterSchemaValues (extraValues.quiet in build-config.ts).
      const values: CreateConfigValues & { quiet: boolean } = {
        ...makeCreateValues(),
        quiet: false,
      };

      const config = buildHermesConfig(values);

      expect(config.quiet).toBe(false);
    });
  });

  describe("update -- existingConfig second argument (declared update API)", () => {
    it("preserves a stored quiet opt-out on update", () => {
      const config = buildHermesConfig(makeCreateValues(), {
        model: "zai/glm-4.7",
        quiet: false,
      });

      expect(config.quiet).toBe(false);
    });

    it("preserves a stored quiet: true on update", () => {
      const config = buildHermesConfig(makeCreateValues(), { quiet: true });

      expect(config.quiet).toBe(true);
    });

    it("normalizes a stored string quiet opt-out to boolean false on update", () => {
      const config = buildHermesConfig(makeCreateValues(), { quiet: "false" });

      expect(config.quiet).toBe(false);
    });

    it("does not add quiet when updating a config that never had it", () => {
      // An agent predating TECH-7239 has no stored quiet; an update rebuild
      // must not stamp the create default onto it.
      const config = buildHermesConfig(makeCreateValues(), {
        model: "zai/glm-4.7",
        timeoutSec: 900,
      });

      expect(Object.prototype.hasOwnProperty.call(config, "quiet")).toBe(false);
    });

    it("lets a fresh form value win over the stored value", () => {
      // Branch order: a quiet carried by the call itself takes precedence
      // over the existingConfig fallback.
      const values = makeCreateValues({ adapterSchemaValues: { quiet: false } });

      const config = buildHermesConfig(values, { quiet: true });

      expect(config.quiet).toBe(false);
    });
  });

  describe("update -- single-argument escape hatches (no current UI caller)", () => {
    it("honors an existingConfig carried on the values object", () => {
      // extraValues.existingConfig in build-config.ts: the only way a
      // single-argument caller (the actual UI call shape) can flag an update.
      const values: CreateConfigValues & { existingConfig: Record<string, unknown> } = {
        ...makeCreateValues(),
        existingConfig: { quiet: false },
      };

      const config = buildHermesConfig(values);

      expect(config.quiet).toBe(false);
    });

    it("suppresses the create default when the values object marks isCreate: false", () => {
      // Without this flag a single-argument update call (no quiet anywhere)
      // would stamp quiet: true onto the rebuilt config.
      const values: CreateConfigValues & { isCreate: boolean } = {
        ...makeCreateValues(),
        isCreate: false,
      };

      const config = buildHermesConfig(values);

      expect(Object.prototype.hasOwnProperty.call(config, "quiet")).toBe(false);
    });
  });
});
