# `linkedin` - Edison first-party MCP server

Search and scrape public LinkedIn data. Three tools over one Worker, each
wrapping a public HarvestAPI Apify Actor (no LinkedIn cookies or account):

| tool | scrapes | backing Actor |
|------|---------|---------------|
| `linkedin_scrape` | posts (by keyword or profile/company URL) | [`harvestapi/linkedin-post-search`](https://apify.com/harvestapi/linkedin-post-search) |
| `linkedin_profile_search` | people (by query + structured filters) | [`harvestapi/linkedin-profile-search`](https://apify.com/harvestapi/linkedin-profile-search) |
| `linkedin_company` | company pages (headcount, industry, activity) | [`harvestapi/linkedin-company`](https://apify.com/harvestapi/linkedin-company) |

- **Runtime:** TypeScript on a Cloudflare Worker (`McpAgent` / Durable Object).
- **Transport:** streamable HTTP at `/mcp`.
- **Backing:** each Actor is called via its synchronous
  `run-sync-get-dataset-items` endpoint (one blocking call, no polling) and
  scrapes only public data. The Worker holds a single first-party Apify token
  (`APIFY_TOKEN`, a secret) - callers never supply Apify credentials.
- **Auth:** the fleet auth contract (`open` | `bearer` | `edison-jwt`, see
  `src/auth.ts`); production runs `edison-jwt`.

This mirrors the design of the `reddit` connector: the standalone,
Edison-hosted marketplace connector wrapping public web-scraping Actors.

## `linkedin_scrape` input (posts)

| field | type | notes |
|-------|------|-------|
| `search` | string | Search query. Blank/whitespace is treated as absent. |
| `start_urls` | string[] | LinkedIn profile/company URLs whose posts (and reposts) to scrape. Off-domain URLs are dropped. |
| `sort` | enum | relevance \| date (default date). |
| `posted_within` | enum | 1h \| 24h \| week \| month \| 3months \| 6months \| year. |
| `max_items` | int 1-1000 | Max posts per query (default 10). |

At least one of `search` or a valid `start_urls` entry is required.

## `linkedin_profile_search` input (people)

| field | type | notes |
|-------|------|-------|
| `search` | string | Fuzzy query, e.g. `head of growth fintech london`. |
| `mode` | enum | `Short` summary (default) or `Full` rich profile. The Actor's third mode, "Full + email search", is deliberately not exposed. |
| `max_items` | int 1-100 | Max profiles (default 10); over-cap values are clamped. |
| `locations` | string[] | Location filter. |
| `current_companies` / `past_companies` | string[] | Company filters. |
| `schools` | string[] | School/university filter. |
| `current_job_titles` / `past_job_titles` | string[] | Job-title filters. |
| `first_names` / `last_names` | string[] | Name filters. |
| `recently_changed_jobs` / `recently_posted` | bool | Refinements; cannot be the only target. |

At least a `search` query or one filter list is required (a lone boolean
refinement is rejected, since it would ask the Actor to scrape the whole
network). The Actor's opaque `*-Id` filters (industry, seniority, function...)
and its MongoDB/segmentation knobs are intentionally not exposed.

## `linkedin_company` input (companies)

| field | type | notes |
|-------|------|-------|
| `company_urls` | string[] | LinkedIn company URLs. Off-domain URLs are dropped. |
| `names` | string[] | Company names to search. |

At least one valid company URL or name is required; at most
`MAX_COMPANY_TARGETS` (50) companies (URLs + names) per call.

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
