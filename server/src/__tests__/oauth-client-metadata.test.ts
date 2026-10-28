import { describe, expect, it, vi } from "vitest";

import {
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
  resolveOAuthClientIdMetadataDocumentUrl,
} from "../services/tool-access.js";

describe("OAuth Client ID Metadata Document selection", () => {
  it("uses a publicly resolved HTTPS callback origin", async () => {
    const redirectUri = "https://paperclip.example:42001/api/tools/oauth/callback";

    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      redirectUri,
      async () => [{ address: "93.184.216.34", family: 4 }],
    )).resolves.toBe(`https://paperclip.example:42001${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}`);
  });

  it("rejects a Tailscale-range hostname so OAuth can fall back to DCR", async () => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      "https://paperclip.tailnet.example:42001/api/tools/oauth/callback",
      async () => [{ address: "100.100.100.100", family: 4 }],
    )).resolves.toBeNull();
  });

  it.each([
    "http://localhost:3100/api/tools/oauth/callback",
    "https://127.0.0.1:3100/api/tools/oauth/callback",
  ])("rejects a non-public callback origin %s", async (redirectUri) => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(redirectUri)).resolves.toBeNull();
  });

  // TECH-7973: a tailnet-only deployment (origin https://rh-agents.<tailnet>.ts.net)
  // is NXDOMAIN on public DNS. The previous "inconclusive" reading adopted CIMD
  // anyway and handed the authorization server a client id it could never fetch.
  it.each([
    "https://rh-agents.drum-mackarel.ts.net/api/tools/oauth/callback",
    "https://device.tail29c1aa.ts.net:42001/api/tools/oauth/callback",
    "https://TS.NET/api/tools/oauth/callback",
  ])("treats a *.ts.net callback origin as non-public without a lookup: %s", async (redirectUri) => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    await expect(resolveOAuthClientIdMetadataDocumentUrl(redirectUri, lookup)).resolves.toBeNull();
    // The hostname is rejected before any DNS work, and never adopted.
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["ENOTFOUND", Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })],
    ["NXDOMAIN", Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" })],
    ["timeout", new Error("DNS lookup timed out")],
  ])("fails closed on a %s DNS failure instead of adopting CIMD", async (_label, error) => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      "https://paperclip.example:42001/api/tools/oauth/callback",
      async () => {
        throw error;
      },
    )).resolves.toBeNull();
  });

  it("fails closed when the hostname resolves to an empty set", async () => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      "https://paperclip.example:42001/api/tools/oauth/callback",
      async () => [],
    )).resolves.toBeNull();
  });

  it("fails closed on a mixed public/private answer", async () => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      "https://paperclip.example:42001/api/tools/oauth/callback",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.4", family: 4 },
      ],
    )).resolves.toBeNull();
  });
});
