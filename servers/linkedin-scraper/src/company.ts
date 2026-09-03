/**
 * Pure, runtime-agnostic helpers for the linkedin connector's company tool
 * (`linkedin_company`).
 *
 * Backed by the `harvestapi/linkedin-company` Apify Actor - a *different* Actor
 * from the post scraper in `linkedin.ts` and the people search in `profile.ts`.
 * Given LinkedIn company URLs and/or company names it returns full company
 * pages (headcount, industry, about, recent posts...). No cookies or account.
 *
 * Like the sibling tools this wraps a PUBLIC, paid Actor, so it enforces a real
 * target (at least one valid company URL or name) and caps how many companies
 * one call may request - each company is a billed item.
 */

import { normalizeStringList, validStartUrls } from "./linkedin";

export const DEFAULT_COMPANY_ACTOR_ID = "harvestapi~linkedin-company";

/**
 * Hard cap on companies per call (URLs + names combined). Each company is a
 * billed Actor item, so an unbounded request would force an arbitrarily large
 * paid run; enforced at the tool's input schema and re-checked in the tool.
 */
export const MAX_COMPANY_TARGETS = 50;

export interface LinkedinCompanyArgs {
  company_urls?: string[];
  names?: string[];
}

export interface CompanyTargets {
  /** Valid LinkedIn company URLs, sent as the Actor's `companies`. */
  urls: string[];
  /** Free-text company names, sent as the Actor's `searches`. */
  names: string[];
}

/** Resolve the caller's args into the Actor's two targeting fields. */
export function companyTargets(args: LinkedinCompanyArgs): CompanyTargets {
  return {
    urls: validStartUrls(args.company_urls),
    names: normalizeStringList(args.names),
  };
}

/** A request needs at least one valid company URL or one company name. */
export function hasCompanyTarget(args: LinkedinCompanyArgs): boolean {
  const { urls, names } = companyTargets(args);
  return urls.length > 0 || names.length > 0;
}

/** Total distinct targets in a request, used to enforce {@link MAX_COMPANY_TARGETS}. */
export function companyTargetCount(args: LinkedinCompanyArgs): number {
  const { urls, names } = companyTargets(args);
  return urls.length + names.length;
}

/** Map the caller's input onto the Actor's input schema. */
export function buildCompanyInput(args: LinkedinCompanyArgs): Record<string, unknown> {
  const { urls, names } = companyTargets(args);
  const input: Record<string, unknown> = {};
  if (urls.length > 0) input.companies = urls;
  if (names.length > 0) input.searches = names;
  return input;
}
