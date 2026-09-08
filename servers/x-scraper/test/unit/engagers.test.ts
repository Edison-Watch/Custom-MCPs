import { describe, expect, test } from "bun:test";

import {
  buildQuotesInput,
  buildRepliesInput,
  buildRetweetersInput,
  collectEngagerRuns,
  dedupeEngagers,
  enabledKinds,
  engagerFromBadgerUser,
  engagerFromKaitoTweet,
  engagerMaxItems,
  hasEnabledKind,
  normalizeTweetId,
  resolveTweetId,
  stripRootTweet,
  tweetIdFromUrl,
  type Engager,
} from "../../src/engagers";

describe("tweetIdFromUrl", () => {
  test("extracts the numeric id from status URLs across hosts and trailing paths", () => {
    expect(tweetIdFromUrl("https://x.com/jack/status/20")).toBe("20");
    expect(tweetIdFromUrl("https://twitter.com/jack/status/20")).toBe("20");
    expect(tweetIdFromUrl("https://www.x.com/user/status/1934468786985501089/photo/1")).toBe(
      "1934468786985501089",
    );
    expect(tweetIdFromUrl("https://x.com/i/web/status/20")).toBe("20");
  });

  test("returns undefined for profile URLs, non-status routes, and foreign hosts", () => {
    expect(tweetIdFromUrl("https://x.com/jack")).toBeUndefined();
    expect(tweetIdFromUrl("https://x.com/i/lists/123")).toBeUndefined();
    expect(tweetIdFromUrl("https://example.com/jack/status/20")).toBeUndefined();
    expect(tweetIdFromUrl("not a url")).toBeUndefined();
  });
});

describe("normalizeTweetId", () => {
  test("accepts bare numeric ids, rejects everything else", () => {
    expect(normalizeTweetId("  20 ")).toBe("20");
    expect(normalizeTweetId("1934468786985501089")).toBe("1934468786985501089");
    expect(normalizeTweetId("abc")).toBeUndefined();
    expect(normalizeTweetId("20x")).toBeUndefined();
    expect(normalizeTweetId(undefined)).toBeUndefined();
  });
});

describe("resolveTweetId", () => {
  test("prefers tweet_id, falls back to tweet_url, else undefined", () => {
    expect(resolveTweetId({ tweet_id: "20" })).toBe("20");
    expect(resolveTweetId({ tweet_url: "https://x.com/jack/status/20" })).toBe("20");
    expect(resolveTweetId({ tweet_id: "bad", tweet_url: "https://x.com/jack/status/20" })).toBe("20");
    expect(resolveTweetId({})).toBeUndefined();
  });
});

describe("enabledKinds / hasEnabledKind", () => {
  test("replies+quotes default on, retweeters default off", () => {
    expect(enabledKinds({})).toEqual({ replies: true, quotes: true, retweeters: false });
    expect(hasEnabledKind({})).toBe(true);
  });

  test("explicit flags override the defaults", () => {
    expect(enabledKinds({ include_replies: false, include_retweeters: true })).toEqual({
      replies: false,
      quotes: true,
      retweeters: true,
    });
  });

  test("all-off is a no-op", () => {
    expect(hasEnabledKind({ include_replies: false, include_quotes: false, include_retweeters: false })).toBe(
      false,
    );
  });
});

describe("engagerMaxItems", () => {
  test("defaults to 50, honors an explicit value", () => {
    expect(engagerMaxItems({})).toBe(50);
    expect(engagerMaxItems({ max_items: 200 })).toBe(200);
  });
});

describe("actor input builders", () => {
  test("route each kind to its documented Actor field", () => {
    expect(buildRepliesInput("20", 25)).toEqual({ conversation_id: "20", maxItems: 25, queryType: "Latest" });
    expect(buildQuotesInput("20", 25)).toEqual({ quoted_tweet_id: "20", maxItems: 25, queryType: "Latest" });
    expect(buildRetweetersInput("20", 25)).toEqual({ mode: "Get Retweeters", id: "20", max_results: 25 });
  });
});

