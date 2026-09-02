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
  The `reddit` and `youtube` connectors re-export it from their own
  `src/auth.ts` / `src/jwt.ts`, so the verify layer is defined once here. A new
  TS connector should do the same rather than copy the files.
- `py/` - the Python/FastMCP port (dependency for the Gmail-style servers). Not
  yet extracted.

`image-host` still carries its own older `src/auth.ts` (`open` + `bearer`;
`edison-jwt` stubbed `501`); migrating it onto `ts/` is a follow-up.

The JWKS issuer itself is an **edison-watch** change, specified in
`edison-watch/dev-docs/architecture/first_party_mcp_integration.md` §(3).
