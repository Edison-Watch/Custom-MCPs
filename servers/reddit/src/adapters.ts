/**
 * Per-Actor adapters for the reddit MCP server.
 *
 * Each supported Apify Actor takes a different input schema *and* emits different
 * output field names. An adapter pairs the two halves - an input builder and an
 * output field map - into one object, so `buildActorInput` and `fieldMapForActor`
 * resolve from a single registry and can never disagree on the Actor. Adding an
 * Actor is a one-line data change here (one registry entry), not an edit spread
 * across the module.
 *
 * Mirrors the Python `services/reddit_adapters.py`; the two registries must
 * register the same Actor slugs (`tests/test_reddit_adapters.py` asserts this
 * cross-language). Depends only on the pure helpers/types in `./reddit`.
 */
import {
  normalizeSearch,
  type FieldMap,
  type RedditScrapeArgs,
  type RedditSort,
} from "./reddit";

// --- Output field maps ------------------------------------------------------

/**
 * The trudax family (reddit-scraper-lite and its flat-rate reddit-scraper
 * sibling) share one output schema, verified from Apify's documented actor
 * schemas: posts carry upVotes / numberOfComments / upVoteRatio; comments carry
 * numberOfVotes and their text under description. reddit-scraper-lite in its
 * default fast RSS mode omits the engagement fields, so they normalize to null;
 * setting include_media_links (the Actor's includeMediaLinks input) switches it
 * to a detailed scrape that returns them, and they flow through this same map.
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
 * Fallback for an Actor with no registered adapter: a broad candidate-key list
 * spanning snake_case (Reddit's own JSON API) and common camelCase variants.
 * Best-effort only - a bespoke Actor should get its own adapter rather than rely
 * on these guesses.
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

/**
 * fatihtahta/reddit-scraper-search-fast emits Reddit's native snake_case fields
 * plus derived extras. `kind` is the post/comment discriminator; `created_utc`
 * arrives as an ISO8601 string here (asIso also accepts an epoch number, so a
 * numeric variant still normalizes). Engagement counts are always present.
 */
const FATIHTAHTA_FIELD_MAP: FieldMap = {
  id: ["id"],
  type: ["kind"],
  title: ["title"],
  body: ["body"],
  author: ["author"],
  subreddit: ["subreddit", "subreddit_name_prefixed"],
  url: ["url", "canonical_url"],
  permalink: ["permalink"],
  created_at: ["created_utc"],
  score: ["score"],
  num_comments: ["num_comments"],
  upvote_ratio: ["upvote_ratio"],
  over_18: ["over_18"],
  num_crossposts: ["num_crossposts"],
};

// --- Per-Actor input builders ----------------------------------------------

/**
 * trudax/reddit-scraper-lite and its flat-rate reddit-scraper sibling share one
 * input schema: `searches`, `searchCommunityName`, `startUrls` as {url} objects,
 * `skipComments`, `time`, and an explicit residential-proxy block. Its fast RSS
 * mode omits engagement fields; `includeMediaLinks` switches it to a detailed
 * scrape that returns upVotes / numberOfComments / upVoteRatio (and media URLs),
 * which the trudax field map picks up.
 */
function buildTrudaxInput(args: RedditScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = args.start_urls ?? [];
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxItems,
    maxPostCount: maxItems,
    skipComments: !(args.include_comments ?? false),
    includeNSFW: args.include_nsfw ?? false,
    includeMediaLinks: args.include_media_links ?? false,
    sort: args.sort ?? "new",
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };
  if (search) actorInput.searches = [search];
  if (args.subreddit) actorInput.searchCommunityName = args.subreddit;
  if (startUrls.length > 0) actorInput.startUrls = startUrls.map((url) => ({ url }));
  if (args.time_filter) actorInput.time = args.time_filter;
  return actorInput;
}

/**
 * fatihtahta/reddit-scraper-search-fast uses its own input schema: `queries`
 * (not `searches`), `maxPosts` (not maxItems/maxPostCount), `urls` as bare
 * strings (not {url} objects), `scrapeComments` (not skipComments),
 * `subredditName` (not searchCommunityName), `timeframe` (not time), and
 * `includeNsfw`. It handles its own proxying, so no `proxy` block is sent, and
 * it always returns engagement fields, so `include_media_links` is a no-op here.
 */
function buildFatihtahtaInput(args: RedditScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = args.start_urls ?? [];
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxPosts: maxItems,
    scrapeComments: args.include_comments ?? false,
    includeNsfw: args.include_nsfw ?? false,
    sort: fatihtahtaSort(args.sort ?? "new"),
  };
  if (search) actorInput.queries = [search];
  if (args.subreddit) actorInput.subredditName = args.subreddit;
  if (startUrls.length > 0) actorInput.urls = startUrls;
  if (args.time_filter) actorInput.timeframe = args.time_filter;
  return actorInput;
}

/**
 * This Actor's `sort` enum omits "rising" (it offers relevance/hot/top/new/
 * comments). Map that one unsupported value onto the nearest trending sort so a
 * caller asking for "rising" gets sensible ordering instead of an Actor
 * input-validation error; every other value passes straight through.
 */
function fatihtahtaSort(sort: RedditSort): string {
  return sort === "rising" ? "hot" : sort;
}

// --- Adapter registry -------------------------------------------------------

interface ActorAdapter {
  buildInput: (args: RedditScrapeArgs) => Record<string, unknown>;
  fieldMap: FieldMap;
}

const TRUDAX_ADAPTER: ActorAdapter = { buildInput: buildTrudaxInput, fieldMap: TRUDAX_FIELD_MAP };
const FATIHTAHTA_ADAPTER: ActorAdapter = {
  buildInput: buildFatihtahtaInput,
  fieldMap: FATIHTAHTA_FIELD_MAP,
};
// Unknown Actor: the long-standing trudax-style input shape plus the broad,
// best-effort output map. A bespoke Actor should get its own adapter instead.
const DEFAULT_ADAPTER: ActorAdapter = { buildInput: buildTrudaxInput, fieldMap: DEFAULT_FIELD_MAP };

export const ADAPTER_BY_ACTOR: Record<string, ActorAdapter> = {
  "trudax~reddit-scraper-lite": TRUDAX_ADAPTER,
  "trudax~reddit-scraper": TRUDAX_ADAPTER,
  "fatihtahta~reddit-scraper-search-fast": FATIHTAHTA_ADAPTER,
};

export function adapterForActor(actorId: string): ActorAdapter {
  // Strip an Apify build tag (`actor:tag`) before lookup.
  const base = actorId.split(":", 1)[0];
  return ADAPTER_BY_ACTOR[base] ?? DEFAULT_ADAPTER;
}

/** Map the first-party input onto the configured Actor's own input schema. */
export function buildActorInput(
  args: RedditScrapeArgs,
  actorId: string,
): Record<string, unknown> {
  return adapterForActor(actorId).buildInput(args);
}

export function fieldMapForActor(actorId: string): FieldMap {
  return adapterForActor(actorId).fieldMap;
}
