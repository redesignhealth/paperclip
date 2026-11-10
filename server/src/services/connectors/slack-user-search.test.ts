import { beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_TOOLS } from "@paperclipai/shared";
import {
  SLACK_USER_SEARCH_CACHE_MS,
  clearSlackUserSearchCache,
  findSlackUsers,
} from "./slack-user-search.js";

const member = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toLowerCase(),
  real_name: id,
  profile: {},
  ...extra,
});
const people = [
  member("U1", { name: "patrick.mc", real_name: "Patrick McDonagh", profile: { display_name: "Pat", email: "patrick.mcdonagh@redesignhealth.com" } }),
  member("U2", { name: "patrick.o", real_name: "Patrick O'Neil", profile: { email: "patrick.oneil@redesignhealth.com" } }),
  member("U3", { name: "gone", real_name: "Patrick Gone", deleted: true }),
  member("U4", { name: "guestpat", real_name: "Patricia Guest", is_restricted: true, profile: { email: "p@example.com" } }),
  member("U5", { name: "pbot", real_name: "Patrick Bot", is_bot: true }),
  member("U6", { name: "sam", real_name: "Sam Finkel", profile: { email: "sam.finkel@redesignhealth.com" } }),
];

function apiWith(pages: Array<Record<string, unknown>[]>) {
  return vi.fn(async (_method: string, args?: Record<string, unknown>) => {
    const index = args?.cursor ? Number(args.cursor) : 0;
    return {
      members: pages[index] ?? [],
      response_metadata: { next_cursor: index + 1 < pages.length ? String(index + 1) : "" },
    };
  });
}

beforeEach(() => clearSlackUserSearchCache());

describe("slack_find_user", () => {
  it("matches every word of the query against name, display name or email, case-insensitively", async () => {
    const api = apiWith([people]);
    const { matches } = await findSlackUsers(api, "e1", "patrick mc");
    expect(matches.map((m) => m.id)).toEqual(["U1"]);
    expect((await findSlackUsers(api, "e1", "PAT")).matches.map((m) => m.id)).toContain("U1");
    expect((await findSlackUsers(api, "e1", "sam.finkel@redesignhealth")).matches.map((m) => m.id)).toEqual(["U6"]);
  });

  it("returns every match instead of picking one, and flags guests and bots", async () => {
    const { matches, total, truncated } = await findSlackUsers(apiWith([people]), "e1", "pat");
    expect(matches.map((m) => m.id).sort()).toEqual(["U1", "U2", "U4", "U5"]);
    expect(total).toBe(4);
    expect(truncated).toBe(false);
    expect(matches.find((m) => m.id === "U4")).toMatchObject({ guest: true, bot: false });
    expect(matches.find((m) => m.id === "U5")).toMatchObject({ guest: false, bot: true });
  });

  it("leaves out deactivated people", async () => {
    const { matches } = await findSlackUsers(apiWith([people]), "e1", "gone");
    expect(matches).toEqual([]);
  });

  it("caps the returned matches at the limit and says it was truncated", async () => {
    const { matches, total, truncated } = await findSlackUsers(apiWith([people]), "e1", "pat", 2);
    expect(matches).toHaveLength(2);
    expect(total).toBe(4);
    expect(truncated).toBe(true);
  });

  it("follows pagination across pages", async () => {
    const api = apiWith([[people[0]!], [people[5]!]]);
    expect((await findSlackUsers(api, "e1", "sam")).matches.map((m) => m.id)).toEqual(["U6"]);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("caches the member list per connection for a few minutes", async () => {
    const api = apiWith([people]);
    const t0 = 1_000_000;
    await findSlackUsers(api, "e1", "sam", 10, t0);
    await findSlackUsers(api, "e1", "pat", 10, t0 + 1000);
    expect(api).toHaveBeenCalledTimes(1);
    await findSlackUsers(api, "e2", "sam", 10, t0 + 1000);
    expect(api).toHaveBeenCalledTimes(2);
    await findSlackUsers(api, "e1", "sam", 10, t0 + SLACK_USER_SEARCH_CACHE_MS + 1);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("is a read tool that takes a short query, an optional limit, and nothing else", () => {
    const tool = SLACK_TOOLS.find((entry) => entry.name === "slack_find_user")!;
    expect(tool.risk).toBe("read");
    expect(tool.scopes).toEqual(["users:read"]);
    expect(tool.schema.safeParse({ query: "patrick" }).success).toBe(true);
    expect(tool.schema.safeParse({ query: "p" }).success).toBe(false);
    expect(tool.schema.safeParse({ query: "patrick", limit: 26 }).success).toBe(false);
    expect(tool.schema.safeParse({ query: "patrick", extra: 1 }).success).toBe(false);
  });
});
