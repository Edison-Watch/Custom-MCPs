/**
 * reddit - an Edison first-party MCP server.
 *
 * Search and scrape Reddit posts, comments, communities, and users. Wraps the
 * `fatihtahta/reddit-scraper-search-fast` Apify Actor (swappable via
 * APIFY_ACTOR_ID; trudax/reddit-scraper-lite is a supported fallback). The
 * fast `reddit_scrape` tool starts a run and waits up to SYNC_WAIT_S for it,
 * handing the run id back if it is still going; the `reddit_scrape_start` /
 * `reddit_scrape_fetch` pair runs a slow query asynchronously (enqueue a run,
 * then poll it). All three
 * return items normalized onto a stable, actor-agnostic shape (see ./reddit).
 * The Worker holds a single first-party Apify token
 * (APIFY_TOKEN, a secret) and authenticates *callers* separately via the fleet
 * auth contract; no per-user Apify credentials.
 *
 * Transport: streamable HTTP at `/mcp` (McpAgent / Durable Object).
 * Auth: pluggable (see ./auth); production runs `edison-jwt`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readRequestBody, requestBodyTooLargeMessage } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { buildActorInput } from "./adapters";
import { logApifyFailure, type ApifyFailure } from "./apify_log";
import { checkAuth } from "./auth";
import {
  APIFY_BASE,
  DEFAULT_ACTOR_ID,
  MIN_FETCH_S,
  SUCCEEDED,
  SYNC_BUDGET_S,
  SYNC_WAIT_S,
  datasetItemsUrl,
  hasTarget,
  normalizeItems,
  parseRunStart,
  parseRunStatus,
  runOutcome,
  runStatusUrl,
  fetchLaterMessage,
  runsUrl,
  stillRunningMessage,
  validateDatasetItems,
  type NormalizedRedditItem,
  type RedditScrapeArgs,
} from "./reddit";

// Bound on an /mcp POST body (CVE-2026-111768). agents' McpAgent.serve only checks a
// declared Content-Length, so the body is read here, bounded, before it reaches it.
const MAX_MCP_BODY_BYTES = 1024 * 1024;

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

/** Fleet server id, used to tag log events. */
const SERVICE = "reddit";

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
      "Only affects the trudax/reddit-scraper-lite Actor (set via APIFY_ACTOR_ID): it " +
        "switches lite from its fast RSS mode to a slower detailed scrape that returns " +
        "engagement fields (upvotes, comment count, upvote ratio) and media URLs. No-op on " +
        "the default fatihtahta/reddit-scraper-search-fast Actor, which always returns " +
        "engagement fields on posts (default: false).",
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

type ApifyCall = { ok: true; json: unknown } | { ok: false; message: string };
type ItemsResult = { ok: true; items: NormalizedRedditItem[] } | { ok: false; message: string };

