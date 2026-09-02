import { describe, expect, test } from "bun:test";

import {
  buildCommentsInput,
  buildSearchInput,
  hasTarget,
  normalizeSearch,
  runSyncUrl,
  validateDatasetItems,
  videoUrls,
} from "../../src/youtube";

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
    expect(hasTarget({ start_urls: ["https://www.youtube.com/watch?v=x"] })).toBe(true);
    expect(hasTarget({ search: "   " })).toBe(false);
    expect(hasTarget({ search: "   ", start_urls: [] })).toBe(false);
    expect(hasTarget({})).toBe(false);
  });
});

describe("buildSearchInput", () => {
  test("maps a search query onto the search Actor schema with defaults", () => {
    const input = buildSearchInput({ search: "claude code" });
    expect(input).toMatchObject({
      searchQueries: ["claude code"],
      maxResults: 10,
      maxResultsShorts: 0,
      maxResultStreams: 0,
      sortingOrder: "relevance",
    });
    expect(input.startUrls).toBeUndefined();
    expect(input.dateFilter).toBeUndefined();
  });

  test("honors overrides for sort, date_filter and max_results", () => {
    const input = buildSearchInput({
      search: "keyboards",
      sort: "date",
      date_filter: "week",
      max_results: 25,
    });
    expect(input).toMatchObject({
      sortingOrder: "date",
      dateFilter: "week",
      maxResults: 25,
    });
  });

  test("maps start_urls to {url} objects and drops a blank search", () => {
    const input = buildSearchInput({
      search: "   ",
      start_urls: ["https://www.youtube.com/playlist?list=PLabc"],
    });
    expect(input.startUrls).toEqual([{ url: "https://www.youtube.com/playlist?list=PLabc" }]);
    expect(input.searchQueries).toBeUndefined();
  });

  test("carries both a search and start_urls in one run", () => {
    const input = buildSearchInput({ search: "jazz", start_urls: ["https://youtu.be/x"] });
    expect(input.searchQueries).toEqual(["jazz"]);
    expect(input.startUrls).toEqual([{ url: "https://youtu.be/x" }]);
  });
});

describe("buildCommentsInput", () => {
  test("maps urls and options onto the comments Actor schema", () => {
    const input = buildCommentsInput(
      ["https://www.youtube.com/watch?v=a", "https://www.youtube.com/watch?v=b"],
      5,
      "new",
    );
    expect(input).toEqual({
      startUrls: [
        { url: "https://www.youtube.com/watch?v=a" },
        { url: "https://www.youtube.com/watch?v=b" },
      ],
      maxComments: 5,
      sortCommentsBy: "NEWEST_FIRST",
    });
  });

  test("maps the 'top' comment sort onto TOP_COMMENTS", () => {
    expect(buildCommentsInput(["https://youtu.be/a"], 3, "top").sortCommentsBy).toBe("TOP_COMMENTS");
  });
});

describe("videoUrls", () => {
  test("prefers watch?v=<id> over the raw url", () => {
    expect(videoUrls([{ id: "abc", url: "https://youtube.com/watch?v=abc&list=RDabc" }])).toEqual([
      "https://www.youtube.com/watch?v=abc",
    ]);
  });

  test("falls back to the raw url when there is no id", () => {
    expect(videoUrls([{ url: "https://www.youtube.com/watch?v=noid" }])).toEqual([
      "https://www.youtube.com/watch?v=noid",
    ]);
  });

  test("dedupes and preserves order, skipping entries with neither id nor url", () => {
    expect(
      videoUrls([
        { id: "a" },
        { id: "b" },
        { id: "a" },
        { url: "https://www.youtube.com/watch?v=b" },
        { title: "no url here" },
      ]),
    ).toEqual(["https://www.youtube.com/watch?v=a", "https://www.youtube.com/watch?v=b"]);
  });
});

describe("runSyncUrl", () => {
  test("builds the run-sync-get-dataset-items endpoint", () => {
    expect(runSyncUrl("streamers~youtube-scraper")).toBe(
      "https://api.apify.com/v2/acts/streamers~youtube-scraper/run-sync-get-dataset-items",
    );
  });
});

describe("validateDatasetItems", () => {
  test("accepts an array of objects", () => {
    const result = validateDatasetItems([{ id: "a" }, { id: "b" }]);
    expect(result).toEqual({ ok: true, items: [{ id: "a" }, { id: "b" }] });
  });

  test("accepts an empty array", () => {
    expect(validateDatasetItems([])).toEqual({ ok: true, items: [] });
  });

  test("rejects a non-array response (e.g. an Apify error object)", () => {
    expect(validateDatasetItems({ error: "bad input" })).toMatchObject({ ok: false });
  });

  test("rejects a non-object item (string, null, nested array)", () => {
    expect(validateDatasetItems([{ ok: 1 }, "nope"])).toMatchObject({ ok: false });
    expect(validateDatasetItems([null])).toMatchObject({ ok: false });
    expect(validateDatasetItems([[1, 2]])).toMatchObject({ ok: false });
  });
});
