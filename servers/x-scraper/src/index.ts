/**
 * x - an Edison first-party MCP server for X (formerly Twitter).
 *
 * Three tools over the same Worker, each wrapping a public Apify Actor via its
 * synchronous `run-sync-get-dataset-items` endpoint (one blocking call, no
 * polling):
 *   - `x_scrape`   - tweets, via `kaitoeasyapi/twitter-x-data-tweet-scraper` (x.ts)
 *   - `x_profile`  - user profiles, via `apidojo/twitter-user-scraper` (profile.ts)
 *   - `x_engagers` - who engaged with a tweet (engagers.ts): replies + quotes via
 *     the same KaitoEasyAPI Actor, and (opt-in) retweeters via a second Actor,
 *     `scrape.badger/twitter-tweets-scraper`, the only one that lists reposters.
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
  DEFAULT_PROFILE_ACTOR_ID,
  MAX_PROFILE_TARGETS,
  buildProfileInput,
  hasProfileTarget,
  profileTargets,
  selectProfiles,
  uniqueTargetCount,
  type XProfileArgs,
} from "./profile";
import {
  APIFY_BASE,
  DEFAULT_ACTOR_ID,
  RUN_TIMEOUT_S,
  buildActorInput,
  hasTarget,
  invalidDateBound,
  runSyncUrl,
  stripFillerItems,
  validateDatasetItems,
  type XScrapeArgs,
} from "./x";
import {
  DEFAULT_RETWEETERS_ACTOR_ID,
  buildQuotesInput,
  buildRepliesInput,
  buildRetweetersInput,
  collectEngagerRuns,
  dedupeEngagers,
  enabledKinds,
  engagerFromBadgerUser,
  engagerFromKaitoTweet,
  engagerMaxItems,
  hasEnabledKind,
  resolveTweetId,
  stripRootTweet,
  type Engager,
  type EngagementKind,
  type XEngagersArgs,
} from "./engagers";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // Apify API token for the server's own account. SECRET - set with
  // `wrangler secret put APIFY_TOKEN`, never in wrangler.jsonc vars.
  APIFY_TOKEN?: string;
  // Optional overrides (public config).
  APIFY_ACTOR_ID?: string;
  APIFY_PROFILE_ACTOR_ID?: string;
  // Retweeters Actor for `x_engagers` (badger); replies/quotes reuse APIFY_ACTOR_ID.
  APIFY_RETWEETERS_ACTOR_ID?: string;
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
 * dataset. Shared by both tools; the caller has already checked APIFY_TOKEN.
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

export class XMCP extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({ name: "x", version: "0.1.0" });

  async init(): Promise<void> {
    this.registerScrapeTool();
    this.registerProfileTool();
    this.registerEngagersTool();
  }

  private registerScrapeTool(): void {
    this.server.registerTool(
      "x_scrape",
      {
        description:
          "Search and scrape X (formerly Twitter) TWEETS. Provide `search` (X advanced-search " +
          "operators like from:, to:, filter:, since:, until:, min_faves: are supported) and/or " +
          "`from_user` to restrict to one account's tweets. Returns the matched tweets.",
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
            .describe("Raw dataset items (tweets) from the Apify Actor run."),
        },
      },
      async (args: XScrapeArgs) => {
        // Validate the caller's request before touching server config, so a bad
        // call gets an actionable error regardless of deploy state.
        if (!hasTarget(args)) {
          return textError("provide either 'search' or a 'from_user' handle");
        }
        // Reject an unparseable date up front rather than silently dropping the
        // filter and running a paid scrape wider than the caller asked for.
        const badBound = invalidDateBound(args);
        if (badBound) {
          return textError(`invalid '${badBound}' date: use YYYY-MM-DD`);
        }
        if (!this.env.APIFY_TOKEN?.trim()) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const actorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildActorInput(args));
        if (!run.ok) return textError(run.message);

        // Drop KaitoEasyAPI billing-floor filler before it reaches the caller.
        const items = stripFillerItems(run.items);
        return {
          content: [{ type: "text" as const, text: `X scrape returned ${items.length} item(s)` }],
          structuredContent: { count: items.length, items },
        };
      },
    );
  }

  private registerProfileTool(): void {
    this.server.registerTool(
      "x_profile",
      {
        description:
          "Look up X (formerly Twitter) user PROFILES: bio, follower/following counts, verified " +
          "status, tweet count, join date and location. Provide `handles` and/or `profile_urls`. " +
          "Returns one profile object per requested account (suggested accounts are filtered out).",
        inputSchema: {
          handles: z
            .array(z.string().max(100))
            .max(MAX_PROFILE_TARGETS)
            .optional()
            .describe('X handles to look up (with or without a leading @), e.g. ["openai", "sama"].'),
          profile_urls: z
            .array(z.string().max(2048))
            .max(MAX_PROFILE_TARGETS)
            .optional()
            .describe('Full X profile URLs to look up, e.g. ["https://x.com/openai"].'),
          include_about: z
            .boolean()
            .optional()
            .describe("Include account metadata (join date, location, username-change history). Default: true."),
        },
        outputSchema: {
          count: z.number().describe("Number of profiles returned."),
          profiles: z
            .array(z.record(z.string(), z.any()))
            .describe("Matched X user/profile objects."),
        },
      },
      async (args: XProfileArgs) => {
        if (!hasProfileTarget(args)) {
          return textError("provide at least one 'handles' entry or 'profile_urls' entry");
        }
        // Every target must resolve to a handle we can match results against;
        // an input that only carries tweet/route/malformed URLs would otherwise
        // pay for a run whose output we can't attribute to a requested account.
        if (profileTargets(args).names.size === 0) {
          return textError("no resolvable X handle: pass a handle or a profile URL like https://x.com/<handle>");
        }
        // Combined cap across both target fields (the per-field schema limits
        // would otherwise allow twice this many, doubling the paid run).
        if (uniqueTargetCount(args) > MAX_PROFILE_TARGETS) {
          return textError(`too many targets: at most ${MAX_PROFILE_TARGETS} accounts per call`);
        }
        if (!this.env.APIFY_TOKEN?.trim()) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const actorId = this.env.APIFY_PROFILE_ACTOR_ID?.trim() || DEFAULT_PROFILE_ACTOR_ID;
        const run = await runActor(this.env, actorId, buildProfileInput(args));
        if (!run.ok) return textError(run.message);

        // The Actor pads runs with "who to follow" suggestions; keep only the
        // profiles that were actually requested.
        const profiles = selectProfiles(run.items, args);
        return {
          content: [{ type: "text" as const, text: `X profile lookup returned ${profiles.length} profile(s)` }],
          structuredContent: { count: profiles.length, profiles },
        };
      },
    );
  }

  private registerEngagersTool(): void {
    this.server.registerTool(
      "x_engagers",
      {
        description:
          "List the accounts that ENGAGED with one X (formerly Twitter) tweet, as profile records " +
          "(handle, name, followers, verified, can_dm). Provide `tweet_id` or `tweet_url`. Replies " +
          "and quotes are returned by default; set `include_retweeters` to also list who reposted it " +
          "(a second, extra-cost Actor run - off by default). Likers are not available: X removed the " +
          "public who-liked list, so no source can return them.",
        inputSchema: {
          tweet_id: z
            .string()
            .optional()
            .describe("Numeric tweet id, e.g. '1934468786985501089'. Provide this or `tweet_url`."),
          tweet_url: z
            .string()
            .max(2048)
            .optional()
            .describe("Full tweet URL, e.g. 'https://x.com/user/status/1934468786985501089'."),
          include_replies: z
            .boolean()
            .optional()
            .describe("Include accounts that replied to the tweet (default: true)."),
          include_quotes: z
            .boolean()
            .optional()
            .describe("Include accounts that quote-tweeted the tweet (default: true)."),
          include_retweeters: z
            .boolean()
            .optional()
            .describe("Include accounts that retweeted the tweet. Extra paid Actor run (default: false)."),
          max_items: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Approximate max accounts per engagement kind (default: 50); each kind is a separate run."),
        },
        outputSchema: {
          count: z.number().describe("Number of unique engagers returned."),
          engagers: z
            .array(z.record(z.string(), z.any()))
            .describe("Deduped engager profiles; each carries `engaged_via` naming its engagement kind(s)."),
          errors: z
            .array(z.object({ kind: z.string(), message: z.string() }))
            .describe("Per-kind Actor failures, when a partial result was still returned."),
        },
      },
      async (args: XEngagersArgs) => {
        const tweetId = resolveTweetId(args);
        if (!tweetId) {
          return textError("provide a 'tweet_id' or a 'tweet_url' (an x.com/<user>/status/<id> link)");
        }
        if (!hasEnabledKind(args)) {
          return textError("enable at least one of include_replies, include_quotes, include_retweeters");
        }
        if (!this.env.APIFY_TOKEN?.trim()) {
          return textError("server misconfigured: APIFY_TOKEN not set");
        }

        const kinds = enabledKinds(args);
        const maxItems = engagerMaxItems(args);
        const tweetActorId = this.env.APIFY_ACTOR_ID?.trim() || DEFAULT_ACTOR_ID;
        const retweetersActorId = this.env.APIFY_RETWEETERS_ACTOR_ID?.trim() || DEFAULT_RETWEETERS_ACTOR_ID;

        // One job per enabled kind: its Actor + input, and how to turn that
        // Actor's raw items into engagers. Kept in replies->quotes->retweeters
        // order so dedupeEngagers' first-seen wins stay deterministic.
        type Job = {
          kind: EngagementKind;
          actorId: string;
          input: Record<string, unknown>;
          extract: (items: Record<string, unknown>[]) => Engager[];
        };
        const jobs: Job[] = [];
        if (kinds.replies) {
          jobs.push({
            kind: "reply",
            actorId: tweetActorId,
            input: buildRepliesInput(tweetId, maxItems),
            extract: (items) =>
              stripRootTweet(stripFillerItems(items), tweetId).flatMap((it) => engagerFromKaitoTweet(it, "reply") ?? []),
          });
        }
        if (kinds.quotes) {
          jobs.push({
            kind: "quote",
            actorId: tweetActorId,
            input: buildQuotesInput(tweetId, maxItems),
            extract: (items) => stripFillerItems(items).flatMap((it) => engagerFromKaitoTweet(it, "quote") ?? []),
          });
        }
        if (kinds.retweeters) {
          jobs.push({
            kind: "retweet",
            actorId: retweetersActorId,
            input: buildRetweetersInput(tweetId, maxItems),
            extract: (items) => items.flatMap((it) => engagerFromBadgerUser(it) ?? []),
          });
        }

        // The runs are independent, so fetch them concurrently rather than
        // stacking each Actor's wall-clock against the Worker subrequest budget.
        const runs = await Promise.all(jobs.map((j) => runActor(this.env, j.actorId, j.input)));
        const { collected, errors } = collectEngagerRuns(
          jobs.map((j, i) => ({ kind: j.kind, extract: j.extract, run: runs[i] })),
        );

        // Only a total wipeout (every enabled kind's Actor run failed) is a hard
        // error; otherwise return what came back and surface partial failures.
        if (jobs.length > 0 && errors.length === jobs.length) {
          return textError(errors.map((e) => `${e.kind}: ${e.message}`).join("; "));
        }

        const engagers = dedupeEngagers(collected);
        return {
          content: [{ type: "text" as const, text: `X engagers returned ${engagers.length} unique account(s)` }],
          structuredContent: { count: engagers.length, engagers, errors },
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
