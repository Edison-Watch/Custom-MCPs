---
name: add-fleet-connector
description: Add a new fleet HTTP-wrapper MCP server to the Edison marketplace - scaffold servers/<id>/, classify each tool's ACL and lethal-trifecta legs, and validate. Use when adding or classifying a fleet connector.
---

# Adding a fleet MCP connector

A fleet connector is one HTTP-wrapper MCP server advertised to the Edison
marketplace. Its source of truth is `servers/<id>/catalog-entry.json` (+ a
co-located `<id>.svg` icon) in this repo; edison-watch mirrors it downstream.
Full contract: `shared/catalog/README.md`.

The one step you cannot skip is **classifying every tool** the server exposes.
Marketplace installs skip autoconfig auto-labeling, so a tool with no
classification mounts at the protective default (write + read_private +
read_untrusted + `SECRET`) and trips the lethal-trifecta guard on its first
call - the connector looks broken. `make catalog_check` fails until every
`edison_hosted` connector ships a non-empty `tools_configurations`.

## 1. Scaffold

```bash
make new-connector id=<id>          # id: lowercase letters, digits, hyphens
```

This writes `servers/<id>/catalog-entry.json` (a skeleton with TODOs, no
`tools_configurations` yet) and a placeholder `servers/<id>/<id>.svg`.

## 2. Fill in the entry

Edit `servers/<id>/catalog-entry.json`:

- `displayName`, `description`, `category`, `tags` - human-facing catalog copy.
- `url` - the public streamable-HTTP endpoint, ending in `/mcp`.
- `auth` - `edison-jwt` (first-party, Edison mints a per-user JWT; requires
  `edison_hosted: true`), `token` (static bearer; also needs `headers` +
  `template_fields`), `oauth`, or `none`. See the schema for the shape each
  mode requires.
- Replace `<id>.svg` with the real brand mark (simple-icons where available,
  viewBox `0 0 24 24`; see `.claude/rules/agent-icons.md` for style).

## 3. Classify every tool (`tools_configurations`)

List the server's tools (call `tools/list` on its `/mcp` endpoint, or read the
server source). Key each entry by the tool's **native name** as the server
exposes it. For each tool decide four fields:

| Field | True when the tool... |
|-------|-----------------------|
| `write_operation` | modifies external state (create / update / delete / send / post) |
| `read_private_data` | reads private or sensitive data, not just public content (a user's inbox, DMs, private repos) |
| `read_untrusted_public_data` | pulls untrusted external content (web pages, scraped results, third-party API responses) |
| `acl` | `PUBLIC` / `PRIVATE` / `SECRET` - the sensitivity of the data it handles |

The three booleans are the lethal-trifecta legs: a session is blocked only when
all three are simultaneously live across the tools it uses. Classify each tool
for what *it* actually does - do not pad the flags "to be safe," because an
over-broad classification is exactly what blocks a legitimate connector.

Worked examples already in the repo:

```jsonc
// reddit_scrape - reads public web content, never writes
"reddit_scrape": {
  "write_operation": false,
  "read_private_data": false,
  "read_untrusted_public_data": true,   // scraped pages are untrusted
  "acl": "PUBLIC"
}
// image-host upload_image - creates a public URL, touches no private data
"upload_image": {
  "write_operation": true,              // creates a hosted resource
  "read_private_data": false,
  "read_untrusted_public_data": false,
  "acl": "PUBLIC"
}
```

A tool you leave out of a present map keeps the protective default, so partial
coverage fails closed - but ship a config for every tool the server exposes.
Bake a classification in only once you have actually reviewed what the tool does.

## 4. Validate

```bash
make catalog_check      # aggregate.py --check: schema + mandatory classification
make ci                 # full gate before committing
```

Both must pass with zero errors.

## 5. Downstream mirror (edison-watch)

This repo is the source of truth. edison-watch's Fleet Catalog Sync mirrors
`catalog-entry.json` into its marketplace one-way; a scheduled/dispatch workflow
opens the update PR. Never hand-edit the edison-watch side - if you do, the next
sync reverts it. When both a fleet change and its edison-watch mirror are open as
PRs, **merge this repo's PR first** so the sync has the updated source to mirror.
