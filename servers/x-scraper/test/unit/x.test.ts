import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  formatDateBound,
  hasTarget,
  normalizeHandle,
  normalizeSearch,
  runSyncUrl,
  validateDatasetItems,
} from "../../src/x";

describe("normalizeSearch", () => {
  test("trims and treats blank/whitespace as absent", () => {
    expect(normalizeSearch("  openai  ")).toBe("openai");
    expect(normalizeSearch("   ")).toBeUndefined();
    expect(normalizeSearch("")).toBeUndefined();
    expect(normalizeSearch(undefined)).toBeUndefined();
  });
});

describe("normalizeHandle", () => {
  test("trims and drops a single leading @", () => {
    expect(normalizeHandle("@elonmusk")).toBe("elonmusk");
    expect(normalizeHandle("  openai ")).toBe("openai");
    expect(normalizeHandle("@")).toBeUndefined();
    expect(normalizeHandle("   ")).toBeUndefined();
    expect(normalizeHandle(undefined)).toBeUndefined();
  });
});

describe("hasTarget", () => {
  test("true for a real search or a from_user, false otherwise", () => {
    expect(hasTarget({ search: "openai" })).toBe(true);
    expect(hasTarget({ from_user: "@elonmusk" })).toBe(true);
    expect(hasTarget({ search: "   " })).toBe(false);
    expect(hasTarget({ from_user: "  @  " })).toBe(false);
    expect(hasTarget({})).toBe(false);
  });
});

describe("formatDateBound", () => {
  test("anchors a bare YYYY-MM-DD to start/end of day in UTC", () => {
    expect(formatDateBound("2024-01-01", false)).toBe("2024-01-01_00:00:00_UTC");
    expect(formatDateBound("2024-12-31", true)).toBe("2024-12-31_23:59:59_UTC");
  });

  test("passes an already time-qualified value through untouched", () => {
    expect(formatDateBound("2024-01-01_08:30:00_UTC", false)).toBe("2024-01-01_08:30:00_UTC");
  });
});

describe("buildActorInput", () => {
  test("maps a search query onto the Actor schema with defaults", () => {
    const input = buildActorInput({ search: "claude code" });
    expect(input).toMatchObject({
      twitterContent: "claude code",
      maxItems: 10,
      queryType: "Latest",
    });
    expect(input.from).toBeUndefined();
    expect(input.since).toBeUndefined();
    expect(input.until).toBeUndefined();
    expect(input["filter:blue_verified"]).toBeUndefined();
  });

  test("honors overrides and only_verified sets filter:blue_verified", () => {
    const input = buildActorInput({
      search: "keyboards",
      from_user: "@apify",
      sort: "Top",
      since: "2024-01-01",
      until: "2024-12-31",
      max_items: 25,
      only_verified: true,
    });
    expect(input).toMatchObject({
      twitterContent: "keyboards",
      from: "apify",
      queryType: "Top",
      since: "2024-01-01_00:00:00_UTC",
      until: "2024-12-31_23:59:59_UTC",
      maxItems: 25,
      "filter:blue_verified": true,
    });
  });

  test("from_user alone (no search) is a valid target", () => {
    const input = buildActorInput({ search: "   ", from_user: "elonmusk" });
    expect(input.from).toBe("elonmusk");
    expect(input.twitterContent).toBeUndefined();
  });
});

describe("runSyncUrl", () => {
  test("builds the run-sync-get-dataset-items endpoint", () => {
    expect(runSyncUrl("kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest")).toBe(
      "https://api.apify.com/v2/acts/kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest/run-sync-get-dataset-items",
    );
  });

  test("strips a trailing slash on a custom base (no double slash)", () => {
    expect(runSyncUrl("acme~scraper", "https://example.com/api/")).toBe(
      "https://example.com/api/acts/acme~scraper/run-sync-get-dataset-items",
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
