# `x` - Edison first-party MCP server

Search and scrape X (formerly Twitter) tweets, profiles, searches, and lists.
One tool, `x_scrape`: give it a search term (X advanced-search syntax is
supported) or a list of X/Twitter URLs, and it returns the matched dataset
items.

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** the [`apidojo/tweet-scraper`](https://apify.com/apidojo/tweet-scraper)
  Apify Actor via its synchronous `run-sync-get-dataset-items` endpoint (one
  blocking call, no polling). The Worker holds a single first-party Apify token
  (`APIFY_TOKEN`, a secret) - callers never supply Apify credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the design of the `reddit` connector: the standalone,
Edison-hosted marketplace connector wrapping a public web-scraping Actor.

## `x_scrape` input

| field | type | notes |
|-------|------|-------|
| `search` | string | Search term. X advanced-search operators allowed. Blank/whitespace is treated as absent. |
| `start_urls` | string[] | Explicit X/Twitter tweet/profile/search/list URLs to scrape instead of a search. Off-domain URLs are dropped. |
| `sort` | enum | Top \| Latest \| Latest + Top (default Latest). |
| `since` | string | Only tweets on/after this date, e.g. `2024-01-01` (search only). |
| `until` | string | Only tweets on/before this date, e.g. `2024-12-31` (search only). |
| `max_items` | int 1-1000 | Max dataset items (default 10). |
| `only_verified` | bool | Only tweets by verified users (default false). |

At least one of `search` or a valid `start_urls` entry is required.

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

`compatibility_flags: ["nodejs_compat"]` and the `XMCP` Durable Object hold the
MCP session; no other bindings (no storage). Production auth (`edison-jwt`) is
configured in `wrangler.jsonc` `vars`; `EDISON_JWT_AUDIENCE` must equal this
server's catalog id, `x-scraper`.

## Runtime note

The synchronous Apify run is capped at `RUN_TIMEOUT_S` (120s) to fit a Worker
subrequest's budget. Small `max_items` queries return well within it; scale
`max_items` down rather than the timeout up for heavier scrapes.
