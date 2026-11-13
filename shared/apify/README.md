# `shared/apify` - Apify call failures

Every Apify-backed fleet server (`reddit`, `youtube`, `x-scraper`,
`linkedin-scraper`) returns a failed Actor call to the MCP caller as an
`isError` result, which Workers Logs never records. [`ts/log.ts`](./ts/log.ts)
logs each failure once, at error level, as a structured `apify_call_failed`
event:

| Field | Meaning |
|-------|---------|
| `service` | Fleet server id (`reddit`, `youtube`, `x`, `linkedin`) |
| `actor` | Apify Actor id the call ran |
| `stage` | `network`, `http`, `json`, `dataset` or `run` |
| `status` | HTTP status, for `http` |
| `apify_error_type` | Apify's `error.type`, e.g. `user-or-token-not-found` for a revoked token |
| `run_id` | The run, when the failure is about one |
| `message` | The error the caller received (truncated to 500 chars) |

The token and request bodies are never logged. To find an outage, group
`$metadata.level = error` events by `$metadata.service` and `apify_error_type`
in Cloudflare Workers observability.

Servers import it through a local re-export (`src/apify_log.ts`), the same way
they consume [`../auth`](../auth).
