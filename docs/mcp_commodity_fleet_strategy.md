# Commodity MCP Fleet — Refactor Strategy

**Status:** Draft / decisions locked, implementation not started
**Owners:** Edison
**Related:** `dev-docs/architecture/first_party_mcp_integration.md` (edison-watch side)

## 1. Goal

Move away from "this repo is one Gmail MCP" and toward **a fleet of small,
utilitarian, streamable-HTTP MCP servers** that Edison owns, hosts as
first-party connectors, and open-sources. Each server is a thin, well-wired
wrapper around a commodity capability an AI agent needs but that isn't yet
exposed cleanly over MCP.

**The thesis for what to own:** if it's basically a glorified API wrapper that
nobody has MCP-ified *well*, the wiring is the value. Each server also doubles
as SEO / blog-post material. First wave: **image preview & hosting**.

## 2. Decisions locked

| # | Decision | Choice |
|---|----------|--------|
| 1 | Topology | Polyglot **monorepo, per-server deploy** — **this repo is refactored in place** into that monorepo (not a greenfield repo). "One process, many mounts" survives only as an option for the Python subset. |
| 2 | Hosting / tenancy | **Edison-hosted multi-tenant is primary, but code is fully OSS / self-hostable.** Auth + state are pluggable so the same code runs hosted (identity ON) or self-hosted (identity OFF / BYO). |
| 3 | Default runtime | **TypeScript on Cloudflare Workers** for new commodity servers. **Python/FastMCP** kept first-class for Gmail and heavy-dependency servers. |
| 4 | MCP-UI | First-class, via a **shared React component library** consumed by both runtimes. |
| 5 | Auth | **Edison-minted per-user JWT**, injected by the gateway (no end-user consent screen), verified statelessly at each server. Pluggable modes; v1 ships static bearer. |
| 6 | Edison listing | New **`edison_hosted`** catalog flag (distinct from generic `is_official`), plus build-time **catalog generation**. |
| 7 | Gmail | Stays in its **existing shape** (Python/FastMCP) as a co-tenant of this monorepo; publishes a catalog entry the same way as every other server. |
| 8 | Wave 1 | **Image preview & hosting** (Cloudflare Worker + R2). |

## 3. Target architecture

```
        THIS REPO, refactored into a polyglot monorepo (each server deploys independently)
  +--------------------------------------------------------------------------+
  | services/ mcp_server/ api_server/   existing Python/Gmail app (root deploy)|
  |                                                                            |
  | servers/                                                                   |
  |   image-host/   TypeScript . Cloudflare Worker . R2 binding        ---> CF |
  |   pdf/          TypeScript . Worker                                ---> CF |
  |   qr/           TypeScript . Worker                                ---> CF |
  |   <py-utils>/   Python . FastMCP  (MAY co-deploy as one process)           |
  |                    one container, /mcp/a  /mcp/b                            |
  | shared/                                                                    |
  |   +-- ui/       React MCP-UI component library (both runtimes)             |
  |   +-- auth/     JWT verify middleware (TS + Py ports)                      |
  |   +-- catalog/  catalog-entry generator + schema                          |
  +---------------------------------+----------------------------------------+
                                    | each server emits a catalog entry
                                    v
             edison-watch marketplace  --  is_official + edison_hosted:true
```

Grown **additively**: `servers/` + `shared/` are added around the existing
Python app, whose deploy is untouched. Two things keep a polyglot, per-deploy
fleet coherent: a **catalog-generation contract** (how a server advertises
itself to Edison) and an **auth contract** (how a caller is identified).
Everything else is per-server.

## 4. Runtime: why TS/Workers is the default

MCP-UI does **not** force the language — the UI is always sandboxed web tech
(React/HTML in an iframe) regardless of server language, and both runtimes now
support MCP Apps (official `ext-apps` TS SDK; FastMCP v3 on the Python side).
What actually forces the choice is the **deployment target**: Cloudflare
Workers run JS/TS natively, and Python-on-Workers (Pyodide/WASM) can't load
native-C-extension packages (SQLAlchemy, DSPy) and has TS-first MCP tooling.

| Axis | TS on Cloudflare Workers (`ext-apps`) | Python FastMCP v3 (container) |
|------|---------------------------------------|-------------------------------|
| MCP-UI / Apps | Official `ext-apps` SDK; React/Vue/Svelte/Solid templates | MCP Apps + Prefab UI DSL (newer) |
| Fits CF credits | Native — edge, near-zero cold start | Won't run on Workers; Pyodide port is beta, native deps break |
| State primitives | R2, KV, D1, Durable Objects, Queues (bindings) | Bring-your-own DB/storage |
| Deploy / ops | `wrangler deploy`, scales to zero, cheap | Container (Railway/Render), heavier |
| Best for | Stateless/edge commodity wrappers | Heavy Python deps, LLM/DSPy, existing Gmail |

**Rule of thumb:** new commodity server → TS/Workers. Needs heavy Python deps or
already exists in Python → FastMCP/container. Gmail is the lone Python outlier,
so the two-toolchain cost (uv/ruff/ty + bun/wrangler/eslint in one repo) is the
main tax of refactoring in place — accepted.

## 5. MCP-UI stays consistent across the split

The server language differs, but the UI does not. A shared React component
library (`shared/ui`) is consumed by both the TS servers (via `ext-apps`) and
the Python servers (via FastMCP v3 apps). Only the thin server-side
registration + the app<->server postMessage bridge is runtime-specific.

```
  ext-apps (TS worker)  ---+                         +--- FastMCP v3 (Py container)
                           |                         |
                           +---->  shared/ui  <------+
                                (React MCP-UI lib)
                   one look & feel, one component set, two thin adapters
```

