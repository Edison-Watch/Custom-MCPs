/**
 * reddit - an Edison first-party MCP server.
 *
 * Search and scrape Reddit posts, comments, communities, and users. Wraps the
 * `trudax/reddit-scraper-lite` Apify Actor (swappable via APIFY_ACTOR_ID). The
 * fast `reddit_scrape` tool uses the synchronous `run-sync-get-dataset-items`
 * endpoint (one blocking call); the `reddit_scrape_start` / `reddit_scrape_fetch`
 * pair runs a slow query asynchronously (enqueue a run, then poll it). All three
 * return items normalized onto a stable, actor-agnostic shape (see ./reddit).
 * The Worker holds a single first-party Apify token
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
  SUCCEEDED,
  TERMINAL_FAILURE,
  buildActorInput,
  datasetItemsUrl,
  hasTarget,
  normalizeItems,
  parseRunStart,
  parseRunStatus,
  runStatusUrl,
  runSyncUrl,
  runsUrl,
  validateDatasetItems,
  type RedditScrapeArgs,
} from "./reddit";

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

// Shared across the sync `reddit_scrape` and the async `reddit_scrape_start`,
// which take the same query; defined once so the three tools cannot drift.
const scrapeInputSchema = {
  search: z.string().optional().describe("Search term to look up on Reddit."),
  subreddit: z
    .string()
    .optional()
    .describe("Restrict a search to one community, e.g. 'programming'. Ignored without search."),
  start_urls: z
    .array(z.string())
    .optional()
    .describe("Explicit Reddit post/community/user URLs to scrape directly."),
  sort: z
    .enum(["relevance", "hot", "top", "new", "rising", "comments"])
    .optional()
    .describe("Ordering applied to a search (default: new)."),
  time_filter: z
    .enum(["all", "hour", "day", "week", "month", "year"])
    .optional()
    .describe("Restrict posts to a recency window (posts only)."),
  max_items: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of dataset items to return (default: 10)."),
  include_comments: z
    .boolean()
    .optional()
    .describe("Also scrape comments on matched posts (default: false)."),
  include_nsfw: z.boolean().optional().describe("Include NSFW results (default: false)."),
  include_media_links: z
    .boolean()
    .optional()
    .describe(
      "Extract engagement fields (upvotes, comment count, upvote ratio) and media URLs " +
        "(default: false). Off uses the fast RSS mode that omits engagement; on switches to " +
        "a slower detailed scrape. Enable when ranking needs reach/engagement signal.",
    ),
};

// The stable, actor-agnostic item shape, shared by every tool that returns items.
const normalizedItemSchema = z.object({
  id: z.string().nullable().describe("Actor item id, if any."),
  type: z.enum(["post", "comment", "community", "user"]).nullable().describe("Item kind."),
  title: z.string().nullable().describe("Post title."),
  body: z.string().nullable().describe("Post selftext or comment body."),
  author: z.string().nullable().describe("Author username."),
  subreddit: z.string().nullable().describe("Community name."),
  url: z.string().nullable().describe("Canonical URL for the item."),
  permalink: z.string().nullable().describe("Reddit permalink path, when derivable."),
  created_at: z.string().nullable().describe("Creation time (ISO8601)."),
  score: z.number().nullable().describe("Net upvotes; null when the Actor omits it."),
  num_comments: z.number().nullable().describe("Comment count; null when the Actor omits it."),
  upvote_ratio: z.number().nullable().describe("Upvote ratio 0..1; null when the Actor omits it."),
  over_18: z.boolean().nullable().describe("NSFW flag; null when the Actor omits it."),
  num_crossposts: z.number().nullable().describe("Crosspost count; null when the Actor omits it."),
  raw: z.record(z.string(), z.any()).describe("The untouched Actor dataset item."),
});

export class RedditMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "reddit", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "reddit_scrape",
      {
        description:
          "Search and scrape Reddit. Provide `search` (optionally narrowed to a `subreddit`) or " +
          "one or more `start_urls` pointing at Reddit posts/communities/users. Returns the matched " +
          "dataset items (posts by default; comments too when include_comments is set). Fast path " +
          "for listing/comment pulls; use reddit_scrape_start for slow keyword searches.",
        inputSchema: scrapeInputSchema,
        outputSchema: {
          count: z.number().describe("Number of items returned."),
          items: z
            .array(normalizedItemSchema)
            .describe("Normalized dataset items (raw Actor item preserved per item)."),
        },
      },
      async (args: RedditScrapeArgs) => {
        // Validate the caller's request before checking server config, so a bad
        // call gets an actionable error regardless of deploy state.
        if (!hasTarget(args)) {
          return textError("provide either 'search' or at least one 'start_urls' entry");
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

        // Normalize onto the stable, actor-agnostic shape so callers never
        // depend on the configured Actor's raw field names.
        const items = normalizeItems(parsed.items, actorId);
        const structuredContent = { count: items.length, items };
        return {
          content: [
            { type: "text" as const, text: `Reddit scrape returned ${items.length} item(s)` },
          ],
          structuredContent,
        };
      },
    );

    // Async run + poll. Mirrors services/reddit_svc.py: start enqueues a run
    // without blocking, fetch polls it and normalizes items once SUCCEEDED.
    this.server.registerTool(
      "reddit_scrape_start",
      {
        description:
          "Start an asynchronous Reddit scrape and return immediately with a run id (no blocking). " +
          "Use for slow keyword searches that outlast a synchronous call; poll reddit_scrape_fetch " +
          "with the run_id for results.",
        inputSchema: scrapeInputSchema,
        outputSchema: {
          run_id: z.string().describe("Apify actor-run id; pass to reddit_scrape_fetch."),
          dataset_id: z.string().describe("Default dataset id for the run."),
          status: z.string().describe("Initial run status (e.g. READY or RUNNING) - not yet terminal."),
        },
      },
      async (args: RedditScrapeArgs) => {
        if (!hasTarget(args)) {
          return textError("provide either 'search' or at least one 'start_urls' entry");
        }
        const token = this.env.APIFY_TOKEN?.trim();
        if (!token) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const actorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
        const base = this.env.APIFY_BASE_URL?.trim() || APIFY_BASE;

        let res: Response;
        try {
          res = await fetch(runsUrl(actorId, base), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(buildActorInput(args)),
            // Short budget: this call only enqueues a run, it never waits on it.
            signal: AbortSignal.timeout(30_000),
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

        const parsed = parseRunStart(json);
        if (!parsed.ok) return textError(parsed.error);

        const structuredContent = {
          run_id: parsed.run_id,
          dataset_id: parsed.dataset_id,
          status: parsed.status,
        };
        return {
          content: [{ type: "text" as const, text: `Started run ${parsed.run_id} (${parsed.status})` }],
          structuredContent,
        };
      },
    );

    this.server.registerTool(
      "reddit_scrape_fetch",
      {
        description:
          "Poll an asynchronous Reddit scrape started by reddit_scrape_start. Returns the run status; " +
          "items are empty while it is still running and populated once it has SUCCEEDED. Poll again " +
          "on a non-terminal status.",
        inputSchema: {
          // Opaque Apify run id: reject anything with path/query syntax so a
          // caller value can never reshape the actor-runs URL (mirrors the
          // Python RedditScrapeFetchInput.run_id guard).
          run_id: z
            .string()
            .min(1)
            .regex(/^[A-Za-z0-9_-]+$/)
            .describe("Apify actor-run id returned by reddit_scrape_start."),
        },
        outputSchema: {
          status: z.string().describe("Apify run status at poll time."),
          count: z.number().describe("Number of items returned (0 until SUCCEEDED)."),
          items: z
            .array(normalizedItemSchema)
            .describe("Normalized dataset items once SUCCEEDED (raw Actor item preserved)."),
        },
      },
      async (args: { run_id?: string }) => {
        const runId = args.run_id?.trim();
        if (!runId) {
          return textError("provide a 'run_id' from reddit_scrape_start");
        }
        const token = this.env.APIFY_TOKEN?.trim();
        if (!token) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const actorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
        const base = this.env.APIFY_BASE_URL?.trim() || APIFY_BASE;
        const headers = { authorization: `Bearer ${token}` };

        // 1. Run-status GET - always fast.
        let runRes: Response;
        try {
          runRes = await fetch(runStatusUrl(runId, base), {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          const name = err instanceof Error ? err.constructor.name : "Error";
          return textError(`could not reach Apify: ${name}`);
        }
        if (!runRes.ok) {
          const body = await runRes.text().catch(() => "");
          return textError(`Apify returned ${runRes.status}: ${body.slice(0, 500)}`);
        }
        let runJson: unknown;
        try {
          runJson = await runRes.json();
        } catch {
          return textError("Apify returned invalid JSON");
        }
        const status = parseRunStatus(runJson);
        if (!status.ok) return textError(status.error);

        // Non-terminal or terminal-failure: hand back the status with no items.
        // Split the two so the message states intent - a terminal failure means
        // stop polling, a non-terminal status means poll again.
        if (status.status !== SUCCEEDED) {
          const text = TERMINAL_FAILURE.has(status.status)
            ? `Run ${runId} ended without items: ${status.status}`
            : `Run ${runId} status: ${status.status} - poll again`;
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { status: status.status, count: 0, items: [] },
          };
        }

        if (!status.dataset_id) {
          return textError("Apify run SUCCEEDED but returned no defaultDatasetId");
        }

        // 2. Dataset items GET - the run has finished, so this is fast too.
        const itemsUrl = new URL(datasetItemsUrl(status.dataset_id, base));
        itemsUrl.searchParams.set("format", "json");
        itemsUrl.searchParams.set("clean", "true");
        let itemsRes: Response;
        try {
          itemsRes = await fetch(itemsUrl.toString(), {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(60_000),
          });
        } catch (err) {
          const name = err instanceof Error ? err.constructor.name : "Error";
          return textError(`could not reach Apify: ${name}`);
        }
        if (!itemsRes.ok) {
          const body = await itemsRes.text().catch(() => "");
          return textError(`Apify returned ${itemsRes.status}: ${body.slice(0, 500)}`);
        }
        let itemsJson: unknown;
        try {
          itemsJson = await itemsRes.json();
        } catch {
          return textError("Apify returned invalid JSON");
        }
        const parsed = validateDatasetItems(itemsJson);
        if (!parsed.ok) return textError(parsed.error);

        const items = normalizeItems(parsed.items, actorId);
        return {
          content: [
            { type: "text" as const, text: `Run ${runId} SUCCEEDED with ${items.length} item(s)` },
          ],
          structuredContent: { status: SUCCEEDED, count: items.length, items },
        };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "reddit" });
    }

    if (url.pathname === "/mcp") {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.status === 401) headers["www-authenticate"] = 'Bearer realm="reddit"';
        return new Response(JSON.stringify({ error: auth.message }), { status: auth.status, headers });
      }
      return RedditMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
