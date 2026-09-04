import { describe, expect, test } from "bun:test";

import {
  buildActorInput,
  fieldMapForActor,
  hasTarget,
  normalizeItem,
  normalizeItems,
  normalizeSearch,
  runSyncUrl,
  validateDatasetItems,
} from "../../src/reddit";

// A representative trudax reddit-scraper-lite POST item (default RSS mode): no
// engagement counts present. Field names per Apify's documented actor schema.
const LITE_POST: Record<string, unknown> = {
  id: "t3_abc",
  dataType: "post",
  title: "Async runtimes in Rust",
  body: "tokio vs async-std",
  username: "ferris",
  communityName: "r/rust",
  url: "https://www.reddit.com/r/rust/comments/abc/async_runtimes/",
  createdAt: "2023-06-09T05:23:15.000Z",
  over18: false,
};

// The same shape from the flat-rate trudax reddit-scraper sibling, which DOES
// return engagement counts. Same field names -> same map, counts flow through.
const FULL_POST: Record<string, unknown> = {
  ...LITE_POST,
  upVotes: 1500,
  numberOfComments: 42,
  upVoteRatio: 0.98,
  numberOfCrossposts: 3,
};

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

describe("fieldMapForActor", () => {
  test("both trudax actors share one map; unknown actors fall back", () => {
    const lite = fieldMapForActor("trudax~reddit-scraper-lite");
    const full = fieldMapForActor("trudax~reddit-scraper");
    const other = fieldMapForActor("someone~custom-reddit-actor");
    expect(lite).toBe(full);
    expect(other).not.toBe(lite);
    // A build tag is stripped before lookup.
    expect(fieldMapForActor("trudax~reddit-scraper-lite:latest")).toBe(lite);
  });
});

describe("normalizeItem", () => {
  test("lite post: engagement counts normalize to null, identity maps through", () => {
    const item = normalizeItem(LITE_POST, "trudax~reddit-scraper-lite");
    expect(item.type).toBe("post");
    expect(item.title).toBe("Async runtimes in Rust");
    expect(item.author).toBe("ferris");
    expect(item.subreddit).toBe("rust"); // "r/" prefix stripped
    expect(item.created_at).toBe("2023-06-09T05:23:15.000Z");
    expect(item.over_18).toBe(false);
    expect(item.score).toBeNull();
    expect(item.num_comments).toBeNull();
    expect(item.upvote_ratio).toBeNull();
    expect(item.permalink).toBe("/r/rust/comments/abc/async_runtimes/");
    expect(item.raw).toBe(LITE_POST);
  });

  test("full actor: engagement flows through the same trudax map", () => {
    const item = normalizeItem(FULL_POST, "trudax~reddit-scraper");
    expect(item.score).toBe(1500);
    expect(item.num_comments).toBe(42);
    expect(item.upvote_ratio).toBe(0.98);
    expect(item.num_crossposts).toBe(3);
  });

  test("default map reads Reddit's snake_case JSON API (epoch -> ISO8601)", () => {
    const item = normalizeItem(
      {
        kind: "t3",
        title: "hi",
        author: "spez",
        subreddit: "announcements",
        score: 9,
        num_comments: 4,
        upvote_ratio: 0.9,
        created_utc: 1686288195,
      },
      "someone~custom-reddit-actor",
    );
    expect(item.type).toBe("post");
    expect(item.author).toBe("spez");
    expect(item.score).toBe(9);
    expect(item.num_comments).toBe(4);
    expect(item.created_at?.startsWith("2023-06-09T")).toBe(true);
  });

  test("a boolean is never coerced into a numeric count", () => {
    const item = normalizeItem({ score: true }, "someone~custom-reddit-actor");
    expect(item.score).toBeNull();
  });
});

describe("normalizeItems", () => {
  test("maps a batch, preserving order and raw items", () => {
    const items = normalizeItems([FULL_POST], "trudax~reddit-scraper");
    expect(items).toHaveLength(1);
    expect(items[0].score).toBe(1500);
    expect(items[0].raw).toBe(FULL_POST);
  });
});
