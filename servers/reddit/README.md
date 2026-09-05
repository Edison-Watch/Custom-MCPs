# `reddit` - Edison first-party MCP server

Search and scrape Reddit posts, comments, communities, and users. Three tools:
`reddit_scrape` (fast, synchronous) plus the `reddit_scrape_start` /
`reddit_scrape_fetch` pair for slow queries that would outlast a synchronous
call. Give any of them a search term (optionally scoped to a subreddit) or a
list of Reddit URLs, and they return the matched items in a stable, normalized
shape.

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** the [`trudax/reddit-scraper-lite`](https://apify.com/trudax/reddit-scraper-lite)
  Apify Actor. `reddit_scrape` uses the synchronous `run-sync-get-dataset-items`
  endpoint (one blocking call); the async pair enqueues a run and polls it. The
  Worker holds a single first-party Apify token (`APIFY_TOKEN`, a secret) -
  callers never supply Apify credentials. The Actor is swappable via
  `APIFY_ACTOR_ID`; every Actor's items are mapped onto the same normalized
  output, so callers never depend on a specific Actor's field names.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the Python `reddit_scrape` / `reddit_scrape_start` /
`reddit_scrape_fetch` services at the repo root (`services/reddit_svc.py`), which
expose the same Actor over the CLI/HTTP/stdio transports. This server is the
standalone, Edison-hosted marketplace connector.

## `reddit_scrape` input

| field | type | notes |
|-------|------|-------|
| `search` | string | Search term. Blank/whitespace is treated as absent. |
| `subreddit` | string | Restrict a search to one community (ignored without `search`). |
| `start_urls` | string[] | Explicit Reddit URLs to scrape instead of a search. |
| `sort` | enum | relevance \| hot \| top \| new \| rising \| comments (default new). |
| `time_filter` | enum | all \| hour \| day \| week \| month \| year (posts only). |
| `max_items` | int 1-1000 | Max dataset items (default 10). |
| `include_comments` | bool | Also scrape comments on matched posts (default false). |
| `include_nsfw` | bool | Include NSFW results (default false). |
| `include_media_links` | bool | Extract engagement fields + media URLs (default false). Off = fast RSS mode (no engagement); on = slower detailed scrape. |

At least one of `search` or `start_urls` is required.

## `reddit_scrape` output

`{ count, items }`. Each item is normalized onto a stable, actor-agnostic shape
(snake_case) so callers never depend on the backing Actor's raw field names. The
untouched Actor item is preserved under `raw`.

| field | type | notes |
|-------|------|-------|
| `id` | string \| null | Actor item id. |
| `type` | enum \| null | post \| comment \| community \| user. |
| `title` | string \| null | Post title. |
| `body` | string \| null | Post selftext or comment body. |
| `author` | string \| null | Author username. |
| `subreddit` | string \| null | Community name (`r/` prefix stripped). |
| `url` | string \| null | Canonical item URL. |
| `permalink` | string \| null | Reddit permalink path, when derivable. |
| `created_at` | string \| null | ISO8601 timestamp. |
| `score` | number \| null | Net upvotes. |
| `num_comments` | number \| null | Comment count. |
| `upvote_ratio` | number \| null | Upvote ratio 0..1. |
| `over_18` | bool \| null | NSFW flag. |
| `num_crossposts` | number \| null | Crosspost count. |
| `raw` | object | The untouched Actor dataset item. |

Engagement fields (`score`, `num_comments`, `upvote_ratio`, `num_crossposts`)
are `null` when the Actor does not provide them, never faked as `0`.
`trudax/reddit-scraper-lite` omits them in its default fast RSS mode; set
`include_media_links: true` to switch it to a detailed scrape that returns
them, and they flow through the same normalized schema. (Pointing
`APIFY_ACTOR_ID` at the flat-rate `trudax/reddit-scraper` sibling also returns
them, but that Actor bills a monthly rental; `include_media_links` gets the same
data on the pay-per-use lite Actor.)

## Async run + poll (`reddit_scrape_start` / `reddit_scrape_fetch`)

The synchronous `reddit_scrape` blocks one call on the whole run, which the
innermost MCP client can cut off before a slow keyword search finishes. The
async pair decouples start from poll:

- **`reddit_scrape_start`** takes the same input as `reddit_scrape`, enqueues a
  non-blocking Apify run, and returns immediately with
  `{ run_id, dataset_id, status }` (the initial `status`, e.g. `READY`, is not
  yet terminal).
- **`reddit_scrape_fetch`** takes `{ run_id }` (an opaque id matching
  `^[A-Za-z0-9_-]+$`) and returns `{ status, count, items }`. While the run is
  non-terminal (`READY`/`RUNNING`/`*ING`) `items` is empty and the caller polls
  again; once `SUCCEEDED` it holds the normalized dataset; on a terminal failure
  (`FAILED`/`TIMED-OUT`/`ABORTED`) `status` comes back with empty `items` so the
  caller stops polling.

Items from all three tools are normalized onto the identical shape above.

## Develop

```bash
bun install
cp .dev.vars.example .dev.vars   # set APIFY_TOKEN + AUTH_TOKEN
bun run dev                      # wrangler dev on http://localhost:8787
bun run test                     # offline unit tier (pure logic + auth + jwt)
bun run typecheck
bun run test:integration         # workerd: routing + auth gate + misconfig guard
```

## Deploy

```bash
wrangler deploy
wrangler secret put APIFY_TOKEN  # the server's Apify account token
# AUTH_TOKEN only needed as a rollback path to bearer mode
```

`compatibility_flags: ["nodejs_compat"]` and the `RedditMCP` Durable Object hold
the MCP session; no other bindings (no storage). Production auth (`edison-jwt`)
is configured in `wrangler.jsonc` `vars`; `EDISON_JWT_AUDIENCE` must equal this
server's catalog id, `reddit`.

## Runtime note

The synchronous Apify run is capped at `RUN_TIMEOUT_S` (120s, lower than the
Python service's 300s to fit a Worker subrequest's budget). Small `max_items`
queries return well within it; scale `max_items` down rather than the timeout up
for heavier scrapes.
