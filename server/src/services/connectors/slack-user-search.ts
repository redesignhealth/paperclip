import { unprocessable } from "../../errors.js";
import { nextCursor, object, objects, type SlackObject } from "./slack-client.js";

type Api = (method: string, args?: Record<string, unknown>) => Promise<SlackObject>;

/** The member list is cached per Slack connection for a few minutes: users.list is rate limited and rarely changes. */
export const SLACK_USER_SEARCH_CACHE_MS = 5 * 60_000;
const MAX_PAGES = 25;
const PAGE_SIZE = 200;
const cache = new Map<string, { at: number; members: SlackObject[] }>();

export function clearSlackUserSearchCache() {
  cache.clear();
}

async function members(api: Api, cacheKey: string, now: number): Promise<SlackObject[]> {
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < SLACK_USER_SEARCH_CACHE_MS) return cached.members;
  const all: SlackObject[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api("users.list", {
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...objects(result.members));
    cursor = nextCursor(result) ?? "";
    if (!cursor || seen.has(cursor)) {
      cache.set(cacheKey, { at: now, members: all });
      return all;
    }
    seen.add(cursor);
  }
  throw unprocessable("This Slack workspace is too large to search by name. Ask for the person's Slack user ID instead.");
}

/**
 * Find people in the bot's workspace by a name or email fragment. Every word of the query must appear in the
 * person's name, display name or email (case-insensitive), so "patrick mc" finds "Patrick McDonagh". All matches are
 * returned (never a silent pick) and guests and bots are flagged rather than hidden. Deactivated people are left out.
 */
export async function findSlackUsers(
  api: Api,
  cacheKey: string,
  query: string,
  limit = 10,
  now = Date.now(),
) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const member of await members(api, cacheKey, now)) {
    if (member.deleted === true || typeof member.id !== "string") continue;
    const profile = object(member.profile);
    const haystack = [member.name, member.real_name, profile.display_name, profile.real_name, profile.email]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    total += 1;
    if (matches.length >= limit) continue;
    matches.push({
      id: member.id,
      name: member.name,
      displayName: profile.display_name || undefined,
      realName: member.real_name,
      email: profile.email,
      guest: member.is_restricted === true || member.is_ultra_restricted === true,
      bot: member.is_bot === true,
    });
  }
  return { matches, total, truncated: total > matches.length };
}
