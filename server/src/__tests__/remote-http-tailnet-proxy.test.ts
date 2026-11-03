import { createServer } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readRemoteConnectionFailure } from "../services/remote-connection-failure.js";
import { readCommsBoardOwnership } from "../services/comms-board-provisioner-client.js";
import { provisionArcanaBrain } from "../services/arcana-provisioner-client.js";
import { guardedRemoteHttpFetch, readTailnetDomain, readTailnetHttpProxy, tailnetAwareFetch, tailnetTunnelProxy } from "../services/remote-http-fetch.js";

const error = (message: string, code: string) => Object.assign(new Error(message), { code });
const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

const listen = (server: Server | NetServer) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    closers.push(() => server.close());
  });

/** Fake sidecar: records CONNECT targets and tunnels them to `upstreamPort` (or refuses). */
async function startProxy(upstreamPort: number | null) {
  const targets: string[] = [];
  const sockets: Socket[] = [];
  const proxy = createServer();
  proxy.on("connect", (req, client, head) => {
    targets.push(req.url ?? "");
    if (upstreamPort === null) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(upstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.push(client, upstream);
  });
  closers.push(() => sockets.forEach((s) => s.destroy()));
  const port = await listen(proxy);
  return { url: `http://127.0.0.1:${port}`, targets };
}

const savedTailnetEnv = { proxy: process.env.TAILNET_HTTP_PROXY, domain: process.env.TAILNET_DOMAIN };
const restoreTailnetEnv = () => {
  for (const [key, value] of [["TAILNET_HTTP_PROXY", savedTailnetEnv.proxy], ["TAILNET_DOMAIN", savedTailnetEnv.domain]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const trusted = { allowPrivateNetwork: true, tailnetDomain: "drum-mackarel.ts.net" };
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];

describe("TAILNET_HTTP_PROXY", () => {
  afterEach(restoreTailnetEnv);

  it("tunnels https *.ts.net on 443 through CONNECT without local DNS", async () => {
    const proxy = await startProxy(null);
    await expect(
      guardedRemoteHttpFetch("https://mcp.drum-mackarel.ts.net/mcp", {}, {
        error, ...trusted, tailnetHttpProxy: proxy.url, lookup: async () => { throw new Error("must not resolve locally"); },
      }),
    ).rejects.toMatchObject({ code: "remote_http_connect_failed" });
    expect(proxy.targets).toEqual(["mcp.drum-mackarel.ts.net:443"]);
  });

  it("never sends other ports or http:// to the proxy", async () => {
    const proxy = await startProxy(null);
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; };
    const closed = createNetServer();
    const closedPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    for (const url of [`https://node.drum-mackarel.ts.net:${closedPort}/`, `http://node.drum-mackarel.ts.net:${closedPort}/`]) {
      await expect(
        guardedRemoteHttpFetch(url, {}, { error, ...trusted, tailnetHttpProxy: proxy.url, lookup }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    }
    expect(lookups).toBe(2);
    expect(proxy.targets).toEqual([]);
  });

  it("tailnetTunnelProxy applies only to https, default port, our suffix, allowPrivateNetwork", () => {
    const options = { error, ...trusted, tailnetHttpProxy: "http://127.0.0.1:1055" };
    const check = (url: string, o: object = {}) => tailnetTunnelProxy(new URL(url), { ...options, ...o });
    expect(check("https://a.drum-mackarel.ts.net/")?.port).toBe("1055");
    expect(check("https://a.drum-mackarel.ts.net:443/")?.port).toBe("1055");
    for (const url of ["https://a.drum-mackarel.ts.net:8443/", "http://a.drum-mackarel.ts.net/", "https://a.other.ts.net/", "https://example.com/"]) {
      expect(check(url), url).toBeNull();
    }
    expect(check("https://a.drum-mackarel.ts.net/", { allowPrivateNetwork: false })).toBeNull();
    expect(() => check("https://a.drum-mackarel.ts.net/", { tailnetHttpProxy: "" })).toThrow(/TAILNET_HTTP_PROXY is required/);
    expect(check("https://a.drum-mackarel.ts.net/", { tailnetHttpProxy: "", tailnetDomain: "" })).toBeNull();
  });

  it("classifies a proxy refusal", async () => {
    const proxy = await startProxy(null);
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: proxy.url }),
    ).rejects.toMatchObject({ code: "remote_http_connect_failed" });
  });

  it("classifies an unreachable proxy", async () => {
    const free = createNetServer();
    const port = await listen(free);
    free.close();
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}` }),
    ).rejects.toMatchObject({ code: "remote_http_connect_failed" });
  });

  it("starts TLS over the tunnel with the original hostname as SNI", async () => {
    let hello = Buffer.alloc(0);
    const upstream = createNetServer((socket) => {
      socket.on("data", (chunk) => {
        hello = Buffer.concat([hello, chunk]);
        socket.destroy();
      });
    });
    const proxy = await startProxy(await listen(upstream));
    await expect(guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: proxy.url })).rejects.toThrow();
    expect(proxy.targets).toEqual(["a.drum-mackarel.ts.net:443"]);
    expect(hello[0]).toBe(0x16);
    expect(hello.includes(Buffer.from("a.drum-mackarel.ts.net"))).toBe(true);
  });

  it("ignores the proxy for non-ts.net hosts and when unset", async () => {
    const proxy = await startProxy(null);
    for (const opts of [{ tailnetHttpProxy: proxy.url, tailnetDomain: "drum-mackarel.ts.net" }, {}]) {
      await expect(
        guardedRemoteHttpFetch("http://svc.example.test/", {}, { error, ...opts, lookup: privateLookup }),
      ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    }
    expect(proxy.targets).toEqual([]);
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, lookup: privateLookup }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["https://127.0.0.1:1055", "http://example.com:1055", "http://127.0.0.1", "not a url"])(
    "rejects invalid proxy %s",
    async (value) => {
      expect(() => readTailnetHttpProxy(value)).toThrow(/TAILNET_HTTP_PROXY/);
      await expect(guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: value })).rejects.toThrow(/TAILNET_HTTP_PROXY/);
    },
  );

  it("accepts loopback proxies and treats empty as unset", () => {
    expect(readTailnetHttpProxy("http://127.0.0.1:1055")?.port).toBe("1055");
    expect(readTailnetHttpProxy("http://[::1]:1055")?.port).toBe("1055");
    expect(readTailnetHttpProxy("")).toBeNull();
  });

  it("never tunnels when allowPrivateNetwork is not true", async () => {
    const proxy = await startProxy(null);
    for (const allowPrivateNetwork of [false, undefined]) {
      await expect(
        guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, {
          error, allowPrivateNetwork, tailnetDomain: "drum-mackarel.ts.net", tailnetHttpProxy: proxy.url, lookup: privateLookup,
        }),
      ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    }
    expect(proxy.targets).toEqual([]);
  });

  it("leaves other tailnets' *.ts.net names to the normal guard", async () => {
    const proxy = await startProxy(null);
    for (const host of ["a.other-tailnet.ts.net", "evil-drum-mackarel.ts.net", "drum-mackarel.ts.net"]) {
      await expect(
        guardedRemoteHttpFetch(`https://${host}/`, {}, { error, ...trusted, tailnetHttpProxy: proxy.url, lookup: async () => [{ address: "169.254.169.254", family: 4 }] }),
      ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    }
    expect(proxy.targets).toEqual([]);
  });

  it.each([undefined, "", "ts.net", "https://x.ts.net", "x.example.com", "*.x.ts.net"])("rejects TAILNET_DOMAIN %s through options.error", async (domain) => {
    expect(() => readTailnetDomain(domain)).toThrow(/TAILNET_DOMAIN/);
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, {
        error, allowPrivateNetwork: true, tailnetHttpProxy: "http://127.0.0.1:1055", ...(domain === undefined ? {} : { tailnetDomain: domain }),
      }),
    ).rejects.toMatchObject({ code: "remote_http_tailnet_config_invalid", message: expect.stringMatching(/TAILNET_DOMAIN/) });
  });

  it("rejects TAILNET_DOMAIN without a proxy only for names under that domain", async () => {
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, allowPrivateNetwork: true, tailnetDomain: "drum-mackarel.ts.net" }),
    ).rejects.toMatchObject({ code: "remote_http_tailnet_config_invalid", message: expect.stringMatching(/TAILNET_HTTP_PROXY/) });
    expect(tailnetTunnelProxy(new URL("https://a.other.ts.net/"), { error, allowPrivateNetwork: true, tailnetDomain: "drum-mackarel.ts.net" })).toBeNull();
  });

  it("rejects userinfo in the proxy URL", () => {
    expect(() => readTailnetHttpProxy("http://user:pw@127.0.0.1:1055")).toThrow(/TAILNET_HTTP_PROXY/);
  });

  it("surfaces an invalid proxy through options.error", async () => {
    await expect(
      guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: "http://example.com:1" }),
    ).rejects.toMatchObject({ code: "remote_http_tailnet_config_invalid" });
  });

  it("classifies a proxy that never answers as a connection timeout", async () => {
    const silent = createNetServer((socket) => closers.push(() => socket.destroy()));
    const port = await listen(silent);
    const failure = await guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, {
      error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}`, connectTimeoutMs: 50,
    }).catch((e) => e);
    expect(readRemoteConnectionFailure(failure)).toBe("connection_timeout");
  });

  it("classifies proxy 502 and 504 as connection failures", async () => {
    for (const [status, reason] of [[502, "network_unreachable"], [504, "connection_timeout"]] as const) {
      const proxy = createNetServer((socket) => {
        socket.on("data", () => socket.end(`HTTP/1.1 ${status} Bad\r\n\r\n`));
      });
      const port = await listen(proxy);
      const failure = await guardedRemoteHttpFetch("https://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}` }).catch((e) => e);
      expect(failure).toMatchObject({ code: "remote_http_connect_failed" });
      expect(readRemoteConnectionFailure(failure)).toBe(reason);
    }
  });
});

