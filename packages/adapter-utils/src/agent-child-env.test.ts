import { describe, expect, it } from "vitest";
import { buildAgentChildBaseEnv, isSafeAgentBaseEnvName, isSafeLocaleEnvName } from "./agent-child-env.js";

describe("buildAgentChildBaseEnv (TECH-7076)", () => {
  it("keeps only OS/runtime essentials from the server environment", () => {
    const base = buildAgentChildBaseEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/agent",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
      HTTPS_PROXY: "http://proxy.internal:3128",
      SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    });
    expect(base).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/agent",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TZ: "UTC",
      HTTPS_PROXY: "http://proxy.internal:3128",
      SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    });
  });

  it("drops every server-only secret, including ones nobody has reviewed yet", () => {
    const secrets = {
      PAPERCLIP_SSO_PROVIDERS: "okta-client-secret-json",
      PAPERCLIP_SECRETS_MASTER_KEY: "master",
      PAPERCLIP_AGENT_JWT_SECRET: "jwt",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "sign",
      PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant",
      PAPERCLIP_DEFAULT_OPENAI_API_KEY: "default-openai-secret",
      BETTER_AUTH_SECRET: "better-auth",
      DATABASE_URL: "postgres://u:p@h/db",
      DATABASE_MIGRATION_URL: "postgres://u:p@h/db",
      PGPASSWORD: "pgpass",
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      AWS_ACCESS_KEY_ID: "akia",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
      GITHUB_TOKEN: "ghp_x",
      SOME_FUTURE_UNREVIEWED_SECRET: "future",
    };
    const base = buildAgentChildBaseEnv({ PATH: "/usr/bin", ...secrets });
    expect(Object.keys(base)).toEqual(["PATH"]);
    for (const value of Object.values(secrets)) {
      expect(JSON.stringify(base)).not.toContain(value);
    }
  });

  it("is an allowlist: a secret-looking name is not safe merely because it has a safe-looking prefix", () => {
    expect(isSafeAgentBaseEnvName("LC_ALL")).toBe(true);
    expect(isSafeAgentBaseEnvName("LC_SECRET_TOKEN")).toBe(false); // only real locale names, not an LC_ prefix
    expect(isSafeAgentBaseEnvName("LC_CTYPE")).toBe(true);
    expect(isSafeAgentBaseEnvName("RUSTUP_HOME")).toBe(true);
    expect(isSafeAgentBaseEnvName("CARGO_HOME")).toBe(true);
    expect(isSafeAgentBaseEnvName("PAPERCLIP_SSO_PROVIDERS")).toBe(false);
    expect(isSafeAgentBaseEnvName("PAPERCLIP_RUNTIME_API_URL")).toBe(true);
    expect(isSafeAgentBaseEnvName("NODE_OPTIONS")).toBe(false);
    expect(isSafeAgentBaseEnvName("SSH_AUTH_SOCK")).toBe(false);
  });

  it("skips undefined values and never mutates the source", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/bin", HOME: undefined, SECRET: "s" };
    const copy = { ...source };
    const base = buildAgentChildBaseEnv(source);
    expect(base).toEqual({ PATH: "/bin" });
    expect(source).toEqual(copy);
  });
});

describe("isSafeLocaleEnvName (TECH-7076)", () => {
  it("accepts exactly the POSIX locale category variables", () => {
    for (const name of [
      "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
      "LC_PAPER", "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION",
    ]) {
      expect(isSafeLocaleEnvName(name), name).toBe(true);
    }
  });

  it("rejects free-form LC_* names and near misses", () => {
    for (const name of ["LC_SECRET_TOKEN", "LC_INJECTION", "LC_", "LC_ALL_X", "lc_all", "LANG_SECRET", "LCALL", ""]) {
      expect(isSafeLocaleEnvName(name), name).toBe(false);
    }
  });
});
