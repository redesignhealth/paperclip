import { describe, expect, it, vi } from "vitest";
import { ghFetch } from "../services/github-fetch.js";

const PUBLIC = "93.184.216.34";
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

// Literal-IP hops go through `unpinnedFetch`; hostname hops are rejected by the guard before any socket opens.
function setup(hops: Record<string, Response>, lookup = async () => [{ address: PUBLIC, family: 4 }]) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const unpinnedFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    calls.push({ url: key, auth: new Headers(init?.headers).get("authorization") });
    return hops[key] ?? new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, guard: { lookup, unpinnedFetch } };
}

describe("ghFetch redirect guard", () => {
  it.each([
    ["loopback", "http://127.0.0.1:9/admin"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data"],
    ["tailnet CGNAT literal", "http://100.64.0.1/"],
  ])("rejects a redirect to %s without contacting it", async (_name, target) => {
    const { calls, guard } = setup({ "https://8.8.8.8/start": redirect(target) });
    await expect(ghFetch("https://8.8.8.8/start", undefined, guard)).rejects.toMatchObject({ status: 422 });
    expect(calls.map((c) => c.url)).toEqual(["https://8.8.8.8/start"]);
  });

  it("rejects a redirect to a hostname resolving to a private address", async () => {
    const lookup = vi.fn(async (host: string) => [{ address: host === "evil.test" ? "10.0.0.5" : PUBLIC, family: 4 }]);
    const { calls, guard } = setup({ "https://8.8.8.8/start": redirect("https://evil.test/x") }, lookup);
    await expect(ghFetch("https://8.8.8.8/start", undefined, guard)).rejects.toMatchObject({ status: 422 });
    expect(lookup).toHaveBeenCalledWith("evil.test");
    expect(calls).toHaveLength(1);
  });

  it("rejects an initial URL that resolves to a private address", async () => {
    const { calls, guard } = setup({}, async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(ghFetch("https://ghe.test/api/v3/repos", undefined, guard)).rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(0);
  });

  it("follows a redirect between public hosts and drops Authorization cross-origin only", async () => {
    const { calls, guard } = setup({
      "https://8.8.8.8/a": redirect("/b"),
      "https://8.8.8.8/b": redirect("https://1.1.1.1/c"),
    });
    const res = await ghFetch("https://8.8.8.8/a", { headers: { authorization: "Bearer t" } }, guard);
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual([
      { url: "https://8.8.8.8/a", auth: "Bearer t" },
      { url: "https://8.8.8.8/b", auth: "Bearer t" },
      { url: "https://1.1.1.1/c", auth: null },
    ]);
  });

  it("caps redirect hops", async () => {
    const { calls, guard } = setup({ "https://8.8.8.8/loop": redirect("/loop") });
    await expect(ghFetch("https://8.8.8.8/loop", undefined, guard)).rejects.toMatchObject({ status: 422, details: { code: "github_redirect_limit" } });
    expect(calls).toHaveLength(6);
  });
});
