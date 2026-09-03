/**
 * Pure, runtime-agnostic helpers for the x-scraper (X / Twitter) MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * the Apify Actor's schema, what a well-formed dataset looks like) are the part
 * worth unit-testing, and keeping them dependency-free lets `bun test` exercise
 * them offline with no workerd / network.
 *
 * Wraps the Apify tweet-scraper Actor's synchronous `run-sync-get-dataset-items`
 * endpoint (one blocking call, no polling) and returns the raw dataset items.
 */

export const APIFY_BASE = "https://api.apify.com/v2";

/**
 * kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest: reliable
 * pay-per-result X scraper (~$0.00025/tweet). Search-based (X advanced-search
 * operators supported in the query), plus a dedicated `from` handle field.
 * Tilde form is the URL-safe "username~name".
 */
export const DEFAULT_ACTOR_ID = "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";

/**
 * Cap the synchronous Apify run. Lower than the Python service default (300s): a
 * Worker subrequest has a tighter wall-clock budget than a long-lived process,
 * and small `max_items` queries return well within this. Bump `max_items` down,
 * not this up, for heavier scrapes.
 */
export const RUN_TIMEOUT_S = 120;

/** The Actor's `queryType`: sort/kind of the search results. */
export type XSort = "Latest" | "Top" | "Photos" | "Videos";

export interface XScrapeArgs {
  search?: string;
  from_user?: string;
  sort?: XSort;
  since?: string;
  until?: string;
  max_items?: number;
  only_verified?: boolean;
}

/**
 * Normalize a search term: trim, and treat blank/whitespace-only as absent so a
 * useless `twitterContent: "  "` is never sent to Apify (it must instead hit the
 * "provide a search or from_user" error).
 */
export function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return undefined;
  const trimmed = search.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Normalize an X handle: trim and drop a single leading '@' if present. */
export function normalizeHandle(handle: string | undefined): string | undefined {
  if (handle === undefined) return undefined;
  const trimmed = handle.trim().replace(/^@/, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A query needs at least one target: a real search term or a `from_user` handle
 * (either can stand alone - `from:` alone is a valid X search).
 */
export function hasTarget(args: XScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || Boolean(normalizeHandle(args.from_user));
}

/**
 * The Actor's date fields want `YYYY-MM-DD_HH:MM:SS_UTC`. Accept a bare
 * `YYYY-MM-DD` from the caller and anchor it to the given time-of-day; pass any
 * other (already time-qualified) value through untouched.
 */
export function formatDateBound(value: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}_${endOfDay ? "23:59:59" : "00:00:00"}_UTC`;
  }
  return trimmed;
}

/** Map the first-party input onto the Actor's input schema. */
export function buildActorInput(args: XScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const fromUser = normalizeHandle(args.from_user);
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxItems,
    queryType: args.sort ?? "Latest",
  };
  if (search) actorInput.twitterContent = search;
  if (fromUser) actorInput.from = fromUser;
  if (args.since) actorInput.since = formatDateBound(args.since, false);
  if (args.until) actorInput.until = formatDateBound(args.until, true);
  // Colon-keyed Actor flag: only tweets from Twitter Blue (verified) accounts.
  if (args.only_verified) actorInput["filter:blue_verified"] = true;
  return actorInput;
}

/** The synchronous run-and-fetch-dataset endpoint for an Actor. */
export function runSyncUrl(actorId: string, base: string = APIFY_BASE): string {
  // Trim any trailing slash on `base` (e.g. an APIFY_BASE_URL override ending in
  // "/") so we never build a double-slash `//acts` path Apify would 404.
  return `${base.replace(/\/+$/, "")}/acts/${actorId}/run-sync-get-dataset-items`;
}

export type DatasetResult =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; error: string };

/**
 * Validate a parsed Apify response: it must be a JSON array whose every element
 * is a plain object. Anything else (notably an Apify `{error}` object) is
 * surfaced as an error rather than handed back as malformed data.
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
