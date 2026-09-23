import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROFILE_MAX_ITEMS,
  MAX_PROFILE_MAX_ITEMS,
  boundedMaxItems,
  buildProfileSearchInput,
  hasProfileSearchTarget,
} from "../../src/profile";

describe("hasProfileSearchTarget", () => {
  test("true for a query or any non-empty filter list", () => {
    expect(hasProfileSearchTarget({ search: "growth lead" })).toBe(true);
    expect(hasProfileSearchTarget({ current_job_titles: ["CTO"] })).toBe(true);
    expect(hasProfileSearchTarget({ current_companies: ["OpenAI"] })).toBe(true);
    expect(hasProfileSearchTarget({ last_names: ["Gates"] })).toBe(true);
  });

  test("false for a blank query, empty/blank filters, or booleans alone", () => {
    expect(hasProfileSearchTarget({ search: "   " })).toBe(false);
    expect(hasProfileSearchTarget({ current_job_titles: ["  ", ""] })).toBe(false);
    expect(hasProfileSearchTarget({ recently_posted: true, recently_changed_jobs: true })).toBe(false);
    expect(hasProfileSearchTarget({})).toBe(false);
  });
});

describe("boundedMaxItems", () => {
  test("defaults when unset, clamps to [1, MAX], floors fractions", () => {
    expect(boundedMaxItems(undefined)).toBe(DEFAULT_PROFILE_MAX_ITEMS);
    expect(boundedMaxItems(25)).toBe(25);
    expect(boundedMaxItems(0)).toBe(1);
    expect(boundedMaxItems(-5)).toBe(1);
    expect(boundedMaxItems(9999)).toBe(MAX_PROFILE_MAX_ITEMS);
    expect(boundedMaxItems(12.7)).toBe(12);
    expect(boundedMaxItems(Number.NaN)).toBe(DEFAULT_PROFILE_MAX_ITEMS);
  });
});

describe("buildProfileSearchInput", () => {
  test("maps a query with defaults (Short mode, default maxItems)", () => {
    const input = buildProfileSearchInput({ search: "  head of growth  " });
    expect(input).toMatchObject({
      searchQuery: "head of growth",
      profileScraperMode: "Short",
      maxItems: DEFAULT_PROFILE_MAX_ITEMS,
    });
  });

  test("maps string filters onto the Actor's field names, normalized and deduped", () => {
    const input = buildProfileSearchInput({
      current_job_titles: [" CTO ", "cto", "VP Eng"],
      current_companies: ["OpenAI"],
      locations: ["London", "London"],
      mode: "Full",
      max_items: 30,
    });
    expect(input).toMatchObject({
      currentJobTitles: ["CTO", "VP Eng"],
      currentCompanies: ["OpenAI"],
      locations: ["London"],
      profileScraperMode: "Full",
      maxItems: 30,
    });
  });

  test("passes boolean refinements only when true; omits empty filter lists", () => {
    const input = buildProfileSearchInput({
      search: "designers",
      recently_changed_jobs: true,
      recently_posted: false,
      schools: ["  "],
    });
    expect(input.recentlyChangedJobs).toBe(true);
    expect(input.recentlyPostedOnLinkedIn).toBeUndefined();
    expect(input.schools).toBeUndefined();
  });

  test("clamps an over-cap max_items", () => {
    const input = buildProfileSearchInput({ search: "x", max_items: 5000 });
    expect(input.maxItems).toBe(MAX_PROFILE_MAX_ITEMS);
  });
});
