/**
 * Pure, runtime-agnostic helpers for the x-scraper's engagement tool
 * (`x_engagers`): "who engaged with this tweet".
 *
 * Like `x.ts`/`profile.ts`, nothing here touches Cloudflare bindings, the MCP
 * SDK, or `fetch` - the input mapping, tweet-id resolution, per-actor output
 * normalization and de-duplication are the parts worth unit-testing offline.
 *
 * Two backing Apify Actors, because no single one lists every engagement kind:
 *   - replies + quotes -> the same KaitoEasyAPI tweet scraper `x.ts` uses, keyed
 *     by `conversation_id` (replies) and `quoted_tweet_id` (quotes). Cheap and
 *     already the server's primary Actor.
 *   - retweeters -> `scrape.badger/twitter-tweets-scraper` in its `Get
 *     Retweeters` mode. It is the ONLY tested Actor that lists who reposted a
 *     tweet, so it is opt-in (the `include_retweeters` flag) - an extra paid run
 *     on a second Actor, off by default.
 *
 * Likers are deliberately absent: X removed the public who-liked list, so no
 * Actor can return it (badger's `Get Favoriters` returns `no_results` even on a
 * 500k-like tweet). Reply > quote > retweet are all higher-intent signals than a
 * like anyway.
 */

import { normalizeHandle } from "./x";

/**
 * `scrape.badger/twitter-tweets-scraper`: its `Get Retweeters` mode takes a
 * numeric tweet id and returns flat user objects for the reposters. Tilde form
 * is the URL-safe "username~name".
 */
export const DEFAULT_RETWEETERS_ACTOR_ID = "scrape.badger~twitter-tweets-scraper";

/** Default per-kind item cap. Engagement pulls want more than a search's 10;
 * each enabled kind is a separate billed run, so callers scale this down. */
export const DEFAULT_ENGAGER_MAX = 50;

/** How a returned account engaged with the tweet. */
export type EngagementKind = "reply" | "quote" | "retweet";

export interface XEngagersArgs {
  tweet_id?: string;
  tweet_url?: string;
  include_replies?: boolean;
  include_quotes?: boolean;
  include_retweeters?: boolean;
  max_items?: number;
}

/** A normalized engager, unified across the two Actors' differing shapes. */
export interface Engager {
  handle: string;
  name?: string;
  followers?: number;
  verified?: boolean;
  is_blue_verified?: boolean;
  can_dm?: boolean;
  description?: string;
  location?: string;
  /** Which engagement kind(s) surfaced this account, first-seen order. */
  engaged_via: EngagementKind[];
}

/**
 * Extract the numeric tweet id from a status URL
 * (`x.com/<handle>/status/<id>`, optional trailing path/query). Returns
 * undefined for a profile URL, an `/i/…` route, or a non-status link.
 */
export function tweetIdFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  try {
    const u = new URL(trimmed);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.twitter.com") return undefined;
  // Anchor to a real status permalink: /<handle>/status/<id> or the
  // /i/web/status/<id> form. Matching a bare `/status/<id>` anywhere in the
  // path would accept malformed routes and pay for a run that can only fail.
  const m = path.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?|i\/web\/status(?:es)?)\/(\d{1,25})(?:\/|$)/);
  return m ? m[1] : undefined;
}

/** A bare numeric snowflake id (1-25 digits), trimmed. Rejects anything else so
 * a malformed value can't trigger a paid run that only fails. */
export function normalizeTweetId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const trimmed = id.trim();
  return /^\d{1,25}$/.test(trimmed) ? trimmed : undefined;
}

/** Resolve the target tweet id from either input field (`tweet_id` wins). */
export function resolveTweetId(args: XEngagersArgs): string | undefined {
  return normalizeTweetId(args.tweet_id) ?? (args.tweet_url ? tweetIdFromUrl(args.tweet_url) : undefined);
}

/**
 * Which engagement kinds a call enables. Replies and quotes default on (cheap,
 * one shared Actor); retweeters defaults OFF because it is a second, extra-cost
 * Actor run (see file header).
 */
export function enabledKinds(args: XEngagersArgs): { replies: boolean; quotes: boolean; retweeters: boolean } {
  return {
    replies: args.include_replies ?? true,
    quotes: args.include_quotes ?? true,
    retweeters: args.include_retweeters ?? false,
  };
}

/** At least one engagement kind must be enabled, else the call is a no-op. */
export function hasEnabledKind(args: XEngagersArgs): boolean {
  const k = enabledKinds(args);
  return k.replies || k.quotes || k.retweeters;
}

/** Default the per-kind item cap (the tool's zod schema enforces the 1-1000 range). */
export function engagerMaxItems(args: XEngagersArgs): number {
  return args.max_items ?? DEFAULT_ENGAGER_MAX;
}

