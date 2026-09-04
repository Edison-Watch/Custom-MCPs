/**
 * Pure, runtime-agnostic helpers for the linkedin connector's profile-hydrate
 * tool (`linkedin_profile`).
 *
 * Backed by the `harvestapi/linkedin-profile-scraper` Apify Actor - a *different*
 * Actor from the post scraper in `linkedin.ts`, the people search in
 * `profile.ts`, and the company lookup in `company.ts`. Given one or more known
 * LinkedIn profile URLs it returns the full profile for each (name, headline,
 * current position, location, education, skills...). No cookies or account.
 *
 * This is the "hydrate a URL I already have" tool, distinct from
 * `linkedin_profile_search` which *finds* people from a query. Callers that
 * discovered a profile URL elsewhere (a post author, a search hit) use this to
 * pull the structured profile.
 *
 * Like the sibling tools this wraps a PUBLIC, paid Actor, so it enforces a real
 * target (at least one valid LinkedIn profile URL) and caps how many profiles
 * one call may request - each profile is a billed item.
 */

import { validStartUrls } from "./linkedin";

export const DEFAULT_PROFILE_HYDRATE_ACTOR_ID = "harvestapi~linkedin-profile-scraper";

/**
 * Hard cap on profiles per call. Each profile is a billed Actor item, so an
 * unbounded request would force an arbitrarily large paid run; enforced at the
 * tool's input schema and re-checked in the tool.
 */
export const MAX_PROFILE_URLS = 50;

/**
 * The Actor's cheaper scraper mode. Its other mode
 * ("Profile details + email search") attempts to resolve each person's personal
 * email - a PII escalation this PUBLIC tool deliberately never makes on the
 * caller's behalf (mirrors the withheld "Full + email search" mode in
 * `profile.ts`). Fixed, not caller-selectable.
 */
export const PROFILE_SCRAPER_MODE_NO_EMAIL = "Profile details no email ($4 per 1k)";

export interface LinkedinProfileArgs {
  profile_urls?: string[];
}

/** Valid LinkedIn profile URLs from the request, trimmed and de-duplicated. */
export function profileUrlTargets(args: LinkedinProfileArgs): string[] {
  return validStartUrls(args.profile_urls);
}

/** A request needs at least one valid LinkedIn profile URL. */
export function hasProfileTarget(args: LinkedinProfileArgs): boolean {
  return profileUrlTargets(args).length > 0;
}

/** Total distinct target URLs, used to enforce {@link MAX_PROFILE_URLS}. */
export function profileTargetCount(args: LinkedinProfileArgs): number {
  return profileUrlTargets(args).length;
}

/** Map the caller's input onto the Actor's input schema. */
export function buildProfileInput(args: LinkedinProfileArgs): Record<string, unknown> {
  return {
    profileScraperMode: PROFILE_SCRAPER_MODE_NO_EMAIL,
    urls: profileUrlTargets(args),
  };
}
