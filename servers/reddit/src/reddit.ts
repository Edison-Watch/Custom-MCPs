/**
 * Pure, runtime-agnostic helpers for the reddit MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * the Apify Actor's schema, what a well-formed dataset looks like, and how each
 * Actor's item is normalized onto the stable NormalizedRedditItem shape) are the
 * part worth unit-testing, and keeping them dependency-free lets `bun test`
 * exercise them offline with no workerd / network.
 *
 * Mirrors the Python service `services/reddit_svc.py` at the repo root, which
 * wraps the same Actor for the CLI/HTTP/stdio transports.
 */

export const APIFY_BASE = "https://api.apify.com/v2";

/**
 * trudax/reddit-scraper-lite: pay-per-result (~$0.0038/item), same input schema
 * as the $45/mo flat-rate sibling. Tilde form is the URL-safe "username~name".
 */
export const DEFAULT_ACTOR_ID = "trudax~reddit-scraper-lite";

/**
 * Cap the synchronous Apify run. Lower than the Python service's 300s: a Worker
 * subrequest has a tighter wall-clock budget than a long-lived Python process,
 * and small `max_items` queries return well within this. Bump `max_items` down,
 * not this up, for heavier scrapes.
 */
export const RUN_TIMEOUT_S = 120;

export type RedditSort = "relevance" | "hot" | "top" | "new" | "rising" | "comments";
export type RedditTime = "all" | "hour" | "day" | "week" | "month" | "year";

export interface RedditScrapeArgs {
  search?: string;
  subreddit?: string;
  start_urls?: string[];
  sort?: RedditSort;
  time_filter?: RedditTime;
  max_items?: number;
  include_comments?: boolean;
  include_nsfw?: boolean;
}

/**
 * Normalize a search term: trim, and treat blank/whitespace-only as absent so a
 * useless `searches: ["  "]` is never sent to Apify (it must instead hit the
 * "provide a search or URLs" error).
 */
export function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return undefined;
  const trimmed = search.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A query needs at least one target: a real search term or one start URL. */
export function hasTarget(args: RedditScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || (args.start_urls?.length ?? 0) > 0;
}

/** Map the first-party input onto the Actor's input schema. */
export function buildActorInput(args: RedditScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = args.start_urls ?? [];
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxItems,
    maxPostCount: maxItems,
    skipComments: !(args.include_comments ?? false),
    includeNSFW: args.include_nsfw ?? false,
    sort: args.sort ?? "new",
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };
  if (search) actorInput.searches = [search];
  if (args.subreddit) actorInput.searchCommunityName = args.subreddit;
  if (startUrls.length > 0) actorInput.startUrls = startUrls.map((url) => ({ url }));
  if (args.time_filter) actorInput.time = args.time_filter;
  return actorInput;
}

/** The synchronous run-and-fetch-dataset endpoint for an Actor. */
export function runSyncUrl(actorId: string, base: string = APIFY_BASE): string {
  return `${base}/acts/${actorId}/run-sync-get-dataset-items`;
}

export type DatasetResult =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; error: string };

/**
 * Validate a parsed Apify response: it must be a JSON array whose every element
 * is a plain object. Anything else is surfaced as an error rather than handed
 * back as malformed data.
 */
export function validateDatasetItems(json: unknown): DatasetResult {
  if (!Array.isArray(json)) {
    return { ok: false, error: `unexpected Apify response shape: ${typeof json}` };
  }
  for (const item of json) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "Apify returned a dataset item that is not an object" };
    }
  }
  return { ok: true, items: json as Record<string, unknown>[] };
}

// --- Normalization ---------------------------------------------------------
//
// Each Actor names its output fields differently, so callers should never depend
// on a specific Actor's raw keys. These per-Actor field maps translate an Actor's
// item onto the stable NormalizedRedditItem shape. A map keys a normalized field
// to an ordered list of candidate source keys; the first key present with a
// non-null value wins. Adding a new Actor is a data change (one map + one
// registry entry), not new mapping code. Mirrors services/reddit_svc.py.

export type RedditItemType = "post" | "comment" | "community" | "user";

export interface NormalizedRedditItem {
  id: string | null;
  type: RedditItemType | null;
  title: string | null;
  body: string | null;
  author: string | null;
  subreddit: string | null;
  url: string | null;
  permalink: string | null;
  created_at: string | null;
  score: number | null;
  num_comments: number | null;
  upvote_ratio: number | null;
  over_18: boolean | null;
  num_crossposts: number | null;
  raw: Record<string, unknown>;
}

type FieldMap = Record<keyof Omit<NormalizedRedditItem, "raw">, string[]>;

/**
 * The trudax family (reddit-scraper-lite and its flat-rate reddit-scraper
 * sibling) share one output schema, verified from Apify's documented actor
 * schemas: posts carry upVotes / numberOfComments / upVoteRatio; comments carry
 * numberOfVotes and their text under description. reddit-scraper-lite in its
 * default RSS mode omits the engagement fields, so they normalize to null; the
 * flat-rate reddit-scraper returns them, so pointing APIFY_ACTOR_ID at it makes
 * counts flow through this same map with no code change.
 */
