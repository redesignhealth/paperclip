import { describe, expect, it } from "vitest";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { preserveExistingSsoProviders } from "./server.js";

function fakeServerConfig(): ServerConfig {
  return {
    deploymentMode: "local_trusted",
    exposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    serveUi: true,
  };
}

function freshAuth(): AuthConfig {
  return { baseUrlMode: "auto", disableSignUp: false, ssoProviders: [] };
}

const provider = {
  providerId: "keycloak",
  type: "keycloak" as const,
  clientId: "paperclip",
  clientSecret: "secret",
  issuer: "http://paperclip-keycloak.localtest.me:8080/realms/paperclip",
};

describe("preserveExistingSsoProviders", () => {
  it("carries existing ssoProviders through a rebuilt auth config", () => {
    const result = preserveExistingSsoProviders(
      { server: fakeServerConfig(), auth: freshAuth() },
      { ssoProviders: [provider] },
    );
    expect(result.auth.ssoProviders).toEqual([provider]);
  });

  it("leaves the fresh (empty) ssoProviders alone when there is no existing config", () => {
    const result = preserveExistingSsoProviders(
      { server: fakeServerConfig(), auth: freshAuth() },
      undefined,
    );
    expect(result.auth.ssoProviders).toEqual([]);
  });

  it("leaves the fresh ssoProviders alone when the existing config had none either", () => {
    const result = preserveExistingSsoProviders(
      { server: fakeServerConfig(), auth: freshAuth() },
      { ssoProviders: [] },
    );
    expect(result.auth.ssoProviders).toEqual([]);
  });

  it("does not otherwise change the rebuilt server or auth config", () => {
    const built = { server: fakeServerConfig(), auth: freshAuth() };
    const result = preserveExistingSsoProviders(built, { ssoProviders: [provider] });
    expect(result.server).toBe(built.server);
    expect(result.auth.baseUrlMode).toBe(built.auth.baseUrlMode);
    expect(result.auth.disableSignUp).toBe(built.auth.disableSignUp);
  });
});
