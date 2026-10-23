/**
 * Regression tests for buildHermesConfig's `quiet` handling.
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
 * - Edit mode does not go through this builder, so only the create path is
 *   covered here.
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

describe("buildHermesConfig quiet handling", () => {
  it("persists the schema-default quiet: true the create form carries", () => {
    // Pre-fix failure scenario: the form's "Quiet output" toggle defaulted
    // on (schema default true), but the builder dropped it, so the stored
    // config had no quiet and execute() ran non-quiet.
    const values = makeCreateValues({
      adapterSchemaValues: schemaDefaultsAsTheFormApplies(),
    });

    expect(buildHermesConfig(values).quiet).toBe(true);
  });

  it("keeps the user's quiet opt-out (boolean false) from the create-form toggle", () => {
    const values = makeCreateValues({
      adapterSchemaValues: { ...schemaDefaultsAsTheFormApplies(), quiet: false },
    });

    // Strictly boolean so execute()'s cfgBoolean honors the opt-out.
    expect(buildHermesConfig(values).quiet).toBe(false);
  });

  it("defaults quiet to true when the form carries no schema values", () => {
    // The schema defaults effect can lag (schema still loading), so a
    // create call may carry no adapterSchemaValues at all.
    expect(buildHermesConfig(makeCreateValues()).quiet).toBe(true);
  });

  it("defaults quiet to true when adapterSchemaValues carry other fields but no quiet", () => {
    const values = makeCreateValues({
      adapterSchemaValues: { toolsets: "terminal,file" },
    });

    expect(buildHermesConfig(values).quiet).toBe(true);
  });

  it.each([["false"], ["true"], [0], [null]])(
    "follows the boolean-only contract: non-boolean quiet %j defaults to true",
    (invalid) => {
      const values = makeCreateValues({ adapterSchemaValues: { quiet: invalid } });

      // Only an actual boolean false opts out, matching execute()'s cfgBoolean.
      expect(buildHermesConfig(values).quiet).toBe(true);
    },
  );
});
