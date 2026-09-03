# `linkedin` - Edison first-party MCP server

Search and scrape public LinkedIn posts. One tool, `linkedin_scrape`: give it a
search query (the same query you would type in the LinkedIn search bar) or a
list of LinkedIn profile/company URLs whose posts to fetch, and it returns the
matched dataset items.

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** the [`harvestapi/linkedin-post-search`](https://apify.com/harvestapi/linkedin-post-search)
  Apify Actor via its synchronous `run-sync-get-dataset-items` endpoint (one
  blocking call, no polling). The Actor scrapes only public posts and needs no
  LinkedIn cookies or account. The Worker holds a single first-party Apify token
  (`APIFY_TOKEN`, a secret) - callers never supply Apify credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the design of the `reddit` connector: the standalone,
Edison-hosted marketplace connector wrapping a public web-scraping Actor.

## `linkedin_scrape` input

| field | type | notes |
|-------|------|-------|
| `search` | string | Search query. Blank/whitespace is treated as absent. |
| `start_urls` | string[] | LinkedIn profile/company URLs whose posts (and reposts) to scrape. Off-domain URLs are dropped. |
| `sort` | enum | relevance \| date (default date). |
| `posted_within` | enum | 1h \| 24h \| week \| month \| 3months \| 6months \| year. |
| `max_items` | int 1-1000 | Max posts per query (default 10). |

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

`compatibility_flags: ["nodejs_compat"]` and the `LinkedinMCP` Durable Object
hold the MCP session, backed by the Durable Object's own SQLite; no other
bindings. Production auth (`edison-jwt`) is configured in `wrangler.jsonc`
`vars`; `EDISON_JWT_AUDIENCE`
must equal this server's catalog id, `linkedin-scraper`.

## Runtime note

The synchronous Apify run is capped at `RUN_TIMEOUT_S` (120s) to fit a Worker
subrequest's budget. Small `max_items` queries return well within it; scale
`max_items` down rather than the timeout up for heavier scrapes. `maxPosts` is
always sent bounded (never `0`, which the Actor reads as "scrape everything").
