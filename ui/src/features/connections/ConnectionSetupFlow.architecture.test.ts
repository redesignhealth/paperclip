import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("shared connection setup architecture", () => {
  it("resets the public-client toggle with the other generic credentials on app switches", () => {
    const flow = source("./ConnectionSetupFlow.tsx");
    const reset = flow.split("const resetGenericAuthState = () => {")[1]!.split("\n  };")[0]!;
    expect(reset).toContain('setLinkOAuthClientPublic(false)');
    expect(reset).toContain('setLinkOAuthClientId("")');
    expect(reset).toContain('setLinkOAuthClientSecret("")');
    const switchApp = flow.split("const useMatchedGalleryEntry =")[1]!.split("const ")[0]!;
    expect(switchApp.match(/resetGenericAuthState\(\)/g)).toHaveLength(2);
    expect(reset).toContain("genericClientRecovery.current.edited = true");
    expect(switchApp).toContain("genericClientRecovery.current.edited = true");
    expect(flow).toContain("recoverManualOAuthClient(identityConnection, genericClientRecovery.current)");
    for (const callback of ["onOAuthClientIdChange", "onOAuthClientSecretChange", "onOAuthClientPublicChange", "onAuthModeChange"]) {
      const handler = flow.split(`${callback}={(next) => {`)[1]!.split("}}")[0]!;
      expect(handler).toContain("genericClientRecovery.current.edited = true");
    }
    expect(flow).toContain("setLinkOAuthClientPublic(client.oauthClientPublic)");
  });
  it("keeps both hosts thin and routes provider setup through ConnectionSetupFlow", () => {
    const pageHost = source("../../pages/apps/AppsConnect.tsx");
    const taskHost = source("./ConnectionIntentInteractionBody.tsx");

    for (const host of [pageHost, taskHost]) {
      expect(host).toContain("ConnectionSetupFlow");
      expect(host).not.toContain("CONNECTABLE_APP_DEFINITIONS");
      expect(host).not.toContain("ProviderCredentialField");
      expect(host).not.toContain("getAvailableConnectionMethods");
      expect(host).not.toContain("toolsApi.connectApp");
      expect(host).not.toContain("toolsApi.startOAuth");
    }

    expect(pageHost).not.toContain("connectionIntentsApi");
    expect(taskHost).not.toContain("connect-helpers");
    expect(taskHost).not.toContain("connect-ui");
  });
});
