# `shared/ui` - MCP-UI component library

A React component library for MCP-UI / MCP Apps, consumed by **both** runtimes:
TypeScript servers via the official `ext-apps` SDK, and Python/FastMCP servers
via FastMCP v3's app support. The server language differs; the UI does not.

```
  ext-apps (TS worker)  ---+                         +--- FastMCP v3 (Py container)
                           |                         |
                           +---->   shared/ui   <----+
                                (React MCP-UI lib)
                    one look & feel, two thin server-side adapters
```

The UI is always sandboxed web tech (React/HTML in an iframe) regardless of
server language - only the thin registration + the app↔server `postMessage`
bridge is runtime-specific.

## Status

Placeholder - no server ships UI yet. `image-host` is deliberately headless
(it returns a URL, needing no dashboard). The library gets populated when the
first server needs an interactive surface. See
[`../../docs/mcp_commodity_fleet_strategy.md`](../../docs/mcp_commodity_fleet_strategy.md) §5
and the repo's existing `mcp_server/MCP_UI_ARCHITECTURE.md`.