## 6. Auth model

Constraints that decided this: **(a) not anonymous — usage must be
attributable**, and **(b) no OAuth consent screen for Edison users**. Those two
together eliminate static-bearer (anonymous) and per-MCP-OAuth (consent), and
select **Edison-minted per-user JWT injected by the gateway**. Because these are
public Worker endpoints (no network isolation to lean on), the token must be
cryptographically verifiable, not a merely-trusted header.

```
  end user (already logged into Edison)
      |  uses an Edison-hosted MCP  -->  NO consent screen
      v
  Edison proxy -- mints per-user JWT { sub, org, quota }  (signed w/ Edison key)
      |           injects  Authorization: Bearer <jwt>   (existing header-inject seam)
      v
  server (Worker) -- verify signature via Edison JWKS (or shared HS256 secret)
      |              read `sub` -> attribute + meter usage per user
      v          self-host / no-Edison?  ->  mode falls back to static bearer / open
    do work . log usage[sub]
```

**Pluggable modes** (per server, from config): `open` | `bearer` | `edison-jwt`
| `oauth`. Hosted = `edison-jwt`; self-host defaults to `open`/`bearer`. This is
what lets "Edison-hosted primary AND fully OSS" both hold without forking code.

**Sequencing:** ship the first server on the static **`bearer`** mode (already
in the image spec, done and auditable), but write the verify layer so
**`edison-jwt` is a drop-in** once Edison's issuer exists — do not block server
#1 on the issuer build.

## 7. Edison integration

Three surfaces, detailed on the edison-watch side in
`dev-docs/architecture/first_party_mcp_integration.md`:

1. **`edison_hosted` catalog flag** — extend the marketplace entry schema
   (`scripts/generate_marketplace_entries.py`, `MarketplacePanel.tsx` type)
   beyond generic `is_official` so first-party hosted servers get a distinct
   badge. Provenance already tracked via `from_marketplace_id`.
2. **Catalog generation** — each server in this repo emits its connector entry
   (url, auth mode, icon, `tools_configurations` ACL defaults) as a build
   artifact (`shared/catalog`); CI syncs them into edison-watch's
   `scripts/marketplace_connectors.json` + `frontend-v2/public/marketplace/`.
3. **JWT issuer** — Edison mints per-user JWTs in the proxy's existing
   header-injection path and publishes a JWKS endpoint. Small, high-leverage,
   reused by every future first-party server. The `edison-jwt` auth mode
   depends on this.

## 8. Wave 1 — image preview & hosting (worked example)

A Cloudflare Worker MCP that accepts an image as **base64** (the server is
remote and cannot read a caller's filesystem) and returns a **public,
non-expiring URL** (R2 public domain, not an S3 API or presigned URL — GitHub's
Camo proxy fetches server-side without credentials). Full build spec is tracked
separately; the acceptance criteria in brief:

- `upload_image(content_base64, filename?, content_type?, prefix?)` returns
  `{ url, key, bytes, content_type }` + a human-readable URL line.
- Content-type allowlist (png/jpeg/webp/gif; SVG rejected), size cap,
  unguessable key (`${prefix}/${16+ hex}-${slug}.${ext}`) — obscurity is the
  privacy model, no listing endpoint.
- Endpoint guarded by `AUTH_TOKEN` (v1 `bearer` mode); R2 via **binding**, no
  S3 keys in code. `PUBLIC_BASE_URL` drives the returned URL.
- Reachable as a claude.ai custom remote connector over Streamable HTTP.

This server is a good first proof precisely because it exercises **state (R2
blobs)** and the **base64/remote-transport** constraints without yet needing UI
or the JWT issuer. It also lands as `servers/image-host/`, exercising the
new monorepo layout end to end.

## 9. Roadmap

1. Refactor this repo into the monorepo skeleton **additively**: add `servers/`
   (TS Workers) + `shared/{ui,auth,catalog}` + dual-runtime CI/prek, leaving the
   existing Python app in place.
2. Ship **image-host** (`servers/image-host/`) on `bearer` mode end-to-end
   (deploy -> claude.ai connector -> URL renders in a GitHub issue).
3. Build the **catalog generator** + `edison_hosted` flag; land image-host as a
   first-party Edison connector.
4. Build the **Edison JWT issuer** + JWKS; flip image-host to `edison-jwt`; wire
   per-user usage metering.
5. Wave 2 servers (pdf, qr, screenshot, ...) reuse `shared/` end to end.
6. Emit Gmail's catalog entry via the same contract; optionally relocate the
   existing Python app to `servers/gmail/` for layout symmetry (touches deploy
   configs — deferred).

## 10. Open questions

- Layout timing: relocate the existing Python app under `servers/gmail/` now, or
  leave it at root and grow `servers/` around it? (Leaning: leave at root now;
  relocate later — avoids disturbing the current deploy/packaging.)
- JWT signing: shared HS256 secret (simplest) vs RS256/EdDSA + JWKS (rotatable,
  no shared secret at the edge). Leaning JWKS for a public edge fleet.
- Usage sink: push events back to Edison vs per-Worker D1 / Analytics Engine.
- Do any wave-2 servers need to be usable *outside* Edison (argues for adding
  `oauth` mode to those specific servers)?

## References (no live links to keep docs_lint egress clean)

- modelcontextprotocol.io/extensions/apps/build — MCP Apps / `ext-apps`
- github.com/MCP-UI-Org/mcp-ui — MCP-UI SDK
- developers.cloudflare.com/workers/languages/python — Python Workers limits
- edison-watch: `src/single_user_mcp_mount.py`, `src/oauth_manager.py`,
  `scripts/generate_marketplace_entries.py`, `frontend-v2/public/marketplace/`
