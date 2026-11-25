import { describe, expect, test } from "bun:test";

import {
  buildProfileInput,
  handleFromUrl,
  hasProfileTarget,
  normalizeHandles,
  profileTargets,
  missingTargets,
  PROFILE_HEADROOM,
  selectProfiles,
  uniqueTargetCount,
} from "../../src/profile";

describe("normalizeHandles", () => {
  test("trims, drops a leading @, discards blanks/malformed, dedupes case-insensitively", () => {
    expect(normalizeHandles(["@openai", "  sama ", "@", "  ", "foo bar", "OpenAI"])).toEqual([
      "openai",
      "sama",
    ]);
    expect(normalizeHandles(undefined)).toEqual([]);
    expect(normalizeHandles([])).toEqual([]);
  });
});

describe("handleFromUrl", () => {
  test("extracts the handle from a bare profile URL", () => {
    expect(handleFromUrl("https://x.com/openai")).toBe("openai");
    expect(handleFromUrl("https://twitter.com/sama/")).toBe("sama");
    expect(handleFromUrl("https://www.x.com/@apify?lang=en")).toBe("apify");
    expect(handleFromUrl("https://mobile.twitter.com/nasa")).toBe("nasa");
  });

  test("rejects tweet permalinks, routes, and foreign hosts", () => {
    expect(handleFromUrl("https://x.com/openai/status/123")).toBeUndefined();
    expect(handleFromUrl("https://x.com/i/lists/42")).toBeUndefined();
    expect(handleFromUrl("https://x.com/search?q=ai")).toBeUndefined();
    expect(handleFromUrl("https://example.com/openai")).toBeUndefined();
    expect(handleFromUrl("not a url")).toBeUndefined();
  });
});

describe("profileTargets / hasProfileTarget", () => {
  test("collects handles, urls, and the lowercased name set for filtering", () => {
    const t = profileTargets({ handles: ["@OpenAI"], profile_urls: ["https://x.com/sama"] });
    expect(t.handles).toEqual(["OpenAI"]);
    expect(t.urls).toEqual(["https://x.com/sama"]);
    expect([...t.names].sort()).toEqual(["openai", "sama"]);
  });

  test("an unparseable URL still targets the Actor but adds no filter name", () => {
    const t = profileTargets({ profile_urls: ["https://x.com/openai/status/1"] });
    expect(t.urls).toEqual(["https://x.com/openai/status/1"]);
    expect(t.names.size).toBe(0);
  });

  test("hasProfileTarget requires at least one handle or url", () => {
    expect(hasProfileTarget({ handles: ["openai"] })).toBe(true);
    expect(hasProfileTarget({ profile_urls: ["https://x.com/sama"] })).toBe(true);
    expect(hasProfileTarget({})).toBe(false);
    expect(hasProfileTarget({ handles: ["  ", "@"] })).toBe(false);
  });
});

describe("buildProfileInput", () => {
  test("maps handles, asks for one item per target plus headroom, profiles only", () => {
    const input = buildProfileInput({ handles: ["openai", "sama"] });
    expect(input).toMatchObject({
      twitterHandles: ["openai", "sama"],
      getAbout: true,
      maxItems: 2 + PROFILE_HEADROOM,
    });
    expect(input.startUrls).toBeUndefined();
  });

  test("include_about false is honored; urls become startUrls", () => {
    const input = buildProfileInput({ profile_urls: ["https://x.com/nasa"], include_about: false });
    expect(input).toMatchObject({
      startUrls: ["https://x.com/nasa"],
      getAbout: false,
      maxItems: 1 + PROFILE_HEADROOM,
    });
  });

  test("counts unique identities so duplicate targets don't inflate maxItems", () => {
    // "openai" appears as a handle (twice, one dedupes) and as a URL; sama is
    // distinct, so 2 unique identities, not 4.
    const input = buildProfileInput({
      handles: ["openai", "OpenAI"],
      profile_urls: ["https://x.com/openai", "https://x.com/sama"],
    });
    expect(input.maxItems).toBe(2 + PROFILE_HEADROOM);
  });

  test("turns off the Actor's follower/following/retweeter scraping (all default to true)", () => {
    // Left on, those billed list rows share the maxItems window and crowded a
    // requested profile out (["openai","sama"] returned OpenAI + 10 list rows).
    const input = buildProfileInput({ handles: ["openai"], profile_urls: ["https://x.com/sama"] });
    expect(input).toMatchObject({ getFollowers: false, getFollowing: false, getRetweeters: false });
  });
});

describe("missingTargets", () => {
  const openai = { userName: "OpenAI" };
  test("names requested handles with no matching profile, case-insensitively", () => {
    expect(missingTargets([openai], { handles: ["openai", "sama"] })).toEqual(["sama"]);
  });
  test("resolves URL targets to handles and dedupes across fields", () => {
    expect(
      missingTargets([openai], { handles: ["SAMA"], profile_urls: ["https://x.com/sama", "https://x.com/openai"] }),
    ).toEqual(["SAMA"]);
  });
  test("is empty when everything came back", () => {
    expect(missingTargets([openai], { handles: ["@openai"] })).toEqual([]);
  });
});

describe("uniqueTargetCount", () => {
  test("counts unique identities across handles and urls, ignoring dupes/case", () => {
    expect(uniqueTargetCount({ handles: ["openai", "OpenAI"] })).toBe(1);
    expect(
      uniqueTargetCount({ handles: ["sama"], profile_urls: ["https://x.com/sama", "https://x.com/openai"] }),
    ).toBe(2);
    expect(uniqueTargetCount({})).toBe(0);
  });
});

describe("selectProfiles", () => {
  const openai = { userName: "OpenAI", followers: 5_000_000 };
  const sama = { userName: "sama", followers: 3_000_000 };
  const suggestion = { userName: "paulg", followers: 5_100_000 };

  test("keeps only requested handles and drops suggestion padding", () => {
    const kept = selectProfiles([suggestion, openai, sama], { handles: ["openai", "sama"] });
    expect(kept).toEqual([openai, sama]);
  });

  test("matches case-insensitively and dedupes repeats", () => {
    const kept = selectProfiles([openai, openai, suggestion], { handles: ["OPENAI"] });
    expect(kept).toEqual([openai]);
  });

  test("resolves handles from profile URLs for filtering", () => {
    const kept = selectProfiles([suggestion, sama], { profile_urls: ["https://x.com/sama"] });
    expect(kept).toEqual([sama]);
  });

  test("returns nothing when no handle resolves (unparseable url only), never padding", () => {
    const kept = selectProfiles([suggestion, openai], { profile_urls: ["https://x.com/a/status/1"] });
    expect(kept).toEqual([]);
  });

  test("skips items without a string userName", () => {
    const kept = selectProfiles([{ id: 1 }, sama], { handles: ["sama"] });
    expect(kept).toEqual([sama]);
  });
});
