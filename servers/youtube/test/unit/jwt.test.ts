import { beforeAll, describe, expect, test } from "bun:test";

import {
  __resetJwksCacheForTest,
  type EdisonJwtConfig,
  type Jwks,
  verifyEdisonJwt,
  verifyJwtWithJwks,
} from "../../src/jwt";

// Deterministic clock so exp/nbf checks don't depend on wall time.
const NOW = 1_000_000_000;
const KID = "test-key-1";
const CONFIG: EdisonJwtConfig = {
  jwksUrl: "https://edison.example/.well-known/jwks.json",
  issuer: "https://edison.example",
  audience: "reddit",
};

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

let privateKey: CryptoKey;
let jwks: Jwks;

async function sign(
  claims: Record<string, unknown>,
  opts: { kid?: string | null; alg?: string } = {},
): Promise<string> {
  // opts.kid === null omits the kid header entirely (to test rejection).
  const headerObj: Record<string, unknown> = { alg: opts.alg ?? "RS256", typ: "JWT" };
  if (opts.kid !== null) headerObj.kid = opts.kid ?? KID;
  const header = b64urlStr(JSON.stringify(headerObj));
  const payload = b64urlStr(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: CONFIG.issuer, aud: CONFIG.audience, sub: "user-42", iat: NOW, exp: NOW + 300, ...overrides };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" } as Jwks["keys"][number]] };
});

describe("verifyJwtWithJwks", () => {
  test("accepts a well-formed, correctly signed token and returns sub", async () => {
    const token = await sign(validClaims());
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toEqual({ ok: true, sub: "user-42" });
  });

  test("accepts an audience array that includes this server", async () => {
    const token = await sign(validClaims({ aud: ["other", CONFIG.audience] }));
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: true });
  });

  test("rejects an expired token", async () => {
    const token = await sign(validClaims({ exp: NOW - 120 }));
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a wrong issuer", async () => {
    const token = await sign(validClaims({ iss: "https://evil.example" }));
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a wrong audience", async () => {
    const token = await sign(validClaims({ aud: "some-other-server" }));
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a missing sub", async () => {
    const token = await sign(validClaims({ sub: undefined }));
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a non-RS256 alg without trusting the signature", async () => {
    const token = await sign(validClaims(), { alg: "HS256" });
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects when no JWKS key matches the kid", async () => {
    const token = await sign(validClaims(), { kid: "unknown-kid" });
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a token with no kid (Edison always sets one)", async () => {
    const token = await sign(validClaims(), { kid: null });
    expect(await verifyJwtWithJwks(token, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a tampered signature", async () => {
    const token = await sign(validClaims());
    const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");
    expect(await verifyJwtWithJwks(tampered, jwks, CONFIG, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a structurally malformed token", async () => {
    expect(await verifyJwtWithJwks("not.a.jwt.at.all", jwks, CONFIG, NOW)).toMatchObject({ ok: false });
    expect(await verifyJwtWithJwks("onlyonepart", jwks, CONFIG, NOW)).toMatchObject({ ok: false });
  });
});

describe("verifyEdisonJwt (JWKS fetch + refetch cooldown)", () => {
  // Claims must be valid under the real clock - verifyEdisonJwt uses Date.now().
  function realClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return { iss: CONFIG.issuer, aud: CONFIG.audience, sub: "user-42", iat: now, exp: now + 300, ...overrides };
  }

  test("fetches JWKS once, then rate-limits attacker-driven kid-miss refetches", async () => {
    __resetJwksCacheForTest();
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const ok = await verifyEdisonJwt(await sign(realClaims()), CONFIG);
      expect(ok).toMatchObject({ ok: true, sub: "user-42" });
      expect(fetches).toBe(1);

      // A burst of unknown, attacker-chosen kids must not each hit the network.
      for (let i = 0; i < 5; i++) {
        await verifyEdisonJwt(await sign(realClaims(), { kid: `attacker-${i}` }), CONFIG);
      }
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("coalesces a concurrent cold-start burst into a single JWKS fetch", async () => {
    __resetJwksCacheForTest();
    let fetches = 0;
    const realFetch = globalThis.fetch;
    // A deliberately slow fetch so all requests overlap the same in-flight GET.
    globalThis.fetch = (async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const tokens = await Promise.all(Array.from({ length: 8 }, () => sign(realClaims())));
      const results = await Promise.all(tokens.map((t) => verifyEdisonJwt(t, CONFIG)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(fetches).toBe(1); // 8 concurrent requests, one upstream GET
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a JWKS whose keys contain a null/non-object entry is rejected (503, not a 500)", async () => {
    __resetJwksCacheForTest();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ keys: [null] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      // A malformed JWKS must be treated as "no JWKS" (caller 503s), never cached
      // and dereferenced downstream into an uncaught 500.
      const result = await verifyEdisonJwt(await sign(realClaims()), CONFIG);
      expect(result).toMatchObject({ ok: false, status: 503 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a failed fetch does not suppress the next request's retry", async () => {
    __resetJwksCacheForTest();
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches++;
      if (fetches === 1) throw new Error("transient network blip");
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const first = await verifyEdisonJwt(await sign(realClaims()), CONFIG);
      expect(first).toMatchObject({ ok: false, status: 503 }); // fetch failed -> 503
      const second = await verifyEdisonJwt(await sign(realClaims()), CONFIG);
      expect(second).toMatchObject({ ok: true }); // retried immediately, not suppressed
      expect(fetches).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
