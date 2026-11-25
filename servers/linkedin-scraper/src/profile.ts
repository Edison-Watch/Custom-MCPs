/**
 * Pure, runtime-agnostic helpers for the linkedin connector's people-search
 * tool (`linkedin_profile_search`).
 *
 * Backed by the `harvestapi/linkedin-profile-search` Apify Actor - a *different*
 * Actor from the post scraper in `linkedin.ts`. Given a fuzzy query and/or a set
 * of string filters (job titles, companies, locations, schools, names) it
 * returns matching public LinkedIn people profiles. No cookies or account.
 *
 * Two guards live here on purpose, because this wraps a PUBLIC, paid Actor:
 *   - A run must have a real target (a query or at least one filter list); a
 *     lone boolean refinement like "recently posted" would otherwise scrape the
 *     whole network. See {@link hasProfileSearchTarget}.
 *   - `maxItems` is always bounded (default 10), so a caller can never trigger
 *     an unbounded, arbitrarily costly run.
 *
 * The Actor's opaque *-Id filters (industryIds, seniorityLevelIds, functionIds,
 * years-of-experience, ...) take LinkedIn-internal numeric IDs a caller can't
 * know, and its MongoDB/dedup/segmentation knobs are power-user plumbing, so
 * neither is exposed: this tool takes only human-legible string filters.
 */

import { normalizeStringList, normalizeSearch } from "./linkedin";

export const DEFAULT_PROFILE_ACTOR_ID = "harvestapi~linkedin-profile-search";

/** Default profiles returned when the caller doesn't set `max_items`. */
export const DEFAULT_PROFILE_MAX_ITEMS = 10;

/**
 * Hard cap on profiles per call. Each returned profile is a billed Actor item,
 * so an unbounded `maxItems` would let a caller force an arbitrarily large paid
 * run; enforced both at the tool's input schema and in {@link buildProfileSearchInput}.
 */
export const MAX_PROFILE_MAX_ITEMS = 100;

/**
 * How much detail to pull per profile. "Short" is the cheaper summary; "Full"
 * is the rich profile. The Actor's third mode, "Full + email search", is
 * deliberately *not* offered: it pulls personal emails, an escalation this
 * PUBLIC tool shouldn't make on the caller's behalf.
 */
export type ProfileScraperMode = "Short" | "Full";

export interface LinkedinProfileSearchArgs {
  search?: string;
  mode?: ProfileScraperMode;
  max_items?: number;
  locations?: string[];
  current_companies?: string[];
  past_companies?: string[];
  schools?: string[];
  current_job_titles?: string[];
  past_job_titles?: string[];
  first_names?: string[];
  last_names?: string[];
  recently_changed_jobs?: boolean;
  recently_posted?: boolean;
}

/**
 * The caller's string filters, mapped to the Actor's array field names. A run
 * with any of these (or a `search`) is a real, bounded query; a run with none
 * would scrape the whole network, so the tool rejects it.
 */
const FILTER_FIELDS: Array<[keyof LinkedinProfileSearchArgs, string]> = [
  ["locations", "locations"],
  ["current_companies", "currentCompanies"],
  ["past_companies", "pastCompanies"],
  ["schools", "schools"],
  ["current_job_titles", "currentJobTitles"],
  ["past_job_titles", "pastJobTitles"],
  ["first_names", "firstNames"],
  ["last_names", "lastNames"],
];

/** The normalized, non-empty filter lists keyed by the Actor's field names. */
function normalizedFilters(args: LinkedinProfileSearchArgs): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [argKey, actorKey] of FILTER_FIELDS) {
    const list = normalizeStringList(args[argKey] as string[] | undefined);
    if (list.length > 0) out[actorKey] = list;
  }
  return out;
}

/**
 * A search needs a real target: a non-blank query or at least one non-empty
 * filter list. The boolean refinements (`recently_changed_jobs`,
 * `recently_posted`) narrow a query but can't stand alone - on their own they'd
 * ask the Actor to scrape the entire network.
 */
export function hasProfileSearchTarget(args: LinkedinProfileSearchArgs): boolean {
  if (normalizeSearch(args.search)) return true;
  return Object.keys(normalizedFilters(args)).length > 0;
}

/** Clamp `max_items` into [1, {@link MAX_PROFILE_MAX_ITEMS}], defaulting when unset. */
export function boundedMaxItems(maxItems: number | undefined): number {
  if (maxItems === undefined || !Number.isFinite(maxItems)) return DEFAULT_PROFILE_MAX_ITEMS;
  return Math.max(1, Math.min(MAX_PROFILE_MAX_ITEMS, Math.floor(maxItems)));
}

/** Map the caller's input onto the Actor's input schema. */
export function buildProfileSearchInput(args: LinkedinProfileSearchArgs): Record<string, unknown> {
  const input: Record<string, unknown> = {
    profileScraperMode: args.mode ?? "Short",
    maxItems: boundedMaxItems(args.max_items),
    ...normalizedFilters(args),
  };
  const search = normalizeSearch(args.search);
  if (search) input.searchQuery = search;
  if (args.recently_changed_jobs) input.recentlyChangedJobs = true;
  if (args.recently_posted) input.recentlyPostedOnLinkedIn = true;
  return input;
}
