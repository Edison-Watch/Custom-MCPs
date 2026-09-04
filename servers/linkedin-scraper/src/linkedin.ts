/**
 * Pure, runtime-agnostic helpers for the linkedin MCP server.
 *
 * Nothing here touches Cloudflare bindings, the MCP SDK, or `fetch` on purpose:
 * the real decisions (what target is valid, how the first-party input maps onto
 * the Apify Actor's schema, what a well-formed dataset looks like) are the part
 * worth unit-testing, and keeping them dependency-free lets `bun test` exercise
 * them offline with no workerd / network.
 *
 * Mirrors the design of the reddit connector, wrapping the HarvestAPI LinkedIn
 * post-search Actor's synchronous `run-sync-get-dataset-items` endpoint (one
 * blocking call, no polling) and returning the raw dataset items. The Actor
 * scrapes only public LinkedIn posts and needs no cookies or account.
 */

export const APIFY_BASE = "https://api.apify.com/v2";

/**
 * harvestapi/linkedin-post-search ("No Cookies"): pay-per-result (~$0.002/post),
 * searches public LinkedIn posts by query or by author profile/company URLs.
 * Tilde form is the URL-safe "username~name".
 */
export const DEFAULT_ACTOR_ID = "harvestapi~linkedin-post-search";

/**
 * Cap the synchronous Apify run. Lower than the Python service default (300s): a
 * Worker subrequest has a tighter wall-clock budget than a long-lived process,
 * and small `max_items` queries return well within this. Bump `max_items` down,
 * not this up, for heavier scrapes.
 */
export const RUN_TIMEOUT_S = 120;

export type LinkedinSort = "relevance" | "date";
export type LinkedinPostedWithin = "1h" | "24h" | "week" | "month" | "3months" | "6months" | "year";

export interface LinkedinScrapeArgs {
  search?: string;
  start_urls?: string[];
  sort?: LinkedinSort;
  posted_within?: LinkedinPostedWithin;
  max_items?: number;
}

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

/** Hosts we accept as LinkedIn targets (plus their `www.`/country subdomains). */
const LINKEDIN_HOSTS = ["linkedin.com"];

/**
 * True only for a well-formed http(s) URL on a LinkedIn host. Guards a PUBLIC,
 * paid Actor: a blank or off-domain `start_urls` entry must never be forwarded
 * to Apify as if it were a real author target.
 */
export function isLinkedinUrl(candidate: string): boolean {
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
  return LINKEDIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Trim a free-text string list, drop blank/whitespace-only entries, and
 * de-duplicate case-insensitively while preserving first-seen order. Shared by
 * the profile-search and company tools to sanitize their filter arrays before
 * they reach a paid Actor run.
 */
export function normalizeStringList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Keep only well-formed LinkedIn `start_urls`, trimmed and de-duplicated in order. */
export function validStartUrls(urls: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls ?? []) {
    const trimmed = raw.trim();
    if (!isLinkedinUrl(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** The lowercased first non-empty path segment of a URL (e.g. "in", "company"), or "". */
function firstPathSegment(url: string): string {
  try {
    return (new URL(url).pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * {@link validStartUrls} narrowed to LinkedIn URLs whose first path segment is
 * `segment` (e.g. "in" for member profiles, "company" for company pages). Keeps
 * a company/feed/search URL from being sent to a profile-only Actor - or vice
 * versa - which would waste or invalidate a paid run.
 */
export function validLinkedinUrls(urls: string[] | undefined, segment: string): string[] {
  const want = segment.toLowerCase();
  return validStartUrls(urls).filter((url) => firstPathSegment(url) === want);
}

/** A query needs at least one target: a real search term or one valid LinkedIn URL. */
export function hasTarget(args: LinkedinScrapeArgs): boolean {
  return Boolean(normalizeSearch(args.search)) || validStartUrls(args.start_urls).length > 0;
}

/** Map the first-party input onto the Actor's input schema. */
export function buildActorInput(args: LinkedinScrapeArgs): Record<string, unknown> {
  const search = normalizeSearch(args.search);
  const startUrls = validStartUrls(args.start_urls);
  // The Actor treats maxPosts:0 as "scrape everything" - always send a bounded
  // value so a PUBLIC caller can never trigger an unbounded (costly) run.
  const maxItems = args.max_items ?? 10;

  const actorInput: Record<string, unknown> = {
    maxPosts: maxItems,
    sortBy: args.sort ?? "date",
  };
  if (search) actorInput.searchQueries = [search];
  // authorUrls are plain LinkedIn profile/company URL strings.
  if (startUrls.length > 0) actorInput.authorUrls = startUrls;
  if (args.posted_within) actorInput.postedLimit = args.posted_within;
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
