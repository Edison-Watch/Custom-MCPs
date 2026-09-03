/**
 * x - an Edison first-party MCP server for X (formerly Twitter).
 *
 * Search and scrape X/Twitter tweets, profiles, searches, and lists. Wraps the
 * `apidojo/tweet-scraper` Apify Actor via its synchronous
 * `run-sync-get-dataset-items` endpoint (one blocking call, no polling) and
 * returns the raw dataset items. The Worker holds a single first-party Apify
 * token (APIFY_TOKEN, a secret) and authenticates *callers* separately via the
 * fleet auth contract; no per-user Apify credentials.
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
  type XScrapeArgs,
} from "./x";

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

export class XMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "x", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "x_scrape",
      {
        description:
          "Search and scrape X (formerly Twitter). Provide `search` (X advanced-search operators " +
          "like from:, to:, filter:, since:, until: are supported) and/or `from_user` to restrict " +
          "to one account's tweets. Returns the matched dataset items (tweets).",
        inputSchema: {
          search: z
            .string()
            .optional()
            .describe("Search query for X. Advanced-search operators (from:, filter:media, etc.) are allowed."),
          from_user: z
            .string()
            .optional()
            .describe("Restrict results to tweets from this X handle (with or without a leading @)."),
          sort: z
            .enum(["Latest", "Top", "Photos", "Videos"])
            .optional()
            .describe("Kind/ordering of results (default: Latest)."),
          since: z
            .string()
            .optional()
            .describe("Only tweets on/after this date, e.g. '2024-01-01'."),
          until: z
            .string()
            .optional()
            .describe("Only tweets on/before this date, e.g. '2024-12-31'."),
          max_items: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Approximate maximum number of tweets to return (default: 10; the Actor pages in batches)."),
          only_verified: z
            .boolean()
            .optional()
            .describe("Only return tweets by Twitter Blue (verified) accounts (default: false)."),
        },
        outputSchema: {
          count: z.number().describe("Number of items returned."),
          items: z
            .array(z.record(z.string(), z.any()))
            .describe("Raw dataset items from the Apify Actor run."),
        },
      },
      async (args: XScrapeArgs) => {
        // Validate the caller's request before checking server config, so a bad
        // call gets an actionable error regardless of deploy state.
        if (!hasTarget(args)) {
          return textError("provide either 'search' or a 'from_user' handle");
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
            { type: "text" as const, text: `X scrape returned ${parsed.items.length} item(s)` },
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
      return Response.json({ ok: true, service: "x" });
    }

    if (url.pathname === "/mcp") {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.status === 401) headers["www-authenticate"] = 'Bearer realm="x"';
        return new Response(JSON.stringify({ error: auth.message }), { status: auth.status, headers });
      }
      return XMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
