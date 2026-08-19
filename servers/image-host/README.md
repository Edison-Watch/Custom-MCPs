# image-host

An Edison first-party **MCP server** that turns an image into a public,
non-expiring URL. Send the image as base64; get back a URL you can paste into a
GitHub issue, Markdown, or a chat message. Runs as a **Cloudflare Worker** with
**R2** for storage and **streamable HTTP** transport at `/mcp`.

> Why base64 in / URL out? The server is remote, so it can't read a caller's
> local filesystem (base64 in), and consumers like GitHub's Camo proxy fetch the
> image server-side with no credentials, so the URL must be plainly public
> (URL out) - not an S3 API call or a presigned, expiring link.

## Tools

### `upload_image`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `content_base64` | string | yes | Base64 image bytes, or a full `data:` URL. |
| `filename` | string | no | Used only to build a readable slug in the key. |
| `content_type` | string | no | e.g. `image/png`. **Verified against the actual bytes.** |
| `prefix` | string | no | Key prefix / folder, e.g. `screenshots`. |

Returns `{ url, key, bytes, content_type }`.

- **Allowed formats:** PNG, JPEG, WebP, GIF. SVG is rejected (no binary magic;
  XSS vector when served inline).
- **Format is sniffed from the bytes**, so a mislabeled payload can't slip
  through; a `content_type` you supply must agree with the bytes.
- **Size cap:** `MAX_UPLOAD_BYTES` (default 10 MiB).
- **Keys are unguessable** - `${prefix}/${16-hex}-${slug}.${ext}`. There is no
  listing endpoint; obscurity is the privacy model.

### `delete_image`

Takes `{ key }`, returns `{ deleted, key }`.

## Endpoints

- `POST /mcp` - MCP streamable HTTP (guarded by auth; see below).
- `GET /i/<key>` - serves the stored object straight from R2 (immutable cache).
- `GET /health` - liveness JSON.

## Auth

Pluggable via [`src/auth.ts`](./src/auth.ts): `open` | `bearer` | `edison-jwt`.
v1 ships **`bearer`** - set `AUTH_TOKEN` and clients send
`Authorization: Bearer <token>`. `edison-jwt` (Edison mints a per-user JWT and
injects it, no consent screen) is stubbed as an explicit drop-in and returns
`501` until the Edison issuer exists. With no token configured the server
defaults to `open` (self-host friendly). See
[`../../docs/mcp_commodity_fleet_strategy.md`](../../docs/mcp_commodity_fleet_strategy.md) §6.

## Config

| Var | Where | Purpose |
|-----|-------|---------|
| `AUTH_TOKEN` | **secret** | Bearer token. `wrangler secret put AUTH_TOKEN`. |
| `AUTH_MODE` | var | `open` \| `bearer` \| `edison-jwt` (default: bearer if token set). |
| `PUBLIC_BASE_URL` | var | Absolute base for returned URLs (your worker URL / custom domain). |
| `KEY_PREFIX` | var | Default prefix when a call omits `prefix`. |
| `MAX_UPLOAD_BYTES` | var | Upload size cap in bytes. |
| `IMAGE_BUCKET` | R2 binding | Object storage (no S3 keys in code). |

## Develop

```bash
bun install
cp .dev.vars.example .dev.vars   # set AUTH_TOKEN, PUBLIC_BASE_URL
bun run test                     # unit tier - pure logic, offline, no workerd
bun run test:integration         # integration tier - real Worker in workerd
bun run typecheck                # tsc --noEmit (needs `bun install` first)
bun run dev                      # wrangler dev - local Worker + local R2
```

Two test tiers:

- **Unit** (`bun test test/unit`) - the pure logic (validation, key generation,
  auth). Zero network, no `node_modules` needed for the runner.
- **Integration** (`vitest run`, `test/integration/`) - the real Worker running
  in **workerd** (via `@cloudflare/vitest-pool-workers`) with real R2 + Durable
  Object bindings from `wrangler.jsonc`. Drives the full MCP streamable-HTTP
  handshake over `SELF.fetch` and asserts the wire format, the origin-derived
  URL, R2 round-trip, `nosniff`, and the auth gate.

`PUBLIC_BASE_URL` is blanked in the test env (a binding override in
`vitest.config.ts`) so the integration tier exercises the request-origin
fallback even though production pins a custom domain.

## Deploy checklist

1. **Create the R2 bucket** (once):
   ```bash
   wrangler r2 bucket create edison-image-host
   ```
2. **Set the bearer secret**:
   ```bash
   wrangler secret put AUTH_TOKEN
   ```
3. **Deploy**:
   ```bash
   wrangler deploy
   ```
4. **Custom domain + `PUBLIC_BASE_URL`**: `wrangler.jsonc` pins a custom
   domain via `routes` (`custom_domain: true`) and sets `PUBLIC_BASE_URL` to
   match. The zone must live in the same Cloudflare account; `wrangler deploy`
   then provisions the DNS record and certificate automatically. Prefer a
   custom domain over `*.workers.dev`: Cloudflare applies non-tunable bot
   protections to `workers.dev` that can intermittently `403` legitimate
   server-to-server callers. **Required:** with neither set, `upload_image`
   fails loudly rather than returning a non-embeddable relative path.
5. **Register as a connector** - add the `https://<worker>/mcp` URL as a custom
   remote MCP connector (e.g. in claude.ai connector settings) with the bearer
   token. Smoke test: `upload_image` a PNG and confirm the returned URL renders
   inline in a GitHub issue.

## Layout

```
src/
  index.ts    McpAgent (Durable Object) + fetch handler (auth, /i/ serving)
  images.ts   pure: base64 decode, format sniff, validation, key generation
  auth.ts     pure: pluggable auth modes (open | bearer | edison-jwt)
test/
  images.test.ts   bun:test - offline
  auth.test.ts     bun:test - offline
```
