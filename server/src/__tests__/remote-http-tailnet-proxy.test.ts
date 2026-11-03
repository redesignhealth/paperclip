import { createServer } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { readRemoteConnectionFailure } from "../services/remote-connection-failure.js";
import { readCommsBoardOwnership } from "../services/comms-board-provisioner-client.js";
import { provisionArcanaBrain } from "../services/arcana-provisioner-client.js";
import { guardedRemoteHttpFetch, readTailnetDomain, readTailnetHttpProxy, tailnetAwareFetch } from "../services/remote-http-fetch.js";

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

async function startOrigin() {
  const hits: Array<{ host?: string; url?: string }> = [];
  const origin = createServer((req, res) => {
    hits.push({ host: req.headers.host, url: req.url });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  closers.push(() => origin.closeAllConnections());
  return { port: await listen(origin), hits };
}

const trusted = { allowPrivateNetwork: true, tailnetDomain: "drum-mackarel.ts.net" };
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];

describe("TAILNET_HTTP_PROXY", () => {
  it("tunnels *.ts.net through CONNECT without local DNS", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    const response = await guardedRemoteHttpFetch(
      `http://mcp.drum-mackarel.ts.net:${origin.port}/mcp`,
      {},
      { error, ...trusted, tailnetHttpProxy: proxy.url, lookup: async () => { throw new Error("must not resolve locally"); } },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(proxy.targets).toEqual([`mcp.drum-mackarel.ts.net:${origin.port}`]);
    expect(origin.hits).toEqual([{ host: `mcp.drum-mackarel.ts.net:${origin.port}`, url: "/mcp" }]);
  });

  it("does not follow redirects", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    const response = await guardedRemoteHttpFetch(`http://a.drum-mackarel.ts.net:${origin.port}/redirect`, {}, { error, ...trusted, tailnetHttpProxy: proxy.url });
    expect(response.status).toBe(302);
    expect(origin.hits.map((h) => h.url)).toEqual(["/redirect"]);
  });

  it("classifies a proxy refusal", async () => {
    const proxy = await startProxy(null);
    await expect(
      guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net:8080/", {}, { error, ...trusted, tailnetHttpProxy: proxy.url }),
    ).rejects.toMatchObject({ code: "remote_http_connect_failed" });
  });

  it("classifies an unreachable proxy", async () => {
    const free = createNetServer();
    const port = await listen(free);
    free.close();
    await expect(
      guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net:8080/", {}, { error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}` }),
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
      guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, { error, lookup: privateLookup }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["https://127.0.0.1:1055", "http://example.com:1055", "http://127.0.0.1", "not a url"])(
    "rejects invalid proxy %s",
    async (value) => {
      expect(() => readTailnetHttpProxy(value)).toThrow(/TAILNET_HTTP_PROXY/);
      await expect(guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: value })).rejects.toThrow(/TAILNET_HTTP_PROXY/);
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
        guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, {
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
        guardedRemoteHttpFetch(`http://${host}/`, {}, { error, ...trusted, tailnetHttpProxy: proxy.url, lookup: async () => [{ address: "169.254.169.254", family: 4 }] }),
      ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    }
    expect(proxy.targets).toEqual([]);
  });

  it.each([undefined, "", "ts.net", "https://x.ts.net", "x.example.com", "*.x.ts.net"])("rejects TAILNET_DOMAIN %s through options.error", async (domain) => {
    expect(() => readTailnetDomain(domain)).toThrow(/TAILNET_DOMAIN/);
    await expect(
      guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, {
        error, allowPrivateNetwork: true, tailnetHttpProxy: "http://127.0.0.1:1055", ...(domain === undefined ? {} : { tailnetDomain: domain }),
      }),
    ).rejects.toMatchObject({ code: "remote_http_tailnet_config_invalid", message: expect.stringMatching(/TAILNET_DOMAIN/) });
  });

  it("surfaces an invalid proxy through options.error", async () => {
    await expect(
      guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: "http://example.com:1" }),
    ).rejects.toMatchObject({ code: "remote_http_tailnet_config_invalid" });
  });

  it("classifies a proxy that never answers as a connection timeout", async () => {
    const silent = createNetServer((socket) => closers.push(() => socket.destroy()));
    const port = await listen(silent);
    const failure = await guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, {
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
      const failure = await guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}` }).catch((e) => e);
      expect(failure).toMatchObject({ code: "remote_http_connect_failed" });
      expect(readRemoteConnectionFailure(failure)).toBe(reason);
    }
  });

  it("keeps bytes that arrive with the CONNECT 200", async () => {
    const body = '{"early":true}';
    const proxy = createNetServer((socket) => {
      socket.once("data", () =>
        socket.write(`HTTP/1.1 200 OK\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`),
      );
      closers.push(() => socket.destroy());
    });
    const port = await listen(proxy);
    const response = await guardedRemoteHttpFetch("http://a.drum-mackarel.ts.net/", {}, { error, ...trusted, tailnetHttpProxy: `http://127.0.0.1:${port}` });
    expect(await response.json()).toEqual({ early: true });
  });
});

describe("default (unguarded-caller) fetch paths", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["TAILNET_HTTP_PROXY", "TAILNET_DOMAIN"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const configure = (proxyUrl: string) => {
    process.env.TAILNET_HTTP_PROXY = proxyUrl;
    process.env.TAILNET_DOMAIN = "drum-mackarel.ts.net";
  };

  it("tailnetAwareFetch tunnels, errors on redirect:error, and accepts a Request", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    configure(proxy.url);
    const base = `http://a.drum-mackarel.ts.net:${origin.port}`;
    expect(await (await tailnetAwareFetch(`${base}/x`, { redirect: "error" })).json()).toEqual({ ok: true });
    await expect(tailnetAwareFetch(`${base}/redirect`, { redirect: "error" })).rejects.toThrow(TypeError);
    expect((await tailnetAwareFetch(`${base}/redirect`, { redirect: "manual" })).status).toBe(302);
    const viaRequest = await tailnetAwareFetch(new Request(`${base}/req`, { method: "POST", body: "hi" }));
    expect(viaRequest.status).toBe(200);
    expect(origin.hits.map((h) => h.url)).toEqual(["/x", "/redirect", "/redirect", "/req"]);
    expect(proxy.targets).toHaveLength(4);
  });

  it("tailnetAwareFetch rejects instead of throwing on bad config", async () => {
    process.env.TAILNET_HTTP_PROXY = "http://127.0.0.1:1055";
    delete process.env.TAILNET_DOMAIN;
    let pending: Promise<Response> | undefined;
    expect(() => { pending = tailnetAwareFetch("http://a.drum-mackarel.ts.net/"); }).not.toThrow();
    await expect(pending).rejects.toThrow(/TAILNET_DOMAIN/);
  });

  it("comms-board and Arcana clients default to the tunnel", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    configure(proxy.url);
    const host = `http://a.drum-mackarel.ts.net:${origin.port}`;
    await readCommsBoardOwnership(
      { boardMcpUrl: host, boardAdminToken: "t", ownershipApiUrl: host, ownershipApiToken: "t" } as never,
      { baseSub: "agent-1" },
    );
    await provisionArcanaBrain(
      { arcanaUrl: host, provisionKey: "k".repeat(32) },
      { agentPrincipalId: "p", companyId: "c", runtimeId: "r", exchangeKeyHash: "h" },
    );
    expect(proxy.targets).toEqual([`a.drum-mackarel.ts.net:${origin.port}`, `a.drum-mackarel.ts.net:${origin.port}`]);
  });
});
