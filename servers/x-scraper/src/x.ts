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

/**
 * Normalize an X handle: trim, drop a single leading '@', and validate the
 * result against X's handle grammar (1-15 chars of `[A-Za-z0-9_]`). A value that
 * isn't a well-formed handle returns undefined so it can't slip through
 * {@link hasTarget} and trigger a paid Apify scrape that can only fail.
 */
export function normalizeHandle(handle: string | undefined): string | undefined {
  if (handle === undefined) return undefined;
  const trimmed = handle.trim().replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * A query needs at least one target: a real search term or a `from_user` handle
 * (either can stand alone - `from:` alone is a valid X search).
 */
export function hasTarget(args: XScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || Boolean(normalizeHandle(args.from_user));
}

/**
 * Convert a caller-supplied date bound to the Actor's documented `since_time` /
 * `until_time` format: a Unix timestamp in **seconds**, as a string. A bare
 * `YYYY-MM-DD` is anchored to the start (or, for an upper bound, the end) of that
 * day in UTC; any other value is parsed as a datetime. Returns undefined for an
 * unparseable value so a bad bound is dropped rather than silently widening the
 * scrape.
 */
export function toUnixSeconds(value: string, endOfDay: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let ms: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const time = endOfDay ? "23:59:59" : "00:00:00";
    const parsed = new Date(`${trimmed}T${time}Z`);
    // Reject impossible dates (e.g. 2024-02-30): Date.UTC would silently roll
    // them over to the next month and apply the wrong scrape bound.
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return undefined;
    }
    ms = parsed.getTime();
  } else {
    ms = Date.parse(trimmed);
  }
  return Number.isNaN(ms) ? undefined : String(Math.floor(ms / 1000));
}

/**
 * Name the first date bound that was supplied but cannot be parsed, so the
 * caller can be rejected instead of running a paid scrape with that filter
 * silently dropped (which would widen the results). A blank/absent bound is not
 * an error - it just means "no bound".
 */
export function invalidDateBound(args: XScrapeArgs): "since" | "until" | undefined {
  if (args.since !== undefined && args.since.trim() !== "" && toUnixSeconds(args.since, false) === undefined) {
    return "since";
  }
  if (args.until !== undefined && args.until.trim() !== "" && toUnixSeconds(args.until, true) === undefined) {
    return "until";
  }
  return undefined;
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
  // Documented Actor date fields: Unix seconds (as strings) under since_time /
  // until_time. Drop a bound that doesn't parse rather than widen the scrape.
  const sinceTime = args.since ? toUnixSeconds(args.since, false) : undefined;
  const untilTime = args.until ? toUnixSeconds(args.until, true) : undefined;
  if (sinceTime) actorInput.since_time = sinceTime;
  if (untilTime) actorInput.until_time = untilTime;
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

/**
 * KaitoEasyAPI has a per-call billing floor: when a query matches few/no real
 * tweets it pads the dataset with filler items shaped
 * `{ type: "mock_tweet", id: -1, text: "From KaitoEasyAPI, a reminder:..." }`.
 * These carry no tweet data - passing them through only burns downstream (model)
 * context, so we drop them. A real tweet is `type: "tweet"` with a positive
 * snowflake id, so either discriminator alone is decisive; we check both to stay
 * robust if the Actor tweaks one.
 */
export function isFillerItem(item: Record<string, unknown>): boolean {
  return item.type === "mock_tweet" || item.id === -1 || item.id === "-1";
}

/** Drop KaitoEasyAPI billing-floor filler (see {@link isFillerItem}). */
export function stripFillerItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items.filter((item) => !isFillerItem(item));
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
