# `shared/auth` - the fleet auth contract

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
Edison's published `/.well-known/jwks.json` - no per-request callback - and
reads `sub` to attribute usage.

## Status

- `ts/` - the TypeScript port (Workers `fetch` middleware). **Live.** All three
  modes including `edison-jwt` (stateless JWKS verify, see [`ts/jwt.ts`](./ts/jwt.ts)).
  A new TS connector should re-export it rather than copy the files.
- `py/` - the Python/FastMCP port (dependency for the Gmail-style servers). Not
  yet extracted.

Every TS connector re-exports `ts/` from its own `src/auth.ts` / `src/jwt.ts`.
The verifier's suites live beside it (`ts/*.test.ts`, run by the `test-shared`
job in `servers_ts.yaml`); a server keeps only a smoke test that it re-exports
this module. A non-markdown change under `shared/` redeploys every server.

The JWKS issuer itself is an **edison-watch** change, specified in
`edison-watch/dev-docs/architecture/first_party_mcp_integration.md` §(3).
