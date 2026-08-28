/**
 * Pure, runtime-agnostic helpers for the reddit MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * the Apify Actor's schema, what a well-formed dataset looks like) are the part
 * worth unit-testing, and keeping them dependency-free lets `bun test` exercise
 * them offline with no workerd / network.
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
