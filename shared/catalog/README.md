# `shared/catalog` - the Edison catalog contract

How a fleet server advertises itself to the Edison marketplace. Each server
declares one `servers/<id>/catalog-entry.json`; edison-watch's sync upserts
those into its static catalog and badges the Edison-hosted ones.

## Contract

- **Schema:** [`schema.json`](./schema.json) - the entry shape (draft 2020-12).
- **Validator/aggregator:** [`aggregate.py`](./aggregate.py) - validates every
  `servers/*/catalog-entry.json` against the schema's constraints (re-expressed
  in stdlib Python so CI needs no dependency) and builds the combined
  `dist/catalog.json`. `dist/` is a gitignored build convenience.
- **Author-side:** a server ships `catalog-entry.json` + its `<id>.svg` icon,
  co-located. See [`../../servers/image-host/`](../../servers/image-host) for the
  worked example. `id` must equal the directory name and the icon basename.

```
  servers/image-host/
    ├─ catalog-entry.json   # this server's connector spec (source of truth)
    └─ image-host.svg       # icon, copied into the marketplace by the sync
```

## Sync (edison-watch side)

The fleet is the source of truth; edison-watch mirrors it one-way. Its
`scripts/sync_fleet_connectors.py` reads the per-server `catalog-entry.json`
**source** files directly from a fleet checkout (not `dist/`, to avoid build
coupling), upserts them into `scripts/marketplace_connectors.json`, copies icons
into `frontend-v2/public/marketplace/icons/`, and runs the existing
`scripts/generate_marketplace_entries.py`. A scheduled/dispatch workflow opens
the update PR. Third-party (non-fleet) catalog entries are never touched.

Full spec: `edison-watch/dev-docs/architecture/first_party_mcp_integration.md`
§(1)–(2); fleet strategy `../../docs/mcp_commodity_fleet_strategy.md` §7.

## CI

`make catalog_check` (wired into `make ci`) runs `aggregate.py --check`, failing
the build on any invalid entry.

## Auth modes

- `token` (v1 static bearer) is what live entries declare today, including
  `image-host`. The install-time bearer secret is resolved from
  `template_fields.env`.
- `edison-jwt` is implemented end to end: Edison mints a per-user RS256 JWT
  (`edison-watch/src/mcp_jwt.py`) and the fleet server verifies it statelessly
  against the published JWKS (`servers/image-host/src/jwt.ts`). The schema and
  `aggregate.py` enforce that `auth: edison-jwt` implies `edison_hosted: true`.
  An entry flips to it once its server is deployed behind Edison's issuer URL;
  see `first_party_mcp_integration.md` for the cutover runbook.

## Per-tool ACL defaults (`tools_configurations`)

Optional. A reviewed classification baked into the install so a marketplace
install doesn't fall back to Edison's protective default (every marketplace
install skips autoconfig auto-labeling, so an unclassified tool mounts as
`read_untrusted_public_data` + `SECRET` - correct-but-conservative, which trips
the lethal-trifecta guard for a plain public reader). Key each entry by the
tool's native name as the server exposes it; every entry carries all four flags:

```jsonc
"tools_configurations": {
  "reddit_scrape": {
    "write_operation": false,          // never writes back to Reddit
    "read_private_data": false,        // only public content
    "read_untrusted_public_data": true, // scraped web content is untrusted
    "acl": "PUBLIC"                    // public data
  }
}
```

A tool omitted here (or an entry with no `tools_configurations` at all) still
gets the protective default, so drift fails closed. edison-watch's
`generate_marketplace_entries.py` carries these into `servers/<id>.json` and
`servers_validate.py` applies them at install. Bake a classification in only
once it has been reviewed.