const TRUDAX_FIELD_MAP: FieldMap = {
  id: ["id", "parsedId"],
  type: ["dataType"],
  title: ["title"],
  body: ["body", "description", "html"],
  author: ["username", "author"],
  subreddit: ["communityName", "parsedCommunityName"],
  url: ["url"],
  permalink: ["permalink"],
  created_at: ["createdAt"],
  score: ["upVotes", "numberOfVotes"],
  num_comments: ["numberOfComments"],
  upvote_ratio: ["upVoteRatio"],
  over_18: ["over18"],
  num_crossposts: ["numberOfCrossposts"],
};

/**
 * Fallback for an Actor with no registered map: a broad candidate-key list
 * spanning snake_case (Reddit's own JSON API) and common camelCase variants.
 * Best-effort only - a bespoke Actor should get its own entry in
 * FIELD_MAP_BY_ACTOR rather than rely on these guesses.
 */
const DEFAULT_FIELD_MAP: FieldMap = {
  id: ["id", "name"],
  type: ["type", "dataType", "kind"],
  title: ["title"],
  body: ["body", "selftext", "text", "description", "html"],
  author: ["author", "username", "user"],
  subreddit: ["subreddit", "communityName", "community"],
  url: ["url", "link"],
  permalink: ["permalink"],
  created_at: ["created_at", "createdAt", "created_utc", "created"],
  score: ["score", "upVotes", "ups", "numberOfVotes"],
  num_comments: ["num_comments", "numberOfComments", "comments", "commentCount"],
  upvote_ratio: ["upvote_ratio", "upVoteRatio"],
  over_18: ["over_18", "over18", "nsfw"],
  num_crossposts: ["num_crossposts", "numberOfCrossposts", "crossposts"],
};

const FIELD_MAP_BY_ACTOR: Record<string, FieldMap> = {
  "trudax~reddit-scraper-lite": TRUDAX_FIELD_MAP,
  "trudax~reddit-scraper": TRUDAX_FIELD_MAP,
};

/** Raw type/kind discriminators (incl. Reddit's t1/t3/t5/t2 codes) -> our literal. */
const TYPE_ALIASES: Record<string, RedditItemType> = {
  post: "post",
  link: "post",
  t3: "post",
  comment: "comment",
  t1: "comment",
  community: "community",
  subreddit: "community",
  sr: "community",
  t5: "community",
  user: "user",
  account: "user",
  t2: "user",
};

export function fieldMapForActor(actorId: string): FieldMap {
  // Strip an Apify build tag (`actor:tag`) before lookup.
  const base = actorId.split(":", 1)[0];
  return FIELD_MAP_BY_ACTOR[base] ?? DEFAULT_FIELD_MAP;
}

function firstPresent(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function asStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function asNumber(value: unknown): number | null {
  // Reject booleans: `typeof true === "boolean"`, but a flag is never a count.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInt(value: unknown): number | null {
  const n = asNumber(value);
  return n === null ? null : Math.trunc(n);
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(low)) return true;
    if (["false", "0", "no", ""].includes(low)) return false;
  }
  return null;
}

function asIso(value: unknown): string | null {
  // A Unix epoch (seconds) becomes an ISO8601 UTC string; a string passes
  // through unchanged (trudax already emits ISO8601).
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string") return value.trim() || null;
  return null;
}

function asType(value: unknown): RedditItemType | null {
  if (typeof value !== "string") return null;
  return TYPE_ALIASES[value.trim().toLowerCase()] ?? null;
}

function cleanSubreddit(value: unknown): string | null {
  const text = asStr(value)?.trim();
  if (!text) return null;
  for (const prefix of ["/r/", "r/"]) {
    if (text.toLowerCase().startsWith(prefix)) return text.slice(prefix.length) || null;
  }
  return text;
}

function derivePermalink(explicit: unknown, url: unknown): string | null {
  // Prefer an explicit permalink; otherwise recover the path from a reddit.com
  // URL so downstream consumers get a stable permalink even when the Actor only
  // returns a full URL.
  const text = asStr(explicit);
  if (text) return text;
  const full = asStr(url);
  if (!full) return null;
  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.pathname && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
    return parsed.pathname;
  }
  return null;
}

/** Map one raw Actor item onto the stable NormalizedRedditItem shape. */
export function normalizeItem(raw: Record<string, unknown>, actorId: string): NormalizedRedditItem {
  const fmap = fieldMapForActor(actorId);
  const pick = (field: keyof FieldMap): unknown => firstPresent(raw, fmap[field]);
  return {
    id: asStr(pick("id")),
    type: asType(pick("type")),
    title: asStr(pick("title")),
    body: asStr(pick("body")),
    author: asStr(pick("author")),
    subreddit: cleanSubreddit(pick("subreddit")),
    url: asStr(pick("url")),
    permalink: derivePermalink(pick("permalink"), pick("url")),
    created_at: asIso(pick("created_at")),
    score: asInt(pick("score")),
    num_comments: asInt(pick("num_comments")),
    upvote_ratio: asNumber(pick("upvote_ratio")),
    over_18: asBool(pick("over_18")),
    num_crossposts: asInt(pick("num_crossposts")),
    raw,
  };
}

export function normalizeItems(
  items: Record<string, unknown>[],
  actorId: string,
): NormalizedRedditItem[] {
  return items.map((item) => normalizeItem(item, actorId));
}
