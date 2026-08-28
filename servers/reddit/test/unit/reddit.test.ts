import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  hasTarget,
  normalizeSearch,
  runSyncUrl,
  validateDatasetItems,
} from "../../src/reddit";

describe("normalizeSearch", () => {
  test("trims and treats blank/whitespace as absent", () => {
    expect(normalizeSearch("  rust  ")).toBe("rust");
    expect(normalizeSearch("   ")).toBeUndefined();
    expect(normalizeSearch("")).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
  });
});

describe("hasTarget", () => {
  test("true for a real search or a start URL, false otherwise", () => {
    expect(hasTarget({ search: "rust" })).toBe(true);
    expect(hasTarget({ start_urls: ["https://reddit.com/r/rust"] })).toBe(true);
    expect(hasTarget({ search: "   " })).toBe(false);
    expect(hasTarget({ search: "   ", start_urls: [] })).toBe(false);
    expect(hasTarget({})).toBe(false);
  });
});

describe("buildActorInput", () => {
  test("maps a search query onto the Actor schema with defaults", () => {
    const input = buildActorInput({ search: "claude code", subreddit: "programming" });
    expect(input).toMatchObject({
      searches: ["claude code"],
      searchCommunityName: "programming",
      maxItems: 10,
      maxPostCount: 10,
      skipComments: true,
      includeNSFW: false,
      sort: "new",
      proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
    });
    expect(input.startUrls).toBeUndefined();
    expect(input.time).toBeUndefined();
  });

  test("honors overrides and include_comments flips skipComments", () => {
    const input = buildActorInput({
      search: "keyboards",
      sort: "top",
      time_filter: "week",
      max_items: 25,
      include_comments: true,
      include_nsfw: true,
    });
    expect(input).toMatchObject({
      sort: "top",
      time: "week",
      maxItems: 25,
      maxPostCount: 25,
      skipComments: false,
      includeNSFW: true,
    });
  });

  test("maps start_urls to {url} objects and drops a blank search", () => {
    const input = buildActorInput({ search: "   ", start_urls: ["https://www.reddit.com/r/python/"] });
    expect(input.startUrls).toEqual([{ url: "https://www.reddit.com/r/python/" }]);
    expect(input.searches).toBeUndefined();
  });
});

describe("runSyncUrl", () => {
  test("builds the run-sync-get-dataset-items endpoint", () => {
    expect(runSyncUrl("trudax~reddit-scraper-lite")).toBe(
      "https://api.apify.com/v2/acts/trudax~reddit-scraper-lite/run-sync-get-dataset-items",
    );
  });
});

describe("validateDatasetItems", () => {
  test("accepts an array of objects", () => {
    const result = validateDatasetItems([{ title: "a" }, { title: "b" }]);
    expect(result).toEqual({ ok: true, items: [{ title: "a" }, { title: "b" }] });
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
