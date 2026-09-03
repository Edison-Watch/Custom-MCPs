import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  hasTarget,
  isXUrl,
  normalizeSearch,
  runSyncUrl,
  validStartUrls,
  validateDatasetItems,
} from "../../src/x";

describe("normalizeSearch", () => {
  test("trims and treats blank/whitespace as absent", () => {
    expect(normalizeSearch("  apify  ")).toBe("apify");
    expect(normalizeSearch("   ")).toBeUndefined();
    expect(normalizeSearch("")).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
  });
});

describe("isXUrl / validStartUrls", () => {
  test("accepts twitter.com and x.com http(s) URLs (with subdomains)", () => {
    expect(isXUrl("https://twitter.com/apify")).toBe(true);
    expect(isXUrl("https://x.com/elonmusk")).toBe(true);
    expect(isXUrl("https://mobile.twitter.com/apify")).toBe(true);
    expect(isXUrl("http://x.com/i/lists/123")).toBe(true);
  });

  test("rejects off-domain, malformed, and credential-bearing URLs", () => {
    expect(isXUrl("https://evil.com/x.com")).toBe(false);
    expect(isXUrl("https://x.com.evil.com/apify")).toBe(false);
    expect(isXUrl("not a url")).toBe(false);
    expect(isXUrl("ftp://x.com/apify")).toBe(false);
    expect(isXUrl("https://user:pass@x.com/apify")).toBe(false);
  });

  test("filters, trims, and de-duplicates in order", () => {
    expect(
      validStartUrls([" https://x.com/a ", "https://x.com/a", "nope", "https://twitter.com/b"]),
    ).toEqual(["https://x.com/a", "https://twitter.com/b"]);
    expect(validStartUrls(undefined)).toEqual([]);
  });
});

describe("hasTarget", () => {
  test("true for a real search or a valid X URL, false otherwise", () => {
    expect(hasTarget({ search: "apify" })).toBe(true);
    expect(hasTarget({ start_urls: ["https://x.com/apify"] })).toBe(true);
    expect(hasTarget({ search: "   " })).toBe(false);
    expect(hasTarget({ start_urls: ["https://evil.com/x"] })).toBe(false);
    expect(hasTarget({})).toBe(false);
  });
});

describe("buildActorInput", () => {
  test("maps a search query onto the Actor schema with defaults", () => {
    const input = buildActorInput({ search: "claude code" });
    expect(input).toMatchObject({
      searchTerms: ["claude code"],
      maxItems: 10,
      sort: "Latest",
    });
    expect(input.startUrls).toBeUndefined();
    expect(input.start).toBeUndefined();
    expect(input.end).toBeUndefined();
    expect(input.onlyVerifiedUsers).toBeUndefined();
  });

  test("honors overrides and only_verified flips onlyVerifiedUsers", () => {
    const input = buildActorInput({
      search: "keyboards",
      sort: "Top",
      since: "2024-01-01",
      until: "2024-12-31",
      max_items: 25,
      only_verified: true,
    });
    expect(input).toMatchObject({
      sort: "Top",
      start: "2024-01-01",
      end: "2024-12-31",
      maxItems: 25,
      onlyVerifiedUsers: true,
    });
  });

  test("maps start_urls to plain strings, drops off-domain and a blank search", () => {
    const input = buildActorInput({
      search: "   ",
      start_urls: ["https://x.com/apify", "https://evil.com/x"],
    });
    expect(input.startUrls).toEqual(["https://x.com/apify"]);
    expect(input.searchTerms).toBeUndefined();
  });
});

describe("runSyncUrl", () => {
  test("builds the run-sync-get-dataset-items endpoint", () => {
    expect(runSyncUrl("apidojo~tweet-scraper")).toBe(
      "https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items",
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
