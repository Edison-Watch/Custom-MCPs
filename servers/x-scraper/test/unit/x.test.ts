import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  hasTarget,
  invalidDateBound,
  isFillerItem,
  normalizeHandle,
  normalizeSearch,
  runSyncUrl,
  stripFillerItems,
  toUnixSeconds,
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
  test("trims, drops a single leading @, and accepts valid handles", () => {
    expect(normalizeHandle("@elonmusk")).toBe("elonmusk");
    expect(normalizeHandle("  openai ")).toBe("openai");
    expect(normalizeHandle("a_1")).toBe("a_1");
    expect(normalizeHandle("@")).toBeUndefined();
    expect(normalizeHandle("   ")).toBeUndefined();
    expect(normalizeHandle(undefined)).toBeUndefined();
  });

  test("rejects malformed handles so they can't trigger a paid scrape", () => {
    expect(normalizeHandle("foo bar")).toBeUndefined();
    expect(normalizeHandle("bad!handle")).toBeUndefined();
    expect(normalizeHandle("a.b")).toBeUndefined();
    expect(normalizeHandle("averylonghandle16")).toBeUndefined();
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

describe("toUnixSeconds", () => {
  test("anchors a bare YYYY-MM-DD to start/end of day in UTC (Unix seconds string)", () => {
    // 2024-01-01T00:00:00Z = 1704067200 ; 2024-12-31T23:59:59Z = 1735689599
    expect(toUnixSeconds("2024-01-01", false)).toBe("1704067200");
    expect(toUnixSeconds("2024-12-31", true)).toBe("1735689599");
  });

  test("parses a full datetime and rejects garbage", () => {
    expect(toUnixSeconds("2024-01-01T08:30:00Z", false)).toBe("1704097800");
    expect(toUnixSeconds("not a date", false)).toBeUndefined();
    expect(toUnixSeconds("   ", false)).toBeUndefined();
  });

  test("rejects an impossible date instead of rolling it over", () => {
    expect(toUnixSeconds("2024-02-30", false)).toBeUndefined();
    expect(toUnixSeconds("2024-13-01", true)).toBeUndefined();
    expect(toUnixSeconds("2023-02-29", false)).toBeUndefined();
  });
});

describe("invalidDateBound", () => {
  test("names the first unparseable bound, ignores blank/valid ones", () => {
    expect(invalidDateBound({ since: "2024-02-30" })).toBe("since");
    expect(invalidDateBound({ until: "nope" })).toBe("until");
    expect(invalidDateBound({ since: "2024-01-01", until: "2024-12-31" })).toBeUndefined();
    expect(invalidDateBound({ since: "  ", until: "" })).toBeUndefined();
    expect(invalidDateBound({})).toBeUndefined();
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
    expect(input.since_time).toBeUndefined();
    expect(input.until_time).toBeUndefined();
    expect(input["filter:blue_verified"]).toBeUndefined();
  });

  test("honors overrides; dates map to Unix since_time/until_time, only_verified to filter:blue_verified", () => {
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
      since_time: "1704067200",
      until_time: "1735689599",
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

describe("isFillerItem / stripFillerItems", () => {
  const MOCK = {
    type: "mock_tweet",
    id: -1,
    text: "From KaitoEasyAPI, a reminder: ... we returned N pieces of mock data ...",
  };
  const REAL = { type: "tweet", id: "1953529799219319205", text: "gpt-5 is here" };

  test("flags KaitoEasyAPI billing-floor filler, not real tweets", () => {
    expect(isFillerItem(MOCK)).toBe(true);
    expect(isFillerItem({ id: -1 })).toBe(true);
    expect(isFillerItem({ id: "-1" })).toBe(true);
    expect(isFillerItem(REAL)).toBe(false);
    expect(isFillerItem({ type: "tweet", id: 0 })).toBe(false);
  });

  test("strips trailing filler while preserving real tweets in order", () => {
    const kept = stripFillerItems([REAL, MOCK, MOCK]);
    expect(kept).toEqual([REAL]);
  });

  test("an all-filler run collapses to an empty list", () => {
    expect(stripFillerItems([MOCK, MOCK])).toEqual([]);
  });

  test("leaves a filler-free run untouched", () => {
    const items = [REAL, { type: "tweet", id: "2" }];
    expect(stripFillerItems(items)).toEqual(items);
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
