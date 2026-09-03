/**
 * Pure, runtime-agnostic helpers for the x (X / Twitter) MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * the Apify Actor's schema, what a well-formed dataset looks like) are the part
 * worth unit-testing, and keeping them dependency-free lets `bun test` exercise
 * them offline with no workerd / network.
 *
 * Mirrors the design of the reddit connector, wrapping the Apify tweet-scraper
 * Actor's synchronous `run-sync-get-dataset-items` endpoint (one blocking call,
 * no polling) and returning the raw dataset items.
 */

export const APIFY_BASE = "https://api.apify.com/v2";

/**
 * apidojo/tweet-scraper ("Tweet Scraper V2"): pay-per-result (~$0.0004/tweet),
 * search / URL / list / profile scraping. Tilde form is the URL-safe
 * "username~name".
 */
export const DEFAULT_ACTOR_ID = "apidojo~tweet-scraper";

/**
 * Cap the synchronous Apify run. Lower than the Python service default (300s): a
 * Worker subrequest has a tighter wall-clock budget than a long-lived process,
 * and small `max_items` queries return well within this. Bump `max_items` down,
 * not this up, for heavier scrapes.
 */
export const RUN_TIMEOUT_S = 120;

export type XSort = "Top" | "Latest" | "Latest + Top";

export interface XScrapeArgs {
  search?: string;
  start_urls?: string[];
  sort?: XSort;
  since?: string;
  until?: string;
  max_items?: number;
  only_verified?: boolean;
}

/**
 * Normalize a search term: trim, and treat blank/whitespace-only as absent so a
 * useless `searchTerms: ["  "]` is never sent to Apify (it must instead hit the
 * "provide a search or URLs" error).
 */
export function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return undefined;
  const trimmed = search.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Hosts we accept as X targets (plus their `www.`/`mobile.`/`m.` subdomains). */
const X_HOSTS = ["twitter.com", "x.com"];

/**
 * True only for a well-formed http(s) URL on an X / Twitter host. Guards a
 * PUBLIC, paid Actor: a blank or off-domain `start_urls` entry must never be
 * forwarded to Apify as if it were a real target.
 */
export function isXUrl(candidate: string): boolean {
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
  return X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Keep only well-formed X `start_urls`, trimmed and de-duplicated in order. */
export function validStartUrls(urls: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls ?? []) {
    const trimmed = raw.trim();
    if (!isXUrl(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** A query needs at least one target: a real search term or one valid X URL. */
export function hasTarget(args: XScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || validStartUrls(args.start_urls).length > 0;
}

/** Map the first-party input onto the Actor's input schema. */
export function buildActorInput(args: XScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = validStartUrls(args.start_urls);
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxItems,
    sort: args.sort ?? "Latest",
  };
  if (search) actorInput.searchTerms = [search];
  // apidojo/tweet-scraper takes startUrls as plain URL strings (not {url} objects).
  if (startUrls.length > 0) actorInput.startUrls = startUrls;
  if (args.since) actorInput.start = args.since;
  if (args.until) actorInput.end = args.until;
  if (args.only_verified) actorInput.onlyVerifiedUsers = true;
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
