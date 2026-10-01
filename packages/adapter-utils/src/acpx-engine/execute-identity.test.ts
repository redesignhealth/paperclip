// Identity split and launch-environment finalization tests (Phase 17).
//
// Two tests are compile-time: the real assertion is that this file typechecks.
// A `@ts-expect-error` marks an assignment that MUST fail; if it starts to
// compile, tsc reports the unused directive and the typecheck fails. Each
// compile-time assertion lives in a declared, unexecuted function, so vitest
// never runs a synthetic value.

import { describe, expect, it } from "vitest";
import {
  buildSessionFingerprint,
  finalizeLaunchEnvironment,
  projectAcpxInheritedHostEnvironment,
} from "./execute.js";
import type {
  LaunchEnvironment,
  McpServerIdentity,
  RunScopedContribution,
  RunSiteReuseCandidate,
  SessionFingerprintIdentity,
} from "./run-contracts.js";

// A complete fingerprint identity with representative values for the 17 fields.
const SAMPLE_FINGERPRINT_IDENTITY: SessionFingerprintIdentity = {
  acpxAgent: "claude",
  agentCommand: "claude",
  cwd: "/work",
  mode: "persistent",
  permissionMode: "approve-all",
  nonInteractivePermissions: "deny",
  requestedModel: "",
  requestedThinkingEffort: "",
  fastMode: false,
  remoteExecutionIdentity: null,
  additionalSourcesIdentity: {},
  skillsIdentity: {},
  skillPromptInstructions: "",
  paperclipClaudeSettings: null,
  mcpServers: [],
  secretManifestHash: "0000",
  adapterEnvHash: "0000",
};

