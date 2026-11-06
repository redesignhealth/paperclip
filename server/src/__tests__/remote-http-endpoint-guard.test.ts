import { describe, expect, it } from "vitest";
import { assertPublicRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";
import { readRemoteConnectionFailure } from "../services/remote-connection-failure.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it.each(["ENOTFOUND", "ENODATA", "EAI_AGAIN"])("retains proven DNS failure %s across the public wrapper", async (code) => {
    const failure = await assertPublicRemoteHttpEndpoint(new URL("https://missing.example.test/mcp"), {
      lookup: async () => { throw Object.assign(new Error("lookup failed"), { code }); },
    }, guardError).catch((error) => error);
    expect(failure).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(failure)).toBe("dns_failure");
  });

  it("marks its exact DNS deadline without trusting unknown lookup exceptions", async () => {
    const timedOut = await assertPublicRemoteHttpEndpoint(new URL("https://silent.example.test/mcp"), {
      lookup: async () => new Promise(() => {}), dnsTimeoutMs: 1,
    }, guardError).catch((error) => error);
    expect(timedOut).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(timedOut)).toBe("connection_timeout");
    const unknown = await assertPublicRemoteHttpEndpoint(new URL("https://broken.example.test/mcp"), {
      lookup: async () => { throw new TypeError("internal lookup bug: ENOTFOUND"); },
    }, guardError).catch((error) => error);
    expect(unknown).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(unknown)).toBeNull();
  });

  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "fe80::1",
    "febf::1",
  ])("always rejects link-local literal %s when private networking is allowed", async (address) => {
    const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      { allowPrivateNetwork: true },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["169.254.42.1", "fe80::1234"])(
    "always rejects link-local DNS answer %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://operator-endpoint.example/mcp"),
        { allowPrivateNetwork: true, lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "fd00::1"])(
    "allows intended private address %s when private networking is allowed",
    async (address) => {
      const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(url),
        { allowPrivateNetwork: true },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each([
    "http://100.64.0.1/mcp",
    "http://100.127.255.254:3000/mcp",
    "http://100.100.100.100/mcp",
    "https://[::ffff:100.64.0.1]:3000/",
    "https://[::ffff:6440:1]/",
    "http://1681915905/", // decimal 100.64.0.1
    "http://0x64400001/", // hex 100.64.0.1
    "http://0144.0100.0.1/", // octal 100.64.0.1
    "http://[fd7a:115c:a1e0::1]:3000/",
    "http://[fd7a:115c:a1e0:b1a:0:1:6440:1]/", // 4via6
    "http://[64:ff9b::6440:1]/",
    "http://[::6440:1]/",
    "http://[::ffff:0:6440:1]/",
    "http://[2002:6440:1::]/",
  ])("rejects tailnet CGNAT literal %s even when private networking is allowed", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(new URL(url), { allowPrivateNetwork: true }, guardError))
      .rejects.toMatchObject({ code: "remote_http_tailnet_address_denied" });
  });

  it("rejects CGNAT literals without private networking via the existing private-address rule", async () => {
    await expect(assertPublicRemoteHttpEndpoint(new URL("http://100.64.0.1/"), {}, guardError))
      .rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["http://100.63.255.255/", "http://100.128.0.1/"])("keeps %s outside the CGNAT rule (public address, allowed in both modes)", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(new URL(url), { allowPrivateNetwork: true }, guardError)).resolves.toBeUndefined();
    await expect(assertPublicRemoteHttpEndpoint(new URL(url), {}, guardError)).resolves.toBeUndefined();
  });

  const cgnat = [{ address: "100.64.0.9", family: 4 }];
  const hostCheck = (url: string, answers = cgnat, allowPrivateNetwork = true) =>
    assertPublicRemoteHttpEndpoint(new URL(url), { allowPrivateNetwork, lookup: async () => answers }, guardError);

  it.each(["https://svc.example/", "https://svc.example:443/"])("allows hostname resolving to CGNAT on %s", async (url) => {
    await expect(hostCheck(url)).resolves.toBeUndefined();
  });

  it.each(["https://svc.example:8443/", "http://svc.example/", "http://svc.example:443/", "wss://svc.example/", "ws://svc.example/"])(
    "denies hostname resolving to CGNAT on %s",
    async (url) => {
      await expect(hostCheck(url)).rejects.toMatchObject({ code: "remote_http_tailnet_address_denied", message: expect.stringContaining("https on port 443") });
    },
  );

  it("applies the rule to the whole request when answers mix public and CGNAT", async () => {
    const mixed = [{ address: "93.184.216.34", family: 4 }, ...cgnat];
    await expect(hostCheck("https://svc.example:8443/", mixed)).rejects.toMatchObject({ code: "remote_http_tailnet_address_denied" });
    await expect(hostCheck("https://svc.example/", mixed)).resolves.toBeUndefined();
  });

  it("keeps the private-endpoint code for CGNAT answers when private networking is off", async () => {
    await expect(hostCheck("https://svc.example:8443/", cgnat, false)).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  const tailnetV6 = [{ address: "fd7a:115c:a1e0::9", family: 6 }];
  it("denies hostname with only an fd7a:115c:a1e0::/48 answer on http:3000", async () => {
    await expect(hostCheck("http://svc.example:3000/", tailnetV6)).rejects.toMatchObject({ code: "remote_http_tailnet_address_denied" });
    await expect(hostCheck("https://svc.example/", tailnetV6)).resolves.toBeUndefined();
  });

  it("allowTailnetAddress (operator allowlist) skips the tailnet deny only", async () => {
    const allow = { allowPrivateNetwork: true, allowTailnetAddress: true };
    await expect(assertPublicRemoteHttpEndpoint(new URL("http://100.64.0.5:8080/"), allow, guardError)).resolves.toBeUndefined();
    await expect(assertPublicRemoteHttpEndpoint(new URL("http://[fd7a:115c:a1e0::1]/"), allow, guardError)).resolves.toBeUndefined();
    await expect(assertPublicRemoteHttpEndpoint(new URL("http://169.254.169.254/"), allow, guardError)).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});
