---
name: add-stdio-connector
description: Add a new stdio (local-process) MCP server to the Edison marketplace - a package the SealGate daemon spawns on the user's machine (e.g. an npx wrapper around a local CLI like adb), as opposed to a hosted HTTP connector. Scaffold servers/<id>/, write the package, classify each tool, publish, and validate. Use when adding a connector that must run client-side.
---

# Adding a stdio MCP connector

A stdio connector is an MCP server the **SealGate daemon spawns on the user's
machine** and talks to over stdio, instead of a remote HTTP endpoint Edison
hosts. Use it when the server must run client-side - wrapping a local CLI or
device bridge (e.g. `adb`), reading local files, or driving a local app - so
there is nothing to host and no `url`. Worked example: `servers/android-adb`.

This differs from an HTTP fleet connector (`add-fleet-connector`) in three ways:

| | HTTP connector | stdio connector |
|---|---|---|
| Runtime | Cloudflare Worker / FastMCP, Edison-hosted | local process on the user's machine |
| Catalog | `url: https://…/mcp` | `transport: "stdio"`, `command` + `args`, no `url` |
| Distribution | `wrangler deploy` | published to a public registry (npm/PyPI), run via `npx`/`uvx` |

`edison_hosted` is never set for stdio (Edison does not run it), and `auth` is
`none` or `token` only (a local process has no remote issuer for oauth/edison-jwt).
Full contract: `shared/catalog/README.md`; schema: `shared/catalog/schema.json`.

## 1. Scaffold

```bash
make new-stdio-connector id=<id>     # id: lowercase letters, digits, hyphens
```

Writes `servers/<id>/catalog-entry.json` (a stdio skeleton with TODOs, no
`tools_configurations` yet) and a placeholder `servers/<id>/<id>.svg`.

## 2. Write the server package

The scaffold covers the **catalog entry only**. Write the actual MCP server as a
small, publishable package co-located in `servers/<id>/`, mirroring
`servers/android-adb` (TypeScript, `@modelcontextprotocol/sdk` over
`StdioServerTransport`, built with `tsc`, unit-tested with `vitest`):

- `package.json` - published name `@sealgate/<id>-mcp`, a `bin` pointing at
  `dist/index.js`, `publishConfig.access: public`, and a `prepublishOnly` build.
  It is a real npm package, **not** `private` and **not** a Worker: no
  `wrangler.jsonc`, no `shared/auth` re-exports (those are HTTP-server auth).
- `src/` - put the pure parsing/decision logic in its own module so it is
  unit-testable without the external process, and keep the process/`spawn`
  wrappers thin (see `servers/android-adb/src/adb.ts`).
- `test/` - unit-test the pure logic; it must pass with no device/CLI present.

**Validate and bound tool inputs.** Anything a tool shells out to a local
binary must be argv-separated (never string-interpolated into a shell) and
argument-validated - allow-list package names, reject shell metacharacters. A
tool that runs an arbitrary local command is a real capability; classify it
`SECRET` (below), do not try to sandbox it here - SealGate governs it.

## 3. Fill in the entry

Edit `servers/<id>/catalog-entry.json`:

- `displayName`, `description`, `category`, `tags` - human-facing catalog copy.
- `command` + `args` - how the daemon launches it, e.g. `"npx"` +
  `["-y", "@sealgate/<id>-mcp"]` (or `"uvx"` + `["<pkg>"]` for Python). The
  command must resolve on the user's PATH.
- `env` (optional) - extra environment for the process; `{PLACEHOLDER}` values
  resolve from `template_fields.env` at install (only needed with `auth: token`).
- `auth` - `none` (most local tools) or `token` (needs an install-time secret;
  then also add `headers`-free `template_fields`).
- Replace `<id>.svg` with the real brand mark (viewBox `0 0 24 24`; see
  `.claude/rules/agent-icons.md`).

## 4. Classify every tool (`tools_configurations`)

Required and non-empty for **every** stdio connector: a marketplace install
skips autoconfig auto-labeling, so a tool with no classification mounts at the
protective default (write + read_private + read_untrusted + `SECRET`) and trips
the lethal-trifecta guard on its first call. `make catalog_check` fails until
every tool is classified. Key each entry by the tool's **native name**.

| Field | True when the tool... |
|-------|-----------------------|
| `write_operation` | modifies external state (writes a file, installs, taps, sends) |
| `read_private_data` | reads private/sensitive data off the device or machine |
| `read_untrusted_public_data` | surfaces untrusted external content (on-screen web/app content, fetched pages, logs) |
| `acl` | `PUBLIC` / `PRIVATE` / `SECRET` - sensitivity of the data it handles |

A raw "run any command" tool (arbitrary shell/adb/exec) is `write_operation:
true`, all read legs true, `acl: SECRET`. Classify each tool for what *it* does;
do not pad flags "to be safe" - an over-broad classification blocks a legitimate
connector. See `servers/android-adb/catalog-entry.json` for a worked set.

## 5. Publish the package

The catalog `command`/`args` only resolve once the package is on the registry.
Publish `@sealgate/<id>-mcp` (`npm publish`, public) and pin a version if you do
not want `@latest`. Until it is published, the marketplace row installs but the
daemon cannot spawn it.

## 6. Validate

```bash
make catalog_check                       # schema + mandatory classification
cd servers/<id> && bun run typecheck && bun run test && bun run build
make ci                                  # full gate before committing
```

## 7. Wire into CI

Add `<id>` to the `test-stdio` job's `server:` matrix in
`.github/workflows/servers_ts.yaml` (the Worker `test` matrix above it runs a
workerd integration step a stdio package does not have - use the stdio job).

## 8. Downstream mirror (edison-watch)

This repo is the source of truth. edison-watch's Fleet Catalog Sync mirrors
`catalog-entry.json` into its marketplace one-way (a stdio entry becomes a
`transport_type: stdio_tunnel` row with `command`/`args`); a scheduled/dispatch
workflow opens the update PR. Never hand-edit the edison-watch side - the next
sync reverts it. When both a fleet change and its edison-watch mirror are open as
PRs, **merge this repo's PR first** so the sync has the updated source to mirror.
