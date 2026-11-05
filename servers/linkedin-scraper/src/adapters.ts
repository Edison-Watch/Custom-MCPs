/**
 * Per-Actor adapters for the linkedin MCP server's `linkedin_scrape` tool.
 *
 * Each supported Apify Actor takes a different input schema and emits different
 * output field names. An adapter pairs an input builder with an output
 * normalizer so callers keep receiving HarvestAPI-shaped keys when they opt
 * into an alternate Actor. The default stays harvestapi/linkedin-post-search;
 * set `APIFY_ACTOR_ID` to switch, and clear it to roll back.
 *
 * Mirrors the reddit connector's per-Actor registry in ./adapters (relative to
 * servers/reddit/src).
 */
import {
  buildActorInput as buildHarvestInput,
  normalizeSearch,
  validStartUrls,
  type LinkedinPostedWithin,
  type LinkedinScrapeArgs,
} from "./linkedin";

export const JOHNVC_POST_SEARCH_ACTOR_ID = "johnvc~linkedin-post-search-api";

export type NormalizedScrapeResult = {
  items: Record<string, unknown>[];
  errors: Record<string, unknown>[];
};

export type ActorAdapter = {
  buildInput: (args: LinkedinScrapeArgs) => Record<string, unknown>;
  normalizeOutput: (raw: Record<string, unknown>[]) => NormalizedScrapeResult;
};

/** Pass through HarvestAPI items unchanged (default path). */
function normalizeHarvestOutput(raw: Record<string, unknown>[]): NormalizedScrapeResult {
  return { items: raw, errors: [] };
}

/**
 * Map Edison `posted_within` onto the johnvc Actor's `postedWithin` enum or a
 * UTC `startDate`. `1h` widens to `day`. `3months` / `6months` become a start
 * date 90 / 180 days ago. `sort` has no equivalent and is ignored by the caller.
 */
export function mapPostedWithin(
  postedWithin: LinkedinPostedWithin | undefined,
  now: Date = new Date(),
): { postedWithin?: string; startDate?: string } {
  if (!postedWithin) return {};
  if (postedWithin === "1h" || postedWithin === "24h") return { postedWithin: "day" };
  if (postedWithin === "week" || postedWithin === "month" || postedWithin === "year") {
    return { postedWithin };
  }
  const days = postedWithin === "3months" ? 90 : 180;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - days);
  const yyyy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(start.getUTCDate()).padStart(2, "0");
  return { startDate: `${yyyy}-${mm}-${dd}` };
}

/**
 * The Actor refuses operators and quotes in keywords. Surface that before a paid run.
 */
export function assertJohnvcKeyword(search: string): void {
  if (/["']/.test(search) || /\b(AND|OR|NOT)\b/.test(search)) {
    throw new Error(
      "johnvc/linkedin-post-search-api accepts exact phrases only; remove quotes and boolean operators",
    );
  }
}

/**
 * Build johnvc/linkedin-post-search-api input. Keyword search only: `start_urls`
 * are rejected because that Actor has no author-URL mode.
 */
export function buildJohnvcPostSearchInput(args: LinkedinScrapeArgs): Record<string, unknown> {
  const startUrls = validStartUrls(args.start_urls);
  if (startUrls.length > 0) {
    throw new Error(
      "johnvc/linkedin-post-search-api searches by keyword only; do not pass start_urls under this adapter",
    );
  }
  const search = normalizeSearch(args.search);
  if (!search) {
    throw new Error("johnvc/linkedin-post-search-api requires a non-empty search query");
  }
  assertJohnvcKeyword(search);

  const maxItems = args.max_items ?? 10;
  const actorInput: Record<string, unknown> = {
    keywords: [search],
    maxPostsPerKeyword: maxItems,
  };
  // sort is intentionally ignored: the Actor has no sort input.
  const window = mapPostedWithin(args.posted_within);
  if (window.postedWithin) actorInput.postedWithin = window.postedWithin;
  if (window.startDate) actorInput.startDate = window.startDate;
  return actorInput;
}

/**
 * Normalize a johnvc post row onto the HarvestAPI-style keys callers read today.
 * Extra fields (hashtags, taggedCompanies, topComments, matchedKeyword, ...) pass through.
 */
export function normalizeJohnvcPost(raw: Record<string, unknown>): Record<string, unknown> {
  const authorName = raw.authorName;
  const authorUrl = raw.authorUrl;
  const authorHeadline = raw.authorHeadline;
  const datePosted = raw.datePosted;

  const normalized: Record<string, unknown> = {
    ...raw,
    id: raw.postId ?? raw.id,
    content: raw.text ?? raw.content,
    linkedinUrl: raw.postUrl ?? raw.linkedinUrl,
    author: {
      name: authorName ?? null,
      linkedinUrl: authorUrl ?? null,
      info: authorHeadline ?? null,
    },
    postedAt: {
      date: datePosted ?? null,
    },
    engagement: {
      likes: raw.numLikes ?? null,
      comments: raw.numComments ?? null,
      shares: null,
    },
  };
  return normalized;
}

export function normalizeJohnvcOutput(raw: Record<string, unknown>[]): NormalizedScrapeResult {
  const items: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const row of raw) {
    if (row.resultType === "error") {
      errors.push(row);
      continue;
    }
    items.push(normalizeJohnvcPost(row));
  }
  return { items, errors };
}

const HARVEST_ADAPTER: ActorAdapter = {
  buildInput: buildHarvestInput,
  normalizeOutput: normalizeHarvestOutput,
};

const JOHNVC_ADAPTER: ActorAdapter = {
  buildInput: buildJohnvcPostSearchInput,
  normalizeOutput: normalizeJohnvcOutput,
};

export const ADAPTER_BY_ACTOR: Record<string, ActorAdapter> = {
  "harvestapi~linkedin-post-search": HARVEST_ADAPTER,
  [JOHNVC_POST_SEARCH_ACTOR_ID]: JOHNVC_ADAPTER,
};

export function adapterForActor(actorId: string): ActorAdapter {
  const base = actorId.split(":", 1)[0];
  return ADAPTER_BY_ACTOR[base] ?? HARVEST_ADAPTER;
}

/** Map the first-party input onto the configured Actor's own input schema. */
export function buildActorInputForActor(
  args: LinkedinScrapeArgs,
  actorId: string,
): Record<string, unknown> {
  return adapterForActor(actorId).buildInput(args);
}

/** Normalize raw dataset rows for the configured Actor. */
export function normalizeOutputForActor(
  raw: Record<string, unknown>[],
  actorId: string,
): NormalizedScrapeResult {
  return adapterForActor(actorId).normalizeOutput(raw);
}
