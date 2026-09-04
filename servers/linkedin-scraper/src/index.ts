/**
 * linkedin - an Edison first-party MCP server for LinkedIn.
 *
 * Four tools over the same Worker, each wrapping a public HarvestAPI Apify
 * Actor via its synchronous `run-sync-get-dataset-items` endpoint (one blocking
 * call, no polling). All scrape only public LinkedIn data and need no cookies or
 * account:
 *   - `linkedin_scrape`         - posts, via `harvestapi/linkedin-post-search` (linkedin.ts)
 *   - `linkedin_profile_search` - find people, via `harvestapi/linkedin-profile-search` (profile.ts)
 *   - `linkedin_profile`        - hydrate a known profile URL, via `harvestapi/linkedin-profile-scraper` (profile_hydrate.ts)
 *   - `linkedin_company`        - companies, via `harvestapi/linkedin-company` (company.ts)
 * The Worker holds a single first-party Apify token (APIFY_TOKEN, a secret) and
 * authenticates *callers* separately via the fleet auth contract; no per-user
 * Apify credentials.
 *
 * Transport: streamable HTTP at `/mcp` (McpAgent / Durable Object).
 * Auth: pluggable (see ./auth); production runs `edison-jwt`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { checkAuth } from "./auth";
import {
  DEFAULT_COMPANY_ACTOR_ID,
  MAX_COMPANY_TARGETS,
  buildCompanyInput,
  companyTargetCount,
  hasCompanyTarget,
  type LinkedinCompanyArgs,
} from "./company";
import {
  APIFY_BASE,
  DEFAULT_ACTOR_ID,
  RUN_TIMEOUT_S,
  buildActorInput,
  hasTarget,
  runSyncUrl,
  validateDatasetItems,
  type LinkedinScrapeArgs,
} from "./linkedin";
import {
  DEFAULT_PROFILE_ACTOR_ID,
  MAX_PROFILE_MAX_ITEMS,
  buildProfileSearchInput,
  hasProfileSearchTarget,
  type LinkedinProfileSearchArgs,
} from "./profile";
import {
  DEFAULT_PROFILE_HYDRATE_ACTOR_ID,
  MAX_PROFILE_URLS,
  buildProfileInput,
  hasProfileTarget,
  profileTargetCount,
  type LinkedinProfileArgs,
} from "./profile_hydrate";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // Apify API token for the server's own account. SECRET - set with
  // `wrangler secret put APIFY_TOKEN`, never in wrangler.jsonc vars.
  APIFY_TOKEN?: string;
  // Optional overrides (public config).
  APIFY_ACTOR_ID?: string;
  APIFY_PROFILE_ACTOR_ID?: string;
  APIFY_PROFILE_HYDRATE_ACTOR_ID?: string;
  APIFY_COMPANY_ACTOR_ID?: string;
  APIFY_BASE_URL?: string;
  // Fleet auth (see ./auth, ./jwt).
  AUTH_TOKEN?: string;
  AUTH_MODE?: string;
  EDISON_JWKS_URL?: string;
  EDISON_JWT_ISSUER?: string;
  EDISON_JWT_AUDIENCE?: string;
}

function textError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

type ActorRun =
  | { ok: true; items: Record<string, unknown>[] }
  | { ok: false; message: string };

/**
 * Run an Apify Actor's synchronous run-and-fetch endpoint and validate the
 * dataset. Shared by every tool; this is the single APIFY_TOKEN guard, so a
 * misconfigured deploy fails closed here rather than in each handler.
 */
