import { describe, expect, test } from "bun:test";

import {
  MAX_PROFILE_URLS,
  PROFILE_SCRAPER_MODE_NO_EMAIL,
  buildProfileInput,
  hasProfileTarget,
  profileTargetCount,
  profileUrlTargets,
} from "../../src/profile_hydrate";

describe("profileUrlTargets", () => {
  test("keeps only /in/ profile URLs, drops company/off-domain, trims and de-dupes in order", () => {
    expect(
      profileUrlTargets({
        profile_urls: [
          " https://www.linkedin.com/in/williamhgates ",
          "https://www.linkedin.com/in/williamhgates",
          "https://www.linkedin.com/company/openai",
          "https://evil.com/in/x",
          "https://linkedin.com/in/satyanadella",
        ],
      }),
    ).toEqual(["https://www.linkedin.com/in/williamhgates", "https://linkedin.com/in/satyanadella"]);
    expect(profileUrlTargets({})).toEqual([]);
  });
});

describe("hasProfileTarget", () => {
  test("true only when at least one valid /in/ profile URL is present", () => {
    expect(hasProfileTarget({ profile_urls: ["https://www.linkedin.com/in/williamhgates"] })).toBe(true);
    expect(hasProfileTarget({ profile_urls: ["https://evil.com/in/x"] })).toBe(false);
    // A valid LinkedIn URL that is not a member profile (a company page) is not a target.
    expect(hasProfileTarget({ profile_urls: ["https://www.linkedin.com/company/openai"] })).toBe(false);
    expect(hasProfileTarget({ profile_urls: ["   "] })).toBe(false);
    expect(hasProfileTarget({})).toBe(false);
  });
});

describe("profileTargetCount", () => {
  test("counts valid URLs only", () => {
    expect(
      profileTargetCount({
        profile_urls: ["https://linkedin.com/in/a", "https://linkedin.com/in/b", "https://evil.com/x"],
      }),
    ).toBe(2);
    expect(profileTargetCount({})).toBe(0);
    expect(MAX_PROFILE_URLS).toBeGreaterThan(0);
  });
});

describe("buildProfileInput", () => {
  test("maps URLs to the Actor `urls` field and fixes the no-email scraper mode", () => {
    expect(
      buildProfileInput({
        profile_urls: ["https://www.linkedin.com/in/williamhgates", "https://www.linkedin.com/in/williamhgates"],
      }),
    ).toEqual({
      profileScraperMode: PROFILE_SCRAPER_MODE_NO_EMAIL,
      urls: ["https://www.linkedin.com/in/williamhgates"],
    });
  });

  test("never selects the email-search mode", () => {
    const input = buildProfileInput({ profile_urls: ["https://linkedin.com/in/x"] });
    // The paid PII mode is "Profile details + email search"; the safe mode is
    // "... no email". Assert we are on the no-email path, not any email search.
    expect(String(input.profileScraperMode).toLowerCase()).not.toContain("email search");
    expect(input.profileScraperMode).toBe(PROFILE_SCRAPER_MODE_NO_EMAIL);
  });
});
