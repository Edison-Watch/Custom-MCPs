/**
 * linkedin - an Edison first-party MCP server.
 *
 * Search and scrape public LinkedIn posts by keyword or by author profile /
 * company. Wraps the `harvestapi/linkedin-post-search` Apify Actor via its
 * synchronous `run-sync-get-dataset-items` endpoint (one blocking call, no
 * polling) and returns the raw dataset items. The Actor needs no LinkedIn
 * cookies or account. The Worker holds a single first-party Apify token
 * (APIFY_TOKEN, a secret) and authenticates *callers* separately via the fleet
 * auth contract; no per-user Apify credentials.
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
  DEFAULT_ACTOR_ID,
  RUN_TIMEOUT_S,
  buildActorInput,
  hasTarget,
  runSyncUrl,
  validateDatasetItems,
  type LinkedinScrapeArgs,
} from "./linkedin";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // Apify API token for the server's own account. SECRET - set with
  // `wrangler secret put APIFY_TOKEN`, never in wrangler.jsonc vars.
  APIFY_TOKEN?: string;
  // Optional overrides (public config).
  APIFY_ACTOR_ID?: string;
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

export class LinkedinMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "linkedin", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "linkedin_scrape",
      {
        description:
          "Search and scrape public LinkedIn posts. Provide `search` (the same query you would type " +
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
            .describe("Raw dataset items from the Apify Actor run."),
        },
      },
      async (args: LinkedinScrapeArgs) => {
        // Validate the caller's request before checking server config, so a bad
        // call gets an actionable error regardless of deploy state.
        if (!hasTarget(args)) {
          return textError("provide either 'search' or at least one valid LinkedIn URL in 'start_urls'");
        }
        const token = this.env.APIFY_TOKEN?.trim();
        if (!token) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const actorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
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
            body: JSON.stringify(buildActorInput(args)),
            signal: AbortSignal.timeout((RUN_TIMEOUT_S + 15) * 1000),
          });
        } catch (err) {
          const name = err instanceof Error ? err.constructor.name : "Error";
          return textError(`could not reach Apify: ${name}`);
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return textError(`Apify returned ${res.status}: ${body.slice(0, 500)}`);
        }

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return textError("Apify returned invalid JSON");
        }

        const parsed = validateDatasetItems(json);
        if (!parsed.ok) return textError(parsed.error);

        const structuredContent = { count: parsed.items.length, items: parsed.items };
        return {
          content: [
            { type: "text" as const, text: `LinkedIn scrape returned ${parsed.items.length} item(s)` },
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
