import { beforeAll, describe, expect, test } from "bun:test";

import { type EdisonJwtConfig, type Jwks, verifyJwtWithJwks } from "../../src/jwt";

// Deterministic clock so exp/nbf checks don't depend on wall time.
const NOW = 1_000_000_000;
const KID = "test-key-1";
const CONFIG: EdisonJwtConfig = {
  jwksUrl: "https://edison.example/.well-known/jwks.json",
  issuer: "https://edison.example",
  audience: "image-host",
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
  opts: { kid?: string; alg?: string } = {},
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
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
