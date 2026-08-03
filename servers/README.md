# `servers/` - the first-party MCP fleet

Each subdirectory is one small, utilitarian, **streamable-HTTP MCP server** that
Edison hosts as a first-party, open-source connector. Servers deploy
independently and are polyglot by design:

- **TypeScript on Cloudflare Workers** is the default runtime for new commodity
  servers (edge, scales to zero, R2/KV/D1 bindings for state).
- **Python / FastMCP** stays first-class for heavy-dependency servers and the
  existing Gmail app at the repo root.

Two contracts keep the fleet coherent regardless of language:

1. **Auth contract** - every server speaks the same pluggable auth modes
   (`open` | `bearer` | `edison-jwt`). v1 servers ship `bearer`; `edison-jwt`
   (Edison mints a per-user JWT and injects it, no consent screen) is a drop-in.
2. **Catalog contract** - every server advertises itself to the Edison
   marketplace the same way (see `../shared/catalog`).

See [`../docs/mcp_commodity_fleet_strategy.md`](../docs/mcp_commodity_fleet_strategy.md)
for the full strategy and [`../shared/`](../shared) for the shared pieces.

## Servers

| Server | Runtime | Status | Auth (v1) |
|--------|---------|--------|-----------|
| [`image-host/`](./image-host) | TS · Cloudflare Worker + R2 | built + tested (unit + workerd integration) | `bearer` |
