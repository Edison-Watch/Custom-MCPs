# `shared/catalog` — the Edison catalog contract

How a fleet server advertises itself to the Edison marketplace. Each server
emits one connector entry as a build artifact; CI upserts those into
edison-watch's static catalog.

Planned entry shape (superset of edison-watch's existing marketplace entry):

```jsonc
{
  "id": "image-host",
  "name": "Image Host",
  "url": "https://image-host.<host>/mcp",
  "transport": "http",
  "auth_mode": "bearer",              // open | bearer | edison-jwt
  "is_official": true,
  "edison_hosted": true,              // NEW: first-party, Edison-operated
  "author": "Edison",
  "icon": "image-host.svg",
  "tools_configurations": [ /* per-tool ACL defaults: PUBLIC | PRIVATE | SECRET */ ]
}
```

## Status

Placeholder. When the generator lands here it will:

1. Read each server's declared metadata (name, url, auth mode, icon, per-tool
   ACL defaults) and emit `dist/<id>.json`.
2. Feed edison-watch's `scripts/generate_marketplace_entries.py` +
   `scripts/marketplace_connectors.json`, and drop icons under
   `frontend-v2/public/marketplace/icons/`.

The **`edison_hosted`** flag and the sync are edison-watch changes, specified in
`edison-watch/dev-docs/architecture/first_party_mcp_integration.md` §(1)–(2).
