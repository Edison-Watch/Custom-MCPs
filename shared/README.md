# `shared/` — cross-fleet contracts

Code and schemas shared across every server in [`../servers/`](../servers),
regardless of runtime (TypeScript on Workers or Python/FastMCP). Three pieces:

| Dir | Purpose | Status |
|-----|---------|--------|
| [`auth/`](./auth) | Pluggable auth: `open` \| `bearer` \| `edison-jwt` (JWT verify via Edison JWKS). TS + Python ports. | contract defined; `bearer` lives in `servers/image-host/src/auth.ts` today |
| [`catalog/`](./catalog) | How a server advertises itself to the Edison marketplace (entry schema + generator). | placeholder |
| [`ui/`](./ui) | React MCP-UI component library consumed by both runtimes. | placeholder |

These are intentionally thin: a server is otherwise fully self-contained. As a
second server lands, the reusable `auth` verify layer and the `catalog`
generator get promoted here out of `servers/image-host/`.

See [`../docs/mcp_commodity_fleet_strategy.md`](../docs/mcp_commodity_fleet_strategy.md)
(§5 MCP-UI, §6 Auth, §7 Edison integration) and the Edison-side spec
`edison-watch/dev-docs/architecture/first_party_mcp_integration.md`.
