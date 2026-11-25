# `youtube` - Edison first-party MCP server

Scrape YouTube search results and video comments. One tool, `youtube_scrape`:
give it a search term (with optional sort/recency filters) or a list of YouTube
URLs, and it returns the matched videos and, when asked, comments on those
videos.

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** two Apify Actors chained via their synchronous
  `run-sync-get-dataset-items` endpoint (one blocking call each, no polling) -
  [`streamers/youtube-scraper`](https://apify.com/streamers/youtube-scraper) for
  search/videos, then
  [`streamers/youtube-comments-scraper`](https://apify.com/streamers/youtube-comments-scraper)
  for comments (only when `max_comments > 0`). The Worker holds a single
  first-party Apify token (`APIFY_TOKEN`, a secret) - callers never supply Apify
  credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

Why two Actors: YouTube's Apify ecosystem splits search and comments across
separate Actors, so the connector runs search first, resolves each returned
video to a canonical `watch?v=<id>` URL, then scrapes comments on those URLs.

## `youtube_scrape` input

| field | type | notes |
|-------|------|-------|
| `search` | string | Search term. Blank/whitespace is treated as absent. |
| `start_urls` | string[] (max 50) | Explicit YouTube video/channel/playlist/search URLs. Each must be a well-formed http(s) URL on a YouTube host (`youtube.com`, `youtu.be`, `youtube-nocookie.com`, or a subdomain); blank, non-YouTube, or credential-bearing entries are dropped. |
| `sort` | enum | relevance \| rating \| date \| views (default relevance). |
| `date_filter` | enum | hour \| today \| week \| month \| year (search only). |
| `max_results` | int 1-1000 | Max videos returned (default 10). |
| `max_comments` | int 0-1000 | Comments **per video**; 0 skips comment scraping (default 0). |
| `comment_sort` | enum | top \| new (default top). |

At least one of `search` or a valid `start_urls` entry is required; providing
both is rejected (start URLs would otherwise mask the search). Output is
`{ video_count, comment_count, videos, comments }`.

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

`compatibility_flags: ["nodejs_compat"]` and the `YoutubeMCP` Durable Object
hold the MCP session; no other bindings (no storage). Production auth
(`edison-jwt`) is configured in `wrangler.jsonc` `vars`; `EDISON_JWT_AUDIENCE`
must equal this server's catalog id, `youtube`.

## Runtime note

Each synchronous Apify run is capped at `RUN_TIMEOUT_S` (120s, lower than the
300s a long-lived process could use, to fit a Worker subrequest's budget), and
a comments request chains two runs. Small `max_results` / `max_comments` queries
return well within it; scale those down rather than the timeout up for heavier
scrapes.
