# `shared/auth` — the fleet auth contract

Every fleet server speaks the same pluggable auth modes so a caller is
identified the same way everywhere and Edison can flip a server's mode without
touching its logic.

```
mode         who                         how a request is authenticated
----         ---                         ------------------------------
open         self-host / dev             admitted as `anonymous`
bearer       v1 hosted + self-host       Authorization: Bearer <shared token>
edison-jwt   Edison-hosted (target)      Authorization: Bearer <per-user JWT>,
                                         verified statelessly via Edison JWKS;
                                         `sub` = the end user (usage attribution)
```

**`edison-jwt`** is the reason there's no end-user consent screen: Edison (the
gateway the user is already logged into) mints a short-lived per-user JWT and
injects it on the proxied call. The server verifies the signature against
Edison's published `/.well-known/jwks.json` — no per-request callback — and
reads `sub` to attribute usage.

## Status

The reference implementation currently lives in
[`../../servers/image-host/src/auth.ts`](../../servers/image-host/src/auth.ts)
(`open` + `bearer` working; `edison-jwt` stubbed to fail loudly with `501`).
When a second server needs it, the verify layer gets promoted here as:

- `ts/` — the TypeScript port (Workers `fetch` middleware).
- `py/` — the Python/FastMCP port (dependency for the Gmail-style servers).

The JWKS issuer itself is an **edison-watch** change, specified in
`edison-watch/dev-docs/architecture/first_party_mcp_integration.md` §(3).