describe("engagerFromKaitoTweet", () => {
  test("reads the nested author into a normalized engager", () => {
    const item = {
      id: "999",
      text: "great point",
      author: {
        userName: "@Alice",
        name: "Alice",
        followers: 1200,
        isVerified: false,
        isBlueVerified: true,
        canDm: true,
        description: "builder",
        location: "SF",
      },
    };
    expect(engagerFromKaitoTweet(item, "reply")).toEqual({
      handle: "Alice",
      name: "Alice",
      followers: 1200,
      verified: false,
      is_blue_verified: true,
      can_dm: true,
      description: "builder",
      location: "SF",
      engaged_via: ["reply"],
    });
  });

  test("returns undefined when there is no resolvable author handle", () => {
    expect(engagerFromKaitoTweet({ id: "-1", type: "mock_tweet" }, "reply")).toBeUndefined();
    expect(engagerFromKaitoTweet({ author: { userName: "bad handle!" } }, "quote")).toBeUndefined();
    expect(engagerFromKaitoTweet({ author: null }, "reply")).toBeUndefined();
  });
});

describe("engagerFromBadgerUser", () => {
  test("maps the flat user object, coercing badger's field names", () => {
    const item = {
      username: "bob",
      name: "Bob",
      followers_count: 42,
      verified: false,
      is_blue_verified: false,
      can_dm: false,
      description: "hi",
      location: "NYC",
    };
    expect(engagerFromBadgerUser(item)).toEqual({
      handle: "bob",
      name: "Bob",
      followers: 42,
      verified: false,
      is_blue_verified: false,
      can_dm: false,
      description: "hi",
      location: "NYC",
      engaged_via: ["retweet"],
    });
  });

  test("returns undefined for the empty-result sentinel", () => {
    expect(engagerFromBadgerUser({ status: "empty", reason: "no_results", mode: "Get Retweeters", id: "20" })).toBeUndefined();
  });
});

describe("dedupeEngagers", () => {
  test("merges by case-insensitive handle and unions engaged_via, first fields win", () => {
    const input: Engager[] = [
      { handle: "Alice", name: "Alice", followers: 10, engaged_via: ["reply"] },
      { handle: "alice", name: "Alice2", followers: 99, engaged_via: ["retweet"] },
      { handle: "bob", engaged_via: ["quote"] },
    ];
    const out = dedupeEngagers(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ handle: "Alice", name: "Alice", followers: 10, engaged_via: ["reply", "retweet"] });
    expect(out[1]).toEqual({ handle: "bob", engaged_via: ["quote"] });
  });

  test("does not mutate the input engagers", () => {
    const input: Engager[] = [{ handle: "a", engaged_via: ["reply"] }, { handle: "a", engaged_via: ["retweet"] }];
    dedupeEngagers(input);
    expect(input[0].engaged_via).toEqual(["reply"]);
  });
});

describe("stripRootTweet", () => {
  test("drops the conversation's own root tweet, keeps replies", () => {
    const items = [{ id: "20", text: "root" }, { id: "21", text: "reply" }];
    expect(stripRootTweet(items, "20")).toEqual([{ id: "21", text: "reply" }]);
  });
});

describe("collectEngagerRuns", () => {
  const reply: Engager = { handle: "alice", engaged_via: ["reply"] };
  const rt: Engager = { handle: "bob", engaged_via: ["retweet"] };
  const passthrough = (items: Record<string, unknown>[]) => items as unknown as Engager[];

  test("collects a successful run's extracted engagers, in input order", () => {
    const { collected, errors } = collectEngagerRuns([
      { kind: "reply", extract: passthrough, run: { ok: true, items: [reply as unknown as Record<string, unknown>] } },
      { kind: "retweet", extract: passthrough, run: { ok: true, items: [rt as unknown as Record<string, unknown>] } },
    ]);
    expect(collected).toEqual([reply, rt]);
    expect(errors).toEqual([]);
  });

  test("records a failed run's error but keeps the other runs' engagers (partial result)", () => {
    const { collected, errors } = collectEngagerRuns([
      { kind: "reply", extract: passthrough, run: { ok: true, items: [reply as unknown as Record<string, unknown>] } },
      { kind: "retweet", extract: passthrough, run: { ok: false, message: "Apify returned 500" } },
    ]);
    expect(collected).toEqual([reply]);
    expect(errors).toEqual([{ kind: "retweet", message: "Apify returned 500" }]);
  });

  test("a total wipeout yields no engagers and every kind's error", () => {
    const { collected, errors } = collectEngagerRuns([
      { kind: "reply", extract: passthrough, run: { ok: false, message: "boom" } },
      { kind: "quote", extract: passthrough, run: { ok: false, message: "bang" } },
    ]);
    expect(collected).toEqual([]);
    expect(errors).toEqual([
      { kind: "reply", message: "boom" },
      { kind: "quote", message: "bang" },
    ]);
  });
});
