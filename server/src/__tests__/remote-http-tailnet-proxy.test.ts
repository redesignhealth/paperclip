import { createServer } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { guardedRemoteHttpFetch, readTailnetHttpProxy } from "../services/remote-http-fetch.js";

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

const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];

describe("TAILNET_HTTP_PROXY", () => {
  it("tunnels *.ts.net through CONNECT without local DNS", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    const response = await guardedRemoteHttpFetch(
      `http://mcp.drum-mackarel.ts.net:${origin.port}/mcp`,
      {},
      { error, tailnetHttpProxy: proxy.url, lookup: async () => { throw new Error("must not resolve locally"); } },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(proxy.targets).toEqual([`mcp.drum-mackarel.ts.net:${origin.port}`]);
    expect(origin.hits).toEqual([{ host: `mcp.drum-mackarel.ts.net:${origin.port}`, url: "/mcp" }]);
  });

  it("does not follow redirects", async () => {
    const origin = await startOrigin();
    const proxy = await startProxy(origin.port);
    const response = await guardedRemoteHttpFetch(`http://a.ts.net:${origin.port}/redirect`, {}, { error, tailnetHttpProxy: proxy.url });
    expect(response.status).toBe(302);
    expect(origin.hits.map((h) => h.url)).toEqual(["/redirect"]);
  });

  it("classifies a proxy refusal", async () => {
    const proxy = await startProxy(null);
    await expect(
      guardedRemoteHttpFetch("http://a.ts.net:8080/", {}, { error, tailnetHttpProxy: proxy.url }),
    ).rejects.toMatchObject({ code: "remote_http_connect_failed" });
  });

  it("classifies an unreachable proxy", async () => {
    const free = createNetServer();
    const port = await listen(free);
    free.close();
    await expect(
      guardedRemoteHttpFetch("http://a.ts.net:8080/", {}, { error, tailnetHttpProxy: `http://127.0.0.1:${port}` }),
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
    await expect(guardedRemoteHttpFetch("https://a.ts.net/", {}, { error, tailnetHttpProxy: proxy.url })).rejects.toThrow();
    expect(proxy.targets).toEqual(["a.ts.net:443"]);
    expect(hello[0]).toBe(0x16);
    expect(hello.includes(Buffer.from("a.ts.net"))).toBe(true);
  });

  it("ignores the proxy for non-ts.net hosts and when unset", async () => {
    const proxy = await startProxy(null);
    for (const opts of [{ tailnetHttpProxy: proxy.url }, {}]) {
      await expect(
        guardedRemoteHttpFetch("http://svc.example.test/", {}, { error, ...opts, lookup: privateLookup }),
      ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    }
    expect(proxy.targets).toEqual([]);
    await expect(
      guardedRemoteHttpFetch("http://a.ts.net/", {}, { error, lookup: privateLookup }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["https://127.0.0.1:1055", "http://example.com:1055", "http://127.0.0.1", "not a url"])(
    "rejects invalid proxy %s",
    async (value) => {
      expect(() => readTailnetHttpProxy(value)).toThrow(/TAILNET_HTTP_PROXY/);
      await expect(guardedRemoteHttpFetch("http://a.ts.net/", {}, { error, tailnetHttpProxy: value })).rejects.toThrow(/TAILNET_HTTP_PROXY/);
    },
  );

  it("accepts loopback proxies and treats empty as unset", () => {
    expect(readTailnetHttpProxy("http://127.0.0.1:1055")?.port).toBe("1055");
    expect(readTailnetHttpProxy("http://[::1]:1055")?.port).toBe("1055");
    expect(readTailnetHttpProxy("")).toBeNull();
  });
});
