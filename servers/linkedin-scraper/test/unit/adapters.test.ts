import { describe, expect, test } from "bun:test";

import {
  JOHNVC_POST_SEARCH_ACTOR_ID,
  adapterForActor,
  assertJohnvcKeyword,
  buildActorInputForActor,
  buildJohnvcPostSearchInput,
  mapPostedWithin,
  normalizeJohnvcOutput,
  normalizeOutputForActor,
} from "../../src/adapters";
import { DEFAULT_ACTOR_ID, buildActorInput } from "../../src/linkedin";

/** Fixture shaped like the Actor's documented Store output (no live Apify call). */
const JOHNVC_FIXTURE_POST: Record<string, unknown> = {
  resultType: "post",
  postId: "7363908644226125825",
  postUrl: "https://www.linkedin.com/posts/example_activity-7363908644226125825",
  postType: "post",
  mediaType: "text",
  datePosted: "2026-10-01T12:00:00.000Z",
  text: "Hiring signal: we are looking for a senior OSINT engineer.",
  title: null,
  authorName: "Example Author",
  authorUrl: "https://www.linkedin.com/in/example-author",
  authorType: "person",
  authorHeadline: "Founder at Example Co",
  authorFollowers: 1200,
  numLikes: 42,
  numComments: 3,
  topComments: [],
  images: [],
  videos: [],
  embeddedLinks: [],
  taggedPeople: [],
  taggedCompanies: [],
  hashtags: ["osint"],
  resharedPost: null,
  matchedKeyword: "OSINT engineer",
  searchPage: 1,
  searchRank: 1,
  fromCache: false,
  fetchedAt: "2026-10-01T15:00:00.000Z",
};

const JOHNVC_FIXTURE_ERROR: Record<string, unknown> = {
  resultType: "error",
  error: "UnsupportedKeyword",
  message: "operators refused",
};

describe("adapterForActor", () => {
  test("defaults unknown Actor ids to the HarvestAPI adapter", () => {
    expect(adapterForActor("unknown~actor")).toBe(adapterForActor(DEFAULT_ACTOR_ID));
  });

  test("resolves the johnvc adapter", () => {
    expect(adapterForActor(JOHNVC_POST_SEARCH_ACTOR_ID)).toBe(
      adapterForActor(`${JOHNVC_POST_SEARCH_ACTOR_ID}:latest`),
    );
  });
});

describe("default HarvestAPI path is unchanged", () => {
  test("default Actor id stays harvestapi~linkedin-post-search", () => {
    expect(DEFAULT_ACTOR_ID).toBe("harvestapi~linkedin-post-search");
  });

  test("adapter input for the default Actor is byte-identical to buildActorInput", () => {
    const args = {
      search: "b2b sales",
      sort: "relevance" as const,
      posted_within: "week" as const,
      max_items: 50,
      start_urls: ["https://www.linkedin.com/in/williamhgates"],
    };
    expect(buildActorInputForActor(args, DEFAULT_ACTOR_ID)).toEqual(buildActorInput(args));
  });

  test("Harvest normalizeOutput returns items unchanged and no errors", () => {
    const raw = [{ id: "1", content: "hello" }];
    expect(normalizeOutputForActor(raw, DEFAULT_ACTOR_ID)).toEqual({ items: raw, errors: [] });
  });
});

describe("mapPostedWithin", () => {
  test("maps 24h/week/month/year and widens 1h to day", () => {
    expect(mapPostedWithin("24h")).toEqual({ postedWithin: "day" });
    expect(mapPostedWithin("1h")).toEqual({ postedWithin: "day" });
    expect(mapPostedWithin("week")).toEqual({ postedWithin: "week" });
    expect(mapPostedWithin("month")).toEqual({ postedWithin: "month" });
    expect(mapPostedWithin("year")).toEqual({ postedWithin: "year" });
  });

  test("maps 3months and 6months to a UTC startDate", () => {
    const now = new Date(Date.UTC(2026, 9, 21)); // 2026-10-21
    expect(mapPostedWithin("3months", now)).toEqual({ startDate: "2026-07-23" });
    expect(mapPostedWithin("6months", now)).toEqual({ startDate: "2026-04-24" });
  });
});

describe("buildJohnvcPostSearchInput", () => {
  test("maps search and max_items", () => {
    expect(buildJohnvcPostSearchInput({ search: "b2b sales", max_items: 25 })).toEqual({
      keywords: ["b2b sales"],
      maxPostsPerKeyword: 25,
    });
  });

  test("maps posted_within week and ignores sort", () => {
    const input = buildJohnvcPostSearchInput({
      search: "hiring",
      posted_within: "week",
      sort: "relevance",
    });
    expect(input).toEqual({
      keywords: ["hiring"],
      maxPostsPerKeyword: 10,
      postedWithin: "week",
    });
    expect(input.sort).toBeUndefined();
    expect(input.sortBy).toBeUndefined();
  });

  test("rejects start_urls", () => {
    expect(() =>
      buildJohnvcPostSearchInput({
        search: "x",
        start_urls: ["https://www.linkedin.com/in/williamhgates"],
      }),
    ).toThrow(/keyword only/);
  });

  test("rejects quotes and boolean operators", () => {
    expect(() => assertJohnvcKeyword('"exact phrase"')).toThrow(/exact phrases only/);
    expect(() => assertJohnvcKeyword("sales AND marketing")).toThrow(/exact phrases only/);
  });
});

describe("normalizeJohnvcOutput", () => {
  test("maps documented fields onto HarvestAPI-style keys", () => {
    const { items, errors } = normalizeJohnvcOutput([JOHNVC_FIXTURE_POST, JOHNVC_FIXTURE_ERROR]);
    expect(errors).toEqual([JOHNVC_FIXTURE_ERROR]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toBe("7363908644226125825");
    expect(item.content).toBe("Hiring signal: we are looking for a senior OSINT engineer.");
    expect(item.linkedinUrl).toBe(
      "https://www.linkedin.com/posts/example_activity-7363908644226125825",
    );
    expect(item.author).toEqual({
      name: "Example Author",
      linkedinUrl: "https://www.linkedin.com/in/example-author",
      info: "Founder at Example Co",
    });
    expect(item.postedAt).toEqual({ date: "2026-10-01T12:00:00.000Z" });
    expect(item.engagement).toEqual({ likes: 42, comments: 3, shares: null });
    expect(item.hashtags).toEqual(["osint"]);
    expect(item.matchedKeyword).toBe("OSINT engineer");
  });
});
