# `reddit` - Edison first-party MCP server

Search and scrape Reddit posts, comments, communities, and users. One tool,
`reddit_scrape`: give it a search term (optionally scoped to a subreddit) or a
list of Reddit URLs, and it returns the matched dataset items.

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** the [`trudax/reddit-scraper-lite`](https://apify.com/trudax/reddit-scraper-lite)
  Apify Actor via its synchronous `run-sync-get-dataset-items` endpoint (one
  blocking call, no polling). The Worker holds a single first-party Apify token
  (`APIFY_TOKEN`, a secret) - callers never supply Apify credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the Python `reddit_scrape` service at the repo root
(`services/reddit_svc.py`), which exposes the same Actor over the CLI/HTTP/stdio
transports. This server is the standalone, Edison-hosted marketplace connector.

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

At least one of `search` or `start_urls` is required.

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