describe("acpx identity split and launch environment", () => {
  it("test_fingerprint_builder_accepts_only_session_fingerprint_identity", () => {
    // The builder accepts a fingerprint identity and returns a stable hash.
    const first = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    const second = buildSessionFingerprint(SAMPLE_FINGERPRINT_IDENTITY);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    // The compile-time assertions live in an unexecuted function.
    function _assertOnlyIdentity(): void {
      // An outer-key field is not a fingerprint field, so the builder rejects it.
      // @ts-expect-error companyId is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, companyId: "c" });
      // @ts-expect-error taskKey is not a SessionFingerprintIdentity field.
      buildSessionFingerprint({ ...SAMPLE_FINGERPRINT_IDENTITY, taskKey: "t" });
    }
    void _assertOnlyIdentity;

    function _assertMcpServerIdentity(): void {
      // @ts-expect-error allowedTools is required on McpServerIdentity
      const _missingAllowedTools: McpServerIdentity = {
        name: "test",
        url: "https://example.test",
        connectionId: "conn-1",
      };
      const _valid: McpServerIdentity = {
        name: "test",
        url: "https://example.test",
        connectionId: "conn-1",
        allowedTools: ["tool_a"],
      };
      void _missingAllowedTools;
      void _valid;
    }
    void _assertMcpServerIdentity;
  });

  it("test_finalize_launch_environment_is_sole_constructor_of_branded_environment", () => {
    // The finalizer merges every contribution and freezes the launch env.
    const baseEnv: Record<string, string> = { LAUNCH_ENV_TEST_BASE: "base" };
    const launchEnvironment = finalizeLaunchEnvironment(
      baseEnv,
      [{ scope: "session", env: { LAUNCH_ENV_TEST_CONTRIB: "contrib" } }],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        inheritedEnv: {},
      },
    );
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_BASE).toBe("base");
    expect(launchEnvironment.env.LAUNCH_ENV_TEST_CONTRIB).toBe("contrib");
    expect(Object.isFrozen(launchEnvironment.env)).toBe(true);

    // No plain object literal can stand in for the branded environment; it lacks
    // the private brand that only `finalizeLaunchEnvironment` sets.
    function _assertBrand(): void {
      // @ts-expect-error missing the private launch-environment brand.
      const _fake: LaunchEnvironment = { env: {} };
      void _fake;
    }
    void _assertBrand;
  });

  it("test_run_scoped_contribution_is_not_assignable_to_a_reuse_payload", () => {
    // A run-scoped contribution and the branded launch environment must never
    // enter a reuse payload (Amendment B). The reuse candidate types reject both.
    function _assertNotReusable(
      contribution: RunScopedContribution,
      launchEnvironment: LaunchEnvironment,
    ): void {
      // @ts-expect-error a run-scoped contribution is not a reuse candidate.
      const _a: RunSiteReuseCandidate = contribution;
      // @ts-expect-error the branded launch environment is not a reuse candidate.
      const _b: RunSiteReuseCandidate = launchEnvironment;
      void _a;
      void _b;
    }
    void _assertNotReusable;
    expect(true).toBe(true);
  });

  it("inherits only safe host context and NO provider credentials (TECH-7076)", () => {
    const inherited = {
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "openai-host-secret",
      ANTHROPIC_API_KEY: "anthropic-host-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-auth-host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-host-secret",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_MODEL: "claude-test",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-fast-test",
      CLAUDE_CONFIG_DIR: "/host/claude",
      CLAUDE_CODE_USE_BEDROCK: "true",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-host-secret",
      OPENROUTER_API_KEY: "openrouter-host-secret",
      GOOGLE_GENAI_USE_GCA: "true",
      KIMI_MODEL_NAME: "kimi-code/test",
      KIMI_MODEL_API_KEY: "kimi-host-secret",
      KIMI_MODEL_BASE_URL: "https://kimi.example",
      KIMI_MODEL_PROVIDER_TYPE: "openai_legacy",
      KIMI_CODE_HOME: "/host/kimi",
      PAPERCLIP_NATIVE_MCP_TOKEN: "native-mcp-host-secret",
      PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "managed-auth-host-secret",
      UNRELATED_SECRET: "unrelated-host-secret",
      NODE_OPTIONS: "--require /tmp/host-hook.cjs",
    };

    // Provider authentication (keys, tokens, cloud credentials, config homes, base URLs) must
    // come only from explicit adapter env / the managed AI-connection runtime, for every agent.
    const safeOnly = {
      PATH: "/usr/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
    };
    for (const agent of ["codex", "claude", "pi", "gemini", "kimi", "grok"]) {
      expect(projectAcpxInheritedHostEnvironment(inherited, agent, true), agent).toEqual(safeOnly);
    }
    const serialized = JSON.stringify(projectAcpxInheritedHostEnvironment(inherited, "claude", true));
    for (const secret of [
      "openai-host-secret",
      "anthropic-host-secret",
      "anthropic-auth-host-secret",
      "claude-oauth-host-secret",
      "bedrock-host-secret",
      "openrouter-host-secret",
      "kimi-host-secret",
      "unrelated-host-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not project any ambient host environment across a remote boundary", () => {
    const inherited = {
      PATH: "/host/bin",
      OPENAI_API_KEY: "ambient-provider-secret",
      PAPERCLIP_NATIVE_MCP_TOKEN: "ambient-native-mcp-secret",
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "ambient-bootstrap-secret",
    };

    expect(projectAcpxInheritedHostEnvironment(inherited, "codex", false)).toEqual({});
  });

  it("keeps explicit remote adapter and run contributions while rejecting ambient authority", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      {
        OPENAI_API_KEY: "explicit-provider-secret",
        EXPLICIT_ADAPTER_SECRET: "adapter-secret",
        PAPERCLIP_RUNTIME_API_URL: "http://paperclip.internal/api",
      },
      [
        {
          scope: "session",
          env: { PAPERCLIP_NATIVE_MCP_TOKEN: "explicit-run-contribution" },
        },
      ],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: false,
        inheritedEnv: {
          PATH: "/host/bin",
          OPENAI_API_KEY: "ambient-provider-secret",
          PAPERCLIP_NATIVE_MCP_TOKEN: "ambient-native-mcp-secret",
          PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "ambient-bootstrap-secret",
        },
      },
    );

    expect(launchEnvironment.env).toMatchObject({
      OPENAI_API_KEY: "explicit-provider-secret",
      EXPLICIT_ADAPTER_SECRET: "adapter-secret",
      PAPERCLIP_RUNTIME_API_URL: "http://paperclip.internal/api",
      PAPERCLIP_NATIVE_MCP_TOKEN: "explicit-run-contribution",
    });
    expect(launchEnvironment.env).not.toHaveProperty("PATH");
    expect(launchEnvironment.env).not.toHaveProperty("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
  });

  it("preserves an explicit remote PATH instead of synthesizing a host fallback", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      { PATH: "/sandbox/bin" },
      [],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: false,
        inheritedEnv: { PATH: "/host/bin" },
      },
    );

    expect(launchEnvironment.env).toEqual({ PATH: "/sandbox/bin" });
  });

  it("lets explicit Windows env values suppress differently-cased ambient values", () => {
    const launchEnvironment = finalizeLaunchEnvironment(
      {
        openai_api_key: "",
        Path: "C:\\explicit\\bin",
      },
      [],
      {
        acpxAgent: "codex",
        inheritHostEnvironment: true,
        inheritedEnv: {
          OPENAI_API_KEY: "ambient-provider-secret",
          PATH: "C:\\ambient\\bin",
        },
        platform: "win32",
      },
    );

    expect(launchEnvironment.env).toEqual({
      openai_api_key: "",
      Path: "C:\\explicit\\bin",
    });
  });
});
