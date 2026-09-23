# `servers/` - the first-party MCP fleet

Each subdirectory is one small, utilitarian MCP server, advertised to the Edison
marketplace via the catalog contract (`../shared/catalog`). Most are
**streamable-HTTP servers** Edison hosts; a few are **stdio servers** the
SealGate daemon spawns on the user's machine. Servers deploy independently and
are polyglot by design:

- **TypeScript on Cloudflare Workers** is the default runtime for new commodity
  HTTP servers (edge, scales to zero, R2/KV/D1 bindings for state).
- **Python / FastMCP** stays first-class for heavy-dependency servers and the
  existing Gmail app at the repo root.
- **stdio servers** (`transport: "stdio"` in the catalog entry) are local
  processes - a published npm/PyPI package run via `npx`/`uvx` - for connectors
  that must run client-side (wrapping a local CLI or device, e.g. `adb`). They
  are not hosted by Edison. Add one with the `add-stdio-connector` skill
  (`make new-stdio-connector id=<id>`); worked example: [`adb/`](./adb).

Two contracts keep the fleet coherent regardless of language:

1. **Auth contract** - every server speaks the same pluggable auth modes
   (`open` | `bearer` | `edison-jwt`). v1 servers ship `bearer`; `edison-jwt`
   (Edison mints a per-user JWT and injects it, no consent screen) is a drop-in.
2. **Catalog contract** - every server advertises itself to the Edison
   marketplace the same way (see `../shared/catalog`).

See [`../docs/mcp_commodity_fleet_strategy.md`](../docs/mcp_commodity_fleet_strategy.md)
for the full strategy and [`../shared/`](../shared) for the shared pieces. Generated
OpenAPI→MCP connectors also land here as fleet servers - design in
[`../docs/openapi_connector_generator.md`](../docs/openapi_connector_generator.md).

## Servers

| Server | Runtime | Status | Auth (v1) |
|--------|---------|--------|-----------|
| [`image-host/`](./image-host) | TS · Cloudflare Worker + R2 | built + tested (unit + workerd integration) | `bearer` |
| [`reddit/`](./reddit) | TS · Cloudflare Worker (Apify-backed) | built + tested (unit + workerd integration) | `edison-jwt` |
| [`adb/`](./adb) | TS · stdio (npx `@sealgate/android-adb-mcp`) | built + tested (unit) | `none` |