/** Kaito input for replies to a tweet: every post in the conversation thread.
 * The conversation includes the root tweet, which {@link stripRootTweet} drops
 * afterwards - so fetch one extra item (capped at the schema max) to leave room
 * for `maxItems` actual replies even at a small cap. */
export function buildRepliesInput(tweetId: string, maxItems: number): Record<string, unknown> {
  return { conversation_id: tweetId, maxItems: Math.min(maxItems + 1, 1000), queryType: "Latest" };
}

/** Kaito input for quote-tweets of a tweet. */
export function buildQuotesInput(tweetId: string, maxItems: number): Record<string, unknown> {
  return { quoted_tweet_id: tweetId, maxItems, queryType: "Latest" };
}

/** Badger input for the accounts that retweeted a tweet (`Get Retweeters`). */
export function buildRetweetersInput(tweetId: string, maxItems: number): Record<string, unknown> {
  return { mode: "Get Retweeters", id: tweetId, max_results: maxItems };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Normalize a KaitoEasyAPI tweet item to the account that authored it (a
 * replier or quoter), reading the nested `author` object. Returns undefined for
 * an item with no resolvable author handle (e.g. billing-floor filler).
 */
export function engagerFromKaitoTweet(item: Record<string, unknown>, kind: EngagementKind): Engager | undefined {
  const author = item.author;
  if (author === null || typeof author !== "object" || Array.isArray(author)) return undefined;
  const a = author as Record<string, unknown>;
  const handle = normalizeHandle(str(a.userName));
  if (!handle) return undefined;
  return {
    handle,
    name: str(a.name),
    followers: num(a.followers),
    verified: bool(a.isVerified),
    is_blue_verified: bool(a.isBlueVerified),
    can_dm: bool(a.canDm),
    description: str(a.description),
    location: str(a.location),
    engaged_via: [kind],
  };
}

/**
 * Normalize a badger retweeter item (a flat user object). Returns undefined for
 * the actor's empty-result sentinel `{ status, reason, mode, id }`, which
 * carries no `username`.
 */
export function engagerFromBadgerUser(item: Record<string, unknown>): Engager | undefined {
  const handle = normalizeHandle(str(item.username));
  if (!handle) return undefined;
  return {
    handle,
    name: str(item.name),
    followers: num(item.followers_count),
    verified: bool(item.verified),
    is_blue_verified: bool(item.is_blue_verified),
    can_dm: bool(item.can_dm),
    description: str(item.description),
    location: str(item.location),
    engaged_via: ["retweet"],
  };
}

/**
 * De-duplicate engagers by handle (case-insensitive), preserving first-seen
 * order and unioning each account's `engaged_via` kinds. The first occurrence's
 * profile fields win; a later occurrence only contributes its engagement kind.
 */
export function dedupeEngagers(engagers: Engager[]): Engager[] {
  const byHandle = new Map<string, Engager>();
  for (const e of engagers) {
    const key = e.handle.toLowerCase();
    const existing = byHandle.get(key);
    if (!existing) {
      byHandle.set(key, { ...e, engaged_via: [...e.engaged_via] });
      continue;
    }
    for (const kind of e.engaged_via) {
      if (!existing.engaged_via.includes(kind)) existing.engaged_via.push(kind);
    }
  }
  return [...byHandle.values()];
}

/**
 * Drop the conversation's root tweet from a replies pull: the KaitoEasyAPI
 * `conversation_id` query returns the original post alongside the replies, and
 * its author is the tweet owner, not an engager.
 */
export function stripRootTweet(items: Record<string, unknown>[], tweetId: string): Record<string, unknown>[] {
  return items.filter((it) => String(it.id ?? "") !== tweetId);
}

/** Outcome of one Actor run (structurally the `runActor` return in index.ts). */
export type EngagerRun =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; message: string };

/** One engagement kind's run plus how to turn its raw items into engagers. */
export interface EngagerRunResult {
  kind: EngagementKind;
  extract: (items: Record<string, unknown>[]) => Engager[];
  run: EngagerRun;
}

/**
 * Partition per-kind Actor runs into collected engagers and per-kind errors,
 * preserving input order so {@link dedupeEngagers}'s first-seen wins stay
 * deterministic. The caller decides what to do with a total wipeout (every run
 * failed) versus a partial result (some ran, some errored).
 */
export function collectEngagerRuns(results: EngagerRunResult[]): {
  collected: Engager[];
  errors: { kind: EngagementKind; message: string }[];
} {
  const collected: Engager[] = [];
  const errors: { kind: EngagementKind; message: string }[] = [];
  for (const { kind, extract, run } of results) {
    if (!run.ok) errors.push({ kind, message: run.message });
    else collected.push(...extract(run.items));
  }
  return { collected, errors };
}