describe("default (unguarded-caller) fetch paths", () => {
  afterEach(restoreTailnetEnv);
  const configure = (proxyUrl: string) => {
    process.env.TAILNET_HTTP_PROXY = proxyUrl;
    process.env.TAILNET_DOMAIN = "drum-mackarel.ts.net";
  };

  it("tailnetAwareFetch tunnels https names, including a Request input", async () => {
    const proxy = await startProxy(null);
    configure(proxy.url);
    const base = "https://a.drum-mackarel.ts.net";
    await expect(tailnetAwareFetch(`${base}/x`, { redirect: "error" })).rejects.toMatchObject({ code: "remote_http_connect_failed" });
    await expect(tailnetAwareFetch(new Request(`${base}/req`, { method: "POST", body: "hi" }))).rejects.toMatchObject({ code: "remote_http_connect_failed" });
    expect(proxy.targets).toEqual(["a.drum-mackarel.ts.net:443", "a.drum-mackarel.ts.net:443"]);
  });

  it("tailnetAwareFetch rejects credentials in the URL before reaching the proxy", async () => {
    const proxy = await startProxy(null);
    configure(proxy.url);
    await expect(tailnetAwareFetch("https://user:pw@a.drum-mackarel.ts.net/")).rejects.toThrow(TypeError);
    expect(proxy.targets).toEqual([]);
  });

  it("tailnetAwareFetch checks URL credentials before tailnet config", async () => {
    process.env.TAILNET_HTTP_PROXY = "http://example.com:1";
    await expect(tailnetAwareFetch("https://user:pw@a.drum-mackarel.ts.net/")).rejects.toThrow(TypeError);
  });

  it("tailnetAwareFetch keeps the request body and values when init fields are undefined", async () => {
    const proxy = await startProxy(null);
    configure(proxy.url);
    const request = new Request("https://a.drum-mackarel.ts.net/", { method: "POST", body: "hi" });
    const spy = vi.spyOn(request, "arrayBuffer");
    await expect(tailnetAwareFetch(request, { method: undefined, body: undefined })).rejects.toMatchObject({ code: "remote_http_connect_failed" });
    expect(spy).toHaveBeenCalledTimes(1);
    const other = new Request("https://a.drum-mackarel.ts.net/", { method: "POST", body: "hi" });
    const otherSpy = vi.spyOn(other, "arrayBuffer");
    await expect(tailnetAwareFetch(other, { body: "override" })).rejects.toMatchObject({ code: "remote_http_connect_failed" });
    expect(otherSpy).not.toHaveBeenCalled();
  });

  it("tailnetAwareFetch rejects instead of throwing on bad config", async () => {
    process.env.TAILNET_HTTP_PROXY = "http://127.0.0.1:1055";
    delete process.env.TAILNET_DOMAIN;
    let pending: Promise<Response> | undefined;
    expect(() => { pending = tailnetAwareFetch("https://a.drum-mackarel.ts.net/"); }).not.toThrow();
    await expect(pending).rejects.toThrow(/TAILNET_DOMAIN/);
  });

  it("comms-board and Arcana clients default to the tunnel", async () => {
    const proxy = await startProxy(null);
    configure(proxy.url);
    const host = "https://a.drum-mackarel.ts.net";
    await readCommsBoardOwnership(
      { boardMcpUrl: host, boardAdminToken: "t", ownershipApiUrl: host, ownershipApiToken: "t" } as never,
      { baseSub: "agent-1" },
    ).catch((e) => e);
    await provisionArcanaBrain(
      { arcanaUrl: host, provisionKey: "k".repeat(32) },
      { agentPrincipalId: "p", companyId: "c", runtimeId: "r", exchangeKeyHash: "h" },
    ).catch(() => undefined);
    expect(proxy.targets).toEqual(["a.drum-mackarel.ts.net:443", "a.drum-mackarel.ts.net:443"]);
  });
});