export class RedditMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "reddit", version: "0.1.0" });

  private actorId(): string {
    return this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
  }

  private apifyBase(): string {
    return this.env.APIFY_BASE_URL?.trim() || APIFY_BASE;
  }

  /**
   * One Apify API call: fetch, check the status, parse the JSON. Every failure
   * is logged (see ./apify_log) before it becomes the caller's error message, so
   * an Apify outage shows up in Workers Logs instead of only in isError results.
   */
  private async callApify(
    token: string,
    actorId: string,
    url: string,
    opts: { method: "GET" | "POST"; body?: unknown; timeoutMs: number; runId?: string },
  ): Promise<ApifyCall> {
    const fail = (f: Omit<ApifyFailure, "service" | "actor" | "runId">): ApifyCall => ({
      ok: false,
      message: logApifyFailure({ service: SERVICE, actor: actorId, runId: opts.runId, ...f }),
    });

    // Bearer header rather than a ?token= query param: keeps the secret out of
    // URLs that proxies and servers may log.
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "Error";
      return fail({ stage: "network", message: `could not reach Apify: ${name}` });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return fail({
        stage: "http",
        status: res.status,
        body,
        message: `Apify returned ${res.status}: ${body.slice(0, 500)}`,
      });
    }

    try {
      return { ok: true, json: await res.json() };
    } catch {
      return fail({ stage: "json", message: "Apify returned invalid JSON" });
    }
  }

  /** Log a malformed Apify response and return the caller-facing message. */
  private badShape(actorId: string, message: string, runId?: string): string {
    return logApifyFailure({ service: SERVICE, actor: actorId, stage: "json", message, runId });
  }

  /** Fetch a finished run's dataset and normalize it onto the stable item shape. */
  private async fetchItems(
    token: string,
    actorId: string,
    datasetId: string,
    runId: string,
    timeoutMs: number = 60_000,
  ): Promise<ItemsResult> {
    const url = new URL(datasetItemsUrl(datasetId, this.apifyBase()));
    url.searchParams.set("format", "json");
    url.searchParams.set("clean", "true");
    // The run has finished, so this is normally fast.
    const res = await this.callApify(token, actorId, url.toString(), { method: "GET", timeoutMs, runId });
    if (!res.ok) return res;

    const parsed = validateDatasetItems(res.json);
    if (!parsed.ok) {
      return {
        ok: false,
        message: logApifyFailure({ service: SERVICE, actor: actorId, stage: "dataset", message: parsed.error, runId }),
      };
    }
    // Normalize onto the stable, actor-agnostic shape so callers never depend
    // on the configured Actor's raw field names.
    return { ok: true, items: normalizeItems(parsed.items, actorId) };
  }

  async init(): Promise<void> {
    this.server.registerTool(
      "reddit_scrape",
      {
        description:
          "Search and scrape Reddit. Provide `search` (optionally narrowed to a `subreddit`) or " +
          "one or more `start_urls` pointing at Reddit posts/communities/users. Returns the matched " +
          "dataset items (posts by default; comments too when include_comments is set). Fast path " +
          `for listing/comment pulls: a run that takes longer than ${SYNC_WAIT_S}s returns an error ` +
          "carrying its run_id for reddit_scrape_fetch. Use reddit_scrape_start for slow keyword searches.",
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

        const actorId = this.actorId();
        // The whole call, start-and-wait plus dataset fetch, fits in SYNC_BUDGET_S.
        const deadline = Date.now() + SYNC_BUDGET_S * 1000;
        // Start the run and let Apify hold the response until it finishes, up to
        // SYNC_WAIT_S. Unlike run-sync-get-dataset-items, a slow run is not lost
        // when the wait runs out: its id goes back to the caller.
        const url = new URL(runsUrl(actorId, this.apifyBase()));
        url.searchParams.set("waitForFinish", String(SYNC_WAIT_S));
        const res = await this.callApify(token, actorId, url.toString(), {
          method: "POST",
          body: buildActorInput(args, actorId),
          timeoutMs: SYNC_BUDGET_S * 1000,
        });
        if (!res.ok) return textError(res.message);

        const run = parseRunStart(res.json);
        if (!run.ok) return textError(this.badShape(actorId, run.error));

        const outcome = runOutcome(run.status);
        if (outcome === "running") {
          console.warn({ event: "reddit_scrape_handed_off", run_id: run.run_id, reason: "still_running" });
          return textError(stillRunningMessage(run.run_id));
        }
        if (outcome === "failed") {
          return textError(
            logApifyFailure({
              service: SERVICE,
              actor: actorId,
              stage: "run",
              runId: run.run_id,
              message: `Reddit scrape run ${run.run_id} ended without items: ${run.status}`,
            }),
          );
        }

        // The run succeeded, so its results exist on Apify: if they cannot be
        // fetched within the budget, hand the run id back rather than lose them.
        const remainingMs = deadline - Date.now();
        if (remainingMs < MIN_FETCH_S * 1000) {
          console.warn({ event: "reddit_scrape_handed_off", run_id: run.run_id, reason: "budget" });
          return textError(fetchLaterMessage(run.run_id));
        }
        const items = await this.fetchItems(token, actorId, run.dataset_id, run.run_id, remainingMs);
        if (!items.ok) return textError(`${items.message}. ${fetchLaterMessage(run.run_id)}`);
        return {
          content: [
            { type: "text" as const, text: `Reddit scrape returned ${items.items.length} item(s)` },
          ],
          structuredContent: { count: items.items.length, items: items.items },
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

        const actorId = this.actorId();
        const res = await this.callApify(token, actorId, runsUrl(actorId, this.apifyBase()), {
          method: "POST",
          body: buildActorInput(args, actorId),
          // Short budget: this call only enqueues a run, it never waits on it.
          timeoutMs: 30_000,
        });
        if (!res.ok) return textError(res.message);

        const parsed = parseRunStart(res.json);
        if (!parsed.ok) return textError(this.badShape(actorId, parsed.error));

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
          "Poll an asynchronous Reddit scrape started by reddit_scrape_start (or handed back by " +
          "reddit_scrape). Returns the run status; items are empty while it is still running and " +
          "populated once it has SUCCEEDED. Poll again on a non-terminal status.",
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

        const actorId = this.actorId();

        // 1. Run-status GET - always fast.
        const res = await this.callApify(token, actorId, runStatusUrl(runId, this.apifyBase()), {
          method: "GET",
          timeoutMs: 30_000,
          runId,
        });
        if (!res.ok) return textError(res.message);
        const status = parseRunStatus(res.json);
        if (!status.ok) return textError(this.badShape(actorId, status.error, runId));

        // Non-terminal or terminal-failure: hand back the status with no items.
        // Split the two so the message states intent - a terminal failure means
        // stop polling, a non-terminal status means poll again.
        const outcome = runOutcome(status.status);
        if (outcome !== "succeeded") {
          const text =
            outcome === "failed"
              ? `Run ${runId} ended without items: ${status.status}`
              : `Run ${runId} status: ${status.status} - poll again`;
          // A terminal failure is an Apify failure even though the status GET
          // itself succeeded. Each poll of the same failed run logs again; the
          // run_id field lets a query count distinct runs.
          if (outcome === "failed") {
            logApifyFailure({ service: SERVICE, actor: actorId, stage: "run", runId, message: text });
          }
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { status: status.status, count: 0, items: [] },
          };
        }

        if (!status.dataset_id) {
          return textError(this.badShape(actorId, "Apify run SUCCEEDED but returned no defaultDatasetId", runId));
        }

        // 2. Dataset items GET.
        const items = await this.fetchItems(token, actorId, status.dataset_id, runId);
        if (!items.ok) return textError(items.message);
        return {
          content: [
            { type: "text" as const, text: `Run ${runId} SUCCEEDED with ${items.items.length} item(s)` },
          ],
          structuredContent: { status: SUCCEEDED, count: items.items.length, items: items.items },
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
      if (request.method === "POST") {
        const body = await readRequestBody(request, MAX_MCP_BODY_BYTES);
        if (body.tooLarge) return new Response(requestBodyTooLargeMessage(MAX_MCP_BODY_BYTES), { status: 413 });
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        request = new Request(request, { headers, body: body.text });
      }
      return RedditMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
