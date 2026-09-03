# `x-scraper` - Edison first-party MCP server

Search and scrape X (formerly Twitter). Two tools:

- **`x_scrape`** - tweets: give it a search query (X advanced-search operators
  like `from:`, `filter:media`, `since:` are supported) and/or a `from_user`
  handle, and it returns the matched tweets.
- **`x_profile`** - user profiles: give it handles or profile URLs and it returns
  each account's profile object (bio, follower/following counts, verified status,
  tweet count, join date, location).

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** two public Apify Actors via their synchronous
  `run-sync-get-dataset-items` endpoint (one blocking call, no polling) -
  [`kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest)
  for tweets and [`apidojo/twitter-user-scraper`](https://apify.com/apidojo/twitter-user-scraper)
  for profiles. The Worker holds a single first-party Apify token (`APIFY_TOKEN`,
  a secret) - callers never supply Apify credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the design of the `reddit` connector: the standalone,
Edison-hosted marketplace connector wrapping a public web-scraping Actor.

## `x_scrape` input

| field | type | notes |
|-------|------|-------|
| `search` | string | Search query. X advanced-search operators (`from:`, `to:`, `filter:media`, etc.) allowed. Blank/whitespace is treated as absent. |
| `from_user` | string | Restrict to tweets from one handle (with or without a leading `@`). |
| `sort` | enum | Latest \| Top \| Photos \| Videos (default Latest). |
| `since` | string | Only tweets on/after this date, e.g. `2024-01-01`. |
| `until` | string | Only tweets on/before this date, e.g. `2024-12-31`. |
| `max_items` | int 1-1000 | Approximate max tweets (default 10); the Actor pages in batches so it may return a few more. |
| `only_verified` | bool | Only tweets by Twitter Blue (verified) accounts (default false). |

At least one of `search` or `from_user` is required. Date bounds (`since`/`until`)
apply on their own (`from_user` with no `search`) as well as combined with a query.

`search` also accepts the full X advanced-search grammar, so composite queries work
without any extra params, e.g. `(AI OR LLM) from:sama min_faves:200 filter:media`.

**Filler stripping:** the backing Actor has a per-call billing floor and pads runs
that match few/no tweets with `{ "type": "mock_tweet", "id": -1, ... }` placeholder
items. The Worker drops these before returning, so callers only ever see real
tweets (an all-filler run comes back as `count: 0`).

## `x_profile` input

| field | type | notes |
|-------|------|-------|
| `handles` | string[] | X handles to look up (with or without a leading `@`), e.g. `["openai", "sama"]`. |
| `profile_urls` | string[] | Full X profile URLs, e.g. `["https://x.com/openai"]`. Tweet permalinks and `/i/…` routes are ignored for filtering. |
| `include_about` | bool | Include account metadata (join date, location, username-change history). Default `true`. |

At least one `handles` or `profile_urls` entry is required.

**Suggestion filtering:** the `apidojo` Actor returns the requested profiles first
and then pads the run with "who to follow" suggestions, and at a tight item cap its
ordering is unstable (asking for `sama` at `maxItems: 1` can return `paulg`). The
Worker over-fetches by a fixed buffer and then filters the dataset back down to
exactly the requested accounts, so callers only ever see profiles they asked for.
Follower/following *lists* (the Actor's expensive per-query events) are not exposed.

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
MCP session, backed by the Durable Object's own SQLite; no other bindings.
Production auth (`edison-jwt`) is
configured in `wrangler.jsonc` `vars`; `EDISON_JWT_AUDIENCE` must equal this
server's catalog id, `x-scraper`.

## Runtime note

The synchronous Apify run is capped at `RUN_TIMEOUT_S` (120s) to fit a Worker
subrequest's budget. Small `max_items` queries return well within it; scale
`max_items` down rather than the timeout up for heavier scrapes.
