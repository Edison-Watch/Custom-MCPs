/**
 * Pure, runtime-agnostic helpers for the youtube MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * each Apify Actor's schema, how search results become comment targets, what a
 * well-formed dataset looks like) are the part worth unit-testing, and keeping
 * them dependency-free lets `bun test` exercise them offline with no workerd /
 * network.
 *
 * Mirrors the design of the reddit connector, but YouTube's Apify ecosystem
 * splits search and comments across two Actors, so this wraps both: the search
 * Actor turns a query (or start URLs) into videos, and the comments Actor turns
 * the resulting video URLs into comments (only when comments are requested).
 */

export const APIFY_BASE = "https://api.apify.com/v2";

/** streamers/youtube-scraper: search results, channels, playlists -> videos. */
export const SEARCH_ACTOR_ID = "streamers~youtube-scraper";
/** streamers/youtube-comments-scraper: video URLs -> comments. */
export const COMMENTS_ACTOR_ID = "streamers~youtube-comments-scraper";

/**
 * Cap each synchronous Apify run. Lower than the Python service's 300s: a Worker
 * subrequest has a tighter wall-clock budget than a long-lived Python process,
 * and this connector chains up to two runs. Bump `max_results`/`max_comments`
 * down, not this up, for heavier scrapes.
 */
export const RUN_TIMEOUT_S = 120;

export type YoutubeSort = "relevance" | "rating" | "date" | "views";
export type YoutubeDate = "hour" | "today" | "week" | "month" | "year";
export type YoutubeCommentSort = "top" | "new";

export interface YoutubeScrapeArgs {
  search?: string;
  start_urls?: string[];
  sort?: YoutubeSort;
  date_filter?: YoutubeDate;
  max_results?: number;
  max_comments?: number;
  comment_sort?: YoutubeCommentSort;
}

/** Our friendly comment-sort keys -> the comments Actor's enum. */
export const COMMENT_SORT_MAP: Record<YoutubeCommentSort, string> = {
  top: "TOP_COMMENTS",
  new: "NEWEST_FIRST",
};

/**
 * Normalize a search term: trim, and treat blank/whitespace-only as absent so a
 * useless `searchQueries: ["  "]` is never sent to Apify (it must instead hit
 * the "provide a search or URLs" error).
 */
export function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return undefined;
  const trimmed = search.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Hosts we accept as YouTube targets (plus their `www.`/`m.`/`music.` subdomains). */
const YOUTUBE_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

/**
 * True only for a well-formed http(s) URL on a YouTube host. Guards a PUBLIC,
 * paid Actor: a blank or non-YouTube `start_urls` entry must never be forwarded
 * to Apify as if it were a real target.
 */
export function isYoutubeUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // Never forward a URL carrying embedded credentials (user:pass@host) to Apify.
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Keep only well-formed YouTube `start_urls`, trimmed and de-duplicated in order. */
export function validStartUrls(urls: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls ?? []) {
    const trimmed = raw.trim();
    if (!isYoutubeUrl(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** A query needs at least one target: a real search term or one valid YouTube URL. */
export function hasTarget(args: YoutubeScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || validStartUrls(args.start_urls).length > 0;
}

/** Map the first-party input onto the search Actor's input schema. */
export function buildSearchInput(args: YoutubeScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = validStartUrls(args.start_urls);
  const maxResults = args.max_results ?? 10;

  const actorInput: Record<string, unknown> = {
    maxResults,
    // Keep the run scoped to standard videos; callers target shorts/streams
    // explicitly via start_urls when they need them.
    maxResultsShorts: 0,
    maxResultStreams: 0,
    sortingOrder: args.sort ?? "relevance",
  };
  if (search) actorInput.searchQueries = [search];
  if (startUrls.length > 0) actorInput.startUrls = startUrls.map((url) => ({ url }));
  if (args.date_filter) actorInput.dateFilter = args.date_filter;
  return actorInput;
}

/** Map resolved video URLs + options onto the comments Actor's input schema. */
export function buildCommentsInput(
  urls: string[],
  maxComments: number,
  commentSort: YoutubeCommentSort,
): Record<string, unknown> {
  return {
    startUrls: urls.map((url) => ({ url })),
    maxComments,
    sortCommentsBy: COMMENT_SORT_MAP[commentSort],
  };
}

/**
 * Canonical watch URLs for the scraped videos, de-duplicated in order. Prefer
 * building `watch?v=<id>` from the video id so playlist/radio query params on
 * the raw `url` don't confuse the comments Actor; fall back to the raw url when
 * no id is present, and skip entries that carry neither.
 */
export function videoUrls(videos: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const v of videos) {
    const id = typeof v.id === "string" ? v.id : undefined;
    const raw = typeof v.url === "string" ? v.url : undefined;
    const url = id ? `https://www.youtube.com/watch?v=${id}` : raw;
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
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