async function runActor(env: Env, actorId: string, body: Record<string, unknown>): Promise<ActorRun> {
  const token = env.APIFY_TOKEN?.trim();
  if (!token) return { ok: false, message: "server misconfigured: APIFY_TOKEN not set" };

  const base = env.APIFY_BASE_URL?.trim() || APIFY_BASE;
  const url = new URL(runSyncUrl(actorId, base));
  url.searchParams.set("timeout", String(RUN_TIMEOUT_S));
  url.searchParams.set("format", "json");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      // Bearer header rather than a ?token= query param: keeps the secret out of
      // URLs that proxies and servers may log.
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((RUN_TIMEOUT_S + 15) * 1000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "Error";
    return { ok: false, message: `could not reach Apify: ${name}` };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return { ok: false, message: `Apify returned ${res.status}: ${errBody.slice(0, 500)}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, message: "Apify returned invalid JSON" };
  }

  const parsed = validateDatasetItems(json);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  return { ok: true, items: parsed.items };
}

export class LinkedinMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "linkedin", version: "0.1.0" });

  async init(): Promise<void> {
    this.registerScrapeTool();
    this.registerProfileSearchTool();
    this.registerProfileTool();
    this.registerCompanyTool();
  }

  private registerScrapeTool(): void {
    this.server.registerTool(
      "linkedin_scrape",
      {
        description:
          "Search and scrape public LinkedIn POSTS. Provide `search` (the same query you would type " +
          "in the LinkedIn search bar) or one or more `start_urls` pointing at LinkedIn profiles or " +
          "companies whose posts to fetch. Returns the matched dataset items (posts).",
        inputSchema: {
          search: z.string().optional().describe("Search query to look up LinkedIn posts."),
          start_urls: z
            .array(z.string())
            .optional()
            .describe("LinkedIn profile or company URLs whose posts (and reposts) to scrape."),
          sort: z
            .enum(["relevance", "date"])
            .optional()
            .describe("Ordering applied to a search (default: date)."),
          posted_within: z
            .enum(["1h", "24h", "week", "month", "3months", "6months", "year"])
            .optional()
            .describe("Restrict to posts no older than this window."),
          max_items: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Maximum number of posts to return per query (default: 10)."),
        },
        outputSchema: {
          count: z.number().describe("Number of items returned."),
          items: z
            .array(z.record(z.string(), z.any()))
            .describe("Raw dataset items (posts) from the Apify Actor run."),
        },
      },
      async (args: LinkedinScrapeArgs) => {
        // Validate the caller's request first, so a bad call gets an actionable
        // error before we attempt a run (runActor enforces server config).
        if (!hasTarget(args)) {
          return textError("provide either 'search' or at least one valid LinkedIn URL in 'start_urls'");
        }
        const actorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildActorInput(args));
        if (!run.ok) return textError(run.message);

        return {
          content: [{ type: "text" as const, text: `LinkedIn scrape returned ${run.items.length} item(s)` }],
          structuredContent: { count: run.items.length, items: run.items },
        };
      },
    );
  }

  private registerProfileSearchTool(): void {
    this.server.registerTool(
      "linkedin_profile_search",
      {
        description:
          "Find PEOPLE on LinkedIn: search public profiles by a fuzzy query and/or structured " +
          "filters (job title, company, location, school, name). Returns matching people profiles " +
          "(name, headline, current role, location...). At least a `search` query or one filter is " +
          "required. Use `linkedin_company` for company pages and `linkedin_scrape` for posts.",
        inputSchema: {
          search: z
            .string()
            .optional()
            .describe("Fuzzy search query, e.g. 'head of growth fintech london'."),
          mode: z
            .enum(["Short", "Full"])
            .optional()
            .describe("Detail per profile: 'Short' summary (default) or 'Full' rich profile."),
          max_items: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              `Maximum profiles to return (default: 10; values above ${MAX_PROFILE_MAX_ITEMS} are clamped down to it).`,
            ),
          locations: z.array(z.string().max(100)).max(50).optional().describe("Filter by location."),
          current_companies: z
            .array(z.string().max(200))
            .max(50)
            .optional()
            .describe("Filter by current company name."),
          past_companies: z
            .array(z.string().max(200))
            .max(50)
            .optional()
            .describe("Filter by a past (former) company name."),
          schools: z.array(z.string().max(200)).max(50).optional().describe("Filter by school/university."),
          current_job_titles: z
            .array(z.string().max(200))
            .max(50)
            .optional()
            .describe("Filter by current job title, e.g. ['Software Engineer']."),
          past_job_titles: z
            .array(z.string().max(200))
            .max(50)
            .optional()
            .describe("Filter by a past job title."),
          first_names: z.array(z.string().max(100)).max(50).optional().describe("Filter by first name."),
          last_names: z.array(z.string().max(100)).max(50).optional().describe("Filter by last name."),
          recently_changed_jobs: z
            .boolean()
            .optional()
            .describe("Only people who recently changed jobs (refines a query; can't be the only target)."),
          recently_posted: z
            .boolean()
            .optional()
            .describe("Only people who recently posted on LinkedIn (refines a query; can't be the only target)."),
        },
        outputSchema: {
          count: z.number().describe("Number of profiles returned."),
          profiles: z
            .array(z.record(z.string(), z.any()))
            .describe("Matched LinkedIn people-profile objects from the Apify Actor run."),
        },
      },
      async (args: LinkedinProfileSearchArgs) => {
        if (!hasProfileSearchTarget(args)) {
          return textError(
            "provide a 'search' query or at least one filter (job title, company, location, school, name)",
          );
        }
        const actorId = this.env.APIFY_PROFILE_ACTOR_ID?.trim() || DEFAULT_PROFILE_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildProfileSearchInput(args));
        if (!run.ok) return textError(run.message);

        return {
          content: [
            { type: "text" as const, text: `LinkedIn profile search returned ${run.items.length} profile(s)` },
          ],
          structuredContent: { count: run.items.length, profiles: run.items },
        };
      },
    );
  }

  private registerProfileTool(): void {
    this.server.registerTool(
      "linkedin_profile",
      {
        description:
          "Hydrate KNOWN LinkedIn profile URLs into full public profiles: name, headline, current " +
          "position, location, education, skills, follower counts... Provide `profile_urls` (LinkedIn " +
          "profile URLs you already have, e.g. from a post author or a search result). Returns one " +
          "profile object per URL. Use `linkedin_profile_search` to FIND people from a query instead.",
        inputSchema: {
          profile_urls: z
            .array(z.string().max(2048))
            .max(MAX_PROFILE_URLS)
            .describe('LinkedIn profile URLs to scrape, e.g. ["https://www.linkedin.com/in/williamhgates"].'),
        },
        outputSchema: {
          count: z.number().describe("Number of profiles returned."),
          profiles: z
            .array(z.record(z.string(), z.any()))
            .describe("Hydrated LinkedIn people-profile objects from the Apify Actor run."),
        },
      },
      async (args: LinkedinProfileArgs) => {
        if (!hasProfileTarget(args)) {
          return textError("provide at least one valid LinkedIn profile URL in 'profile_urls'");
        }
        // Combined cap (the per-field schema limit and this check agree, but keep
        // it explicit so a future schema loosening still fails closed).
        if (profileTargetCount(args) > MAX_PROFILE_URLS) {
          return textError(`too many targets: at most ${MAX_PROFILE_URLS} profiles per call`);
        }
        const actorId = this.env.APIFY_PROFILE_HYDRATE_ACTOR_ID?.trim() || DEFAULT_PROFILE_HYDRATE_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildProfileInput(args));
        if (!run.ok) return textError(run.message);

        return {
          content: [
            { type: "text" as const, text: `LinkedIn profile lookup returned ${run.items.length} profile(s)` },
          ],
          structuredContent: { count: run.items.length, profiles: run.items },
        };
      },
    );
  }

  private registerCompanyTool(): void {
    this.server.registerTool(
      "linkedin_company",
      {
        description:
          "Look up LinkedIn COMPANY pages: industry, headcount, headquarters, about, and recent " +
          "activity. Provide `company_urls` (LinkedIn company URLs) and/or `names` (company names " +
          "to search). Returns one company object per resolved target. Use `linkedin_profile_search` " +
          "for people and `linkedin_scrape` for posts.",
        inputSchema: {
          company_urls: z
            .array(z.string().max(2048))
            .max(MAX_COMPANY_TARGETS)
            .optional()
            .describe('LinkedIn company URLs, e.g. ["https://www.linkedin.com/company/openai"].'),
          names: z
            .array(z.string().max(200))
            .max(MAX_COMPANY_TARGETS)
            .optional()
            .describe('Company names to search, e.g. ["OpenAI", "Anthropic"].'),
        },
        outputSchema: {
          count: z.number().describe("Number of companies returned."),
          companies: z
            .array(z.record(z.string(), z.any()))
            .describe("Matched LinkedIn company objects from the Apify Actor run."),
        },
      },
      async (args: LinkedinCompanyArgs) => {
        if (!hasCompanyTarget(args)) {
          return textError("provide at least one LinkedIn company URL in 'company_urls' or a company name in 'names'");
        }
        // Combined cap across both target fields (the per-field schema limits
        // would otherwise allow twice this many, doubling the paid run).
        if (companyTargetCount(args) > MAX_COMPANY_TARGETS) {
          return textError(`too many targets: at most ${MAX_COMPANY_TARGETS} companies per call`);
        }
        const actorId = this.env.APIFY_COMPANY_ACTOR_ID?.trim() || DEFAULT_COMPANY_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildCompanyInput(args));
        if (!run.ok) return textError(run.message);

        return {
          content: [
            { type: "text" as const, text: `LinkedIn company lookup returned ${run.items.length} company(ies)` },
          ],
          structuredContent: { count: run.items.length, companies: run.items },
        };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "linkedin" });
    }

    if (url.pathname === "/mcp") {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.status === 401) headers["www-authenticate"] = 'Bearer realm="linkedin"';
        return new Response(JSON.stringify({ error: auth.message }), { status: auth.status, headers });
      }
      return LinkedinMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
