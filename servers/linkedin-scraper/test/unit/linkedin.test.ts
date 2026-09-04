import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  hasTarget,
  isLinkedinUrl,
  normalizeSearch,
  normalizeStringList,
  runSyncUrl,
  validLinkedinUrls,
  validStartUrls,
  validateDatasetItems,
} from "../../src/linkedin";

describe("normalizeSearch", () => {
  test("trims and treats blank/whitespace as absent", () => {
    expect(normalizeSearch("  b2b sales  ")).toBe("b2b sales");
    expect(normalizeSearch("   ")).toBeUndefined();
    expect(normalizeSearch("")).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
  });
});

describe("isLinkedinUrl / validStartUrls", () => {
  test("accepts linkedin.com http(s) URLs (with subdomains)", () => {
    expect(isLinkedinUrl("https://www.linkedin.com/in/williamhgates")).toBe(true);
    expect(isLinkedinUrl("https://linkedin.com/company/google")).toBe(true);
    expect(isLinkedinUrl("https://uk.linkedin.com/in/someone")).toBe(true);
  });

  test("rejects off-domain, malformed, and credential-bearing URLs", () => {
    expect(isLinkedinUrl("https://evil.com/linkedin.com")).toBe(false);
    expect(isLinkedinUrl("https://linkedin.com.evil.com/in/x")).toBe(false);
    expect(isLinkedinUrl("not a url")).toBe(false);
    expect(isLinkedinUrl("ftp://linkedin.com/in/x")).toBe(false);
    expect(isLinkedinUrl("https://user:pass@linkedin.com/in/x")).toBe(false);
  });

  test("filters, trims, and de-duplicates in order", () => {
    expect(
      validStartUrls([
        " https://linkedin.com/in/a ",
        "https://linkedin.com/in/a",
        "nope",
        "https://www.linkedin.com/company/b",
      ]),
    ).toEqual(["https://linkedin.com/in/a", "https://www.linkedin.com/company/b"]);
    expect(validStartUrls(undefined)).toEqual([]);
  });
});

describe("validLinkedinUrls", () => {
  test("narrows to URLs whose first path segment matches (in / company)", () => {
    const urls = [
      "https://www.linkedin.com/in/williamhgates",
      "https://www.linkedin.com/company/openai",
      "https://uk.linkedin.com/school/oxford",
      "https://evil.com/in/x",
    ];
    expect(validLinkedinUrls(urls, "in")).toEqual(["https://www.linkedin.com/in/williamhgates"]);
    expect(validLinkedinUrls(urls, "company")).toEqual(["https://www.linkedin.com/company/openai"]);
    expect(validLinkedinUrls(urls, "company")).not.toContain("https://evil.com/in/x");
    expect(validLinkedinUrls(undefined, "in")).toEqual([]);
  });
});

describe("normalizeStringList", () => {
  test("trims, drops blanks, and dedupes case-insensitively in order", () => {
    expect(normalizeStringList([" CTO ", "cto", "VP Eng", "  ", ""])).toEqual(["CTO", "VP Eng"]);
    expect(normalizeStringList(undefined)).toEqual([]);
    expect(normalizeStringList([])).toEqual([]);
  });
});

describe("hasTarget", () => {
  test("true for a real search or a valid LinkedIn URL, false otherwise", () => {
    expect(hasTarget({ search: "b2b sales" })).toBe(true);
    expect(hasTarget({ start_urls: ["https://linkedin.com/in/x"] })).toBe(true);
    expect(hasTarget({ search: "   " })).toBe(false);
    expect(hasTarget({ start_urls: ["https://evil.com/x"] })).toBe(false);
    expect(hasTarget({})).toBe(false);
  });
});

describe("buildActorInput", () => {
  test("maps a search query onto the Actor schema with defaults", () => {
    const input = buildActorInput({ search: "b2b sales" });
    expect(input).toMatchObject({
      searchQueries: ["b2b sales"],
      maxPosts: 10,
      sortBy: "date",
    });
    expect(input.authorUrls).toBeUndefined();
    expect(input.postedLimit).toBeUndefined();
  });

  test("honors overrides", () => {
    const input = buildActorInput({
      search: "hiring",
      sort: "relevance",
      posted_within: "week",
      max_items: 50,
    });
    expect(input).toMatchObject({
      sortBy: "relevance",
      postedLimit: "week",
      maxPosts: 50,
    });
  });

  test("maps start_urls to authorUrls, drops off-domain and a blank search", () => {
    const input = buildActorInput({
      search: "   ",
      start_urls: ["https://www.linkedin.com/in/williamhgates", "https://evil.com/x"],
    });
    expect(input.authorUrls).toEqual(["https://www.linkedin.com/in/williamhgates"]);
    expect(input.searchQueries).toBeUndefined();
  });
});

describe("runSyncUrl", () => {
  test("builds the run-sync-get-dataset-items endpoint", () => {
    expect(runSyncUrl("harvestapi~linkedin-post-search")).toBe(
      "https://api.apify.com/v2/acts/harvestapi~linkedin-post-search/run-sync-get-dataset-items",
    );
  });

  test("strips a trailing slash on a custom base (no double slash)", () => {
    expect(runSyncUrl("harvestapi~linkedin-post-search", "https://example.com/api/")).toBe(
      "https://example.com/api/acts/harvestapi~linkedin-post-search/run-sync-get-dataset-items",
    );
  });
});

describe("validateDatasetItems", () => {
  test("accepts an array of objects", () => {
    const result = validateDatasetItems([{ text: "a" }, { text: "b" }]);
    expect(result).toEqual({ ok: true, items: [{ text: "a" }, { text: "b" }] });
  });

  test("accepts an empty array", () => {
    expect(validateDatasetItems([])).toEqual({ ok: true, items: [] });
  });

  test("rejects a non-array response", () => {
    expect(validateDatasetItems({ not: "a list" })).toMatchObject({ ok: false });
  });

  test("rejects a non-object item (string, null, nested array)", () => {
    expect(validateDatasetItems([{ ok: 1 }, "nope"])).toMatchObject({ ok: false });
    expect(validateDatasetItems([null])).toMatchObject({ ok: false });
    expect(validateDatasetItems([[1, 2]])).toMatchObject({ ok: false });
  });
});
