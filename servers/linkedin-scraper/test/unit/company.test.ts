import { describe, expect, test } from "bun:test";

import {
  MAX_COMPANY_TARGETS,
  buildCompanyInput,
  companyTargetCount,
  companyTargets,
  hasCompanyTarget,
} from "../../src/company";

describe("companyTargets", () => {
  test("keeps only /company/ URLs, dropping member-profile, off-domain, and blank names", () => {
    const t = companyTargets({
      company_urls: [
        "https://www.linkedin.com/company/openai",
        "https://www.linkedin.com/in/alice",
        "https://evil.com/x",
      ],
      names: [" Anthropic ", "  "],
    });
    expect(t.urls).toEqual(["https://www.linkedin.com/company/openai"]);
    expect(t.names).toEqual(["Anthropic"]);
  });
});

describe("hasCompanyTarget", () => {
  test("true for a valid URL or a name, false otherwise", () => {
    expect(hasCompanyTarget({ company_urls: ["https://linkedin.com/company/google"] })).toBe(true);
    expect(hasCompanyTarget({ names: ["Google"] })).toBe(true);
    expect(hasCompanyTarget({ company_urls: ["https://evil.com/x"] })).toBe(false);
    expect(hasCompanyTarget({ names: ["  "] })).toBe(false);
    expect(hasCompanyTarget({})).toBe(false);
  });
});

describe("companyTargetCount", () => {
  test("counts valid URLs plus names", () => {
    expect(
      companyTargetCount({
        company_urls: ["https://linkedin.com/company/a", "https://linkedin.com/company/b"],
        names: ["c"],
      }),
    ).toBe(3);
    expect(companyTargetCount({})).toBe(0);
    // The per-field zod cap is MAX_COMPANY_TARGETS each, so a combined request
    // can exceed the per-call limit - the tool re-checks this count. Exercise
    // that overflow explicitly: MAX_COMPANY_TARGETS URLs + 1 name > the cap.
    expect(
      companyTargetCount({
        company_urls: Array.from(
          { length: MAX_COMPANY_TARGETS },
          (_, i) => `https://linkedin.com/company/c${i}`,
        ),
        names: ["extra"],
      }),
    ).toBe(MAX_COMPANY_TARGETS + 1);
  });
});

describe("buildCompanyInput", () => {
  test("maps URLs to `companies` and names to `searches`, omitting empty fields", () => {
    expect(buildCompanyInput({ company_urls: ["https://linkedin.com/company/openai"] })).toEqual({
      companies: ["https://linkedin.com/company/openai"],
    });
    expect(buildCompanyInput({ names: ["OpenAI", "OpenAI"] })).toEqual({ searches: ["OpenAI"] });
    expect(
      buildCompanyInput({
        company_urls: ["https://linkedin.com/company/openai"],
        names: ["Anthropic"],
      }),
    ).toEqual({
      companies: ["https://linkedin.com/company/openai"],
      searches: ["Anthropic"],
    });
  });
});
