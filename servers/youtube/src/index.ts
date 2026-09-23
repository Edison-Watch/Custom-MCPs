/**
 * youtube - an Edison first-party MCP server.
 *
 * Scrape YouTube search results and video comments. Chains two Apify Actors via
 * their synchronous `run-sync-get-dataset-items` endpoint (one blocking call
 * each, no polling): `streamers/youtube-scraper` turns a search term (or start
 * URLs) into videos, then `streamers/youtube-comments-scraper` turns the
 * resulting video URLs into comments - the second run only fires when comments
 * are requested. The Worker holds a single first-party Apify token (APIFY_TOKEN,
 * a secret) and authenticates *callers* separately via the fleet auth contract;
 * no per-user Apify credentials.
 *
 * Transport: streamable HTTP at `/mcp` (McpAgent / Durable Object).
 * Auth: pluggable (see ./auth); production runs `edison-jwt`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { checkAuth } from "./auth";
import {
  APIFY_BASE,
  COMMENTS_ACTOR_ID,
  RUN_TIMEOUT_S,
  SEARCH_ACTOR_ID,
  buildCommentsInput,
  buildSearchInput,
  hasTarget,
  normalizeSearch,
  runSyncUrl,
  validStartUrls,
  validateDatasetItems,
  videoUrls,
  type YoutubeCommentSort,
  type YoutubeScrapeArgs,
} from "./youtube";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // Apify API token for the server's own account. SECRET - set with
  // `wrangler secret put APIFY_TOKEN`, never in wrangler.jsonc vars.
  APIFY_TOKEN?: string;
  // Optional overrides (public config).
  APIFY_SEARCH_ACTOR_ID?: string;
  APIFY_COMMENTS_ACTOR_ID?: string;
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

export class YoutubeMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "youtube", version: "0.1.0" });

  /** Run one Apify Actor synchronously and return its validated dataset items. */
  private async runActor(
    actorId: string,
    actorInput: Record<string, unknown>,
    token: string,
  ): Promise<Record<string, unknown>[] | { error: string }> {
    const base = this.env.APIFY_BASE_URL?.trim() || APIFY_BASE;
    const url = new URL(runSyncUrl(actorId, base));
    url.searchParams.set("timeout", String(RUN_TIMEOUT_S));
    url.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        // Bearer header rather than a ?token= query param: keeps the secret
        // out of URLs that proxies and servers may log.
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(actorInput),
        signal: AbortSignal.timeout((RUN_TIMEOUT_S + 15) * 1000),
      });
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "Error";
      return { error: `could not reach Apify: ${name}` };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `Apify returned ${res.status}: ${body.slice(0, 500)}` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { error: "Apify returned invalid JSON" };
    }

    const parsed = validateDatasetItems(json);
    if (!parsed.ok) return { error: parsed.error };
    return parsed.items;
  }

  async init(): Promise<void> {
    this.server.registerTool(
      "youtube_scrape",
      {
        description:
          "Scrape YouTube search results and video comments. Provide `search` or one or more " +
          "`start_urls` pointing at YouTube videos/channels/playlists/search pages. Returns the " +
          "matched videos and, when max_comments is raised above zero, comments on those videos.",
        inputSchema: {
          search: z.string().optional().describe("Search term to look up on YouTube."),
          start_urls: z
            .array(z.string())
            .max(50)
            .optional()
            .describe("Explicit YouTube video/channel/playlist/search URLs to scrape (max 50)."),
          sort: z
            .enum(["relevance", "rating", "date", "views"])
            .optional()
            .describe("Ordering applied to a search (default: relevance)."),
          date_filter: z
            .enum(["hour", "today", "week", "month", "year"])
            .optional()
            .describe("Restrict search results to a recency window."),
          max_results: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Maximum number of videos to return (default: 10)."),
          max_comments: z
            .number()
            .int()
            .min(0)
            .max(1000)
            .optional()
            .describe("Comments to scrape per video. 0 skips comment scraping (default: 0)."),
          comment_sort: z
            .enum(["top", "new"])
            .optional()
            .describe("Ordering for scraped comments (default: top)."),
        },
        outputSchema: {
          video_count: z.number().describe("Number of videos returned."),
          comment_count: z.number().describe("Number of comments returned."),
          videos: z
            .array(z.record(z.string(), z.any()))
            .describe("Raw video items from the search Actor run."),
          comments: z
            .array(z.record(z.string(), z.any()))
            .describe("Raw comment items from the comments Actor run (empty unless max_comments > 0)."),
        },
      },
      async (args: YoutubeScrapeArgs) => {
        // Validate the caller's request before checking server config, so a bad
        // call gets an actionable error regardless of deploy state.
        if (!hasTarget(args)) {
          return textError("provide either 'search' or at least one valid YouTube 'start_urls' entry");
        }
        // The search Actor silently drops `searchQueries` when `startUrls` is
        // present, so a mixed request would lose the search - reject it loudly.
        if (normalizeSearch(args.search) && validStartUrls(args.start_urls).length > 0) {
          return textError(
            "provide either 'search' or 'start_urls', not both (start URLs take precedence and the search term would be ignored)",
          );
        }
        const token = this.env.APIFY_TOKEN?.trim();
        if (!token) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const searchActor = this.env.APIFY_SEARCH_ACTOR_ID?.trim() || SEARCH_ACTOR_ID;
        const videos = await this.runActor(searchActor, buildSearchInput(args), token);
        if ("error" in videos) return textError(videos.error);

        let comments: Record<string, unknown>[] = [];
        const maxComments = args.max_comments ?? 0;
        if (maxComments > 0) {
          const urls = videoUrls(videos);
          if (urls.length > 0) {
            const commentsActor = this.env.APIFY_COMMENTS_ACTOR_ID?.trim() || COMMENTS_ACTOR_ID;
            const commentSort: YoutubeCommentSort = args.comment_sort ?? "top";
            const scraped = await this.runActor(
              commentsActor,
              buildCommentsInput(urls, maxComments, commentSort),
              token,
            );
            if ("error" in scraped) return textError(scraped.error);
            comments = scraped;
          }
        }

        const structuredContent = {
          video_count: videos.length,
          comment_count: comments.length,
          videos,
          comments,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `YouTube scrape returned ${videos.length} video(s) and ${comments.length} comment(s)`,
            },
          ],
          structuredContent,
        };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "youtube" });
    }

    if (url.pathname === "/mcp") {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.status === 401) headers["www-authenticate"] = 'Bearer realm="youtube"';
        return new Response(JSON.stringify({ error: auth.message }), { status: auth.status, headers });
      }
      return YoutubeMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
