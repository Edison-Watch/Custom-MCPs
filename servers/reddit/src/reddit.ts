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

// Per-Actor field maps live in ./adapters; normalizeItem resolves one through
// this helper. The import is call-time only (used inside normalizeItem), so the
// reddit <-> adapters cycle is safe: neither module touches the other at init.
import { fieldMapForActor } from "./adapters";

export const APIFY_BASE = "https://api.apify.com/v2";

/**
 * The reddit-scraper Actor the fleet server runs by default. Every supported
 * Actor maps onto the same normalized item shape via a per-Actor adapter (input
 * builder + output field map; see below), so the choice is a cost/reliability
 * decision, not a contract change:
 *
 *  - fatihtahta/reddit-scraper-search-fast ("Enterprise Grade") - the default.
 *    In production it ran ~2.5x cheaper per run than trudax/reddit-scraper-lite
 *    ($0.042 vs $0.105) and, unlike lite, never TIMED-OUT on keyword searches
 *    (lite timed out on ~16% of runs, each still billed). Reddit-native
 *    snake_case output.
 *  - trudax/reddit-scraper-lite - the prior default, kept fully supported as an
 *    instant rollback: set APIFY_ACTOR_ID to it (no redeploy of logic needed).
 *
 * Tilde form is the URL-safe "username~name".
 */
export const DEFAULT_ACTOR_ID = "fatihtahta~reddit-scraper-search-fast";

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
  include_media_links?: boolean;
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

// Per-Actor input building (and output field maps) live in ./adapters, keyed by
// Actor slug. buildActorInput / fieldMapForActor there resolve from one registry
// so the input we send and the output we normalize can never disagree.

/** Strip any trailing slashes from the API base so path joins never double up. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The synchronous run-and-fetch-dataset endpoint for an Actor. */
export function runSyncUrl(actorId: string, base: string = APIFY_BASE): string {
  return `${normalizeBase(base)}/acts/${actorId}/run-sync-get-dataset-items`;
}

// --- Async run + poll -------------------------------------------------------
//
// runSyncUrl blocks one subrequest on the whole run, which the innermost MCP
// client can cut off long before a slow keyword search finishes. The endpoints
// and parsers below decouple start from poll: `reddit_scrape_start` POSTs to
// runsUrl for a run id, `reddit_scrape_fetch` GETs runStatusUrl and, once the
// run has SUCCEEDED, datasetItemsUrl. Mirrors services/reddit_svc.py.

/** Non-blocking run-enqueue endpoint: POST returns a run without waiting on it. */
export function runsUrl(actorId: string, base: string = APIFY_BASE): string {
  return `${normalizeBase(base)}/acts/${actorId}/runs`;
}

/**
 * Run-status endpoint: GET returns the run's `{ status, defaultDatasetId }`.
 * `runId` is caller-supplied, so encode it as a single path segment - a value
 * carrying `/` or `?` can never escape into the path or query.
 */
export function runStatusUrl(runId: string, base: string = APIFY_BASE): string {
  return `${normalizeBase(base)}/actor-runs/${encodeURIComponent(runId)}`;
}

/** Dataset items endpoint for a finished run; `datasetId` is encoded per segment. */
export function datasetItemsUrl(datasetId: string, base: string = APIFY_BASE): string {
  return `${normalizeBase(base)}/datasets/${encodeURIComponent(datasetId)}/items`;
}

/**
 * Apify run statuses. SUCCEEDED is the only terminal-success state; the failures
 * are terminal but yield no items; everything else means "still running, poll
 * again". https://docs.apify.com/platform/actors/running/runs-and-builds#lifecycle
 */
export const SUCCEEDED = "SUCCEEDED";
export const TERMINAL_FAILURE: ReadonlySet<string> = new Set(["FAILED", "TIMED-OUT", "ABORTED"]);

export type RunStartResult =
  | { ok: true; run_id: string; dataset_id: string; status: string }
  | { ok: false; error: string };

/** Parse an Apify run-enqueue envelope `{ data: { id, defaultDatasetId, status } }`. */
export function parseRunStart(json: unknown): RunStartResult {
  const data = extractData(json);
  if (!data) return { ok: false, error: `unexpected Apify response shape: ${typeof json}` };
  const run_id = asStr(data.id);
  const dataset_id = asStr(data.defaultDatasetId);
  const status = asStr(data.status);
  if (!run_id || !dataset_id || !status) {
    return { ok: false, error: "Apify run response is missing id/defaultDatasetId/status" };
  }
  return { ok: true, run_id, dataset_id, status };
}

export type RunStatusResult =
  | { ok: true; status: string; dataset_id: string | null }
  | { ok: false; error: string };

/** Parse an Apify run-status envelope `{ data: { status, defaultDatasetId } }`. */
export function parseRunStatus(json: unknown): RunStatusResult {
  const data = extractData(json);
  if (!data) return { ok: false, error: `unexpected Apify response shape: ${typeof json}` };
  const status = asStr(data.status);
  if (!status) return { ok: false, error: "Apify run response is missing status" };
  return { ok: true, status, dataset_id: asStr(data.defaultDatasetId) };
}

function extractData(json: unknown): Record<string, unknown> | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const data = (json as Record<string, unknown>).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
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
// Callers never depend on a specific Actor's raw keys: normalizeItem maps every
// item onto the stable NormalizedRedditItem shape using that Actor's field map
// (a normalized field -> ordered candidate source keys; first present wins),
// resolved via fieldMapForActor in ./adapters. Mirrors the Python normalizer in
// services/reddit_normalize.py.

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

/**
 * A field map keys a normalized field to an ordered list of candidate source
 * keys. Defined here (beside NormalizedRedditItem) but populated per-Actor in
 * ./adapters.
 */
export type FieldMap = Record<keyof Omit<NormalizedRedditItem, "raw">, string[]>;

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
