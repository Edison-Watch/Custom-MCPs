/**
 * Stateless verification of Edison-minted per-user JWTs (the `edison-jwt` auth
 * mode). Edison signs a short-lived RS256 token per user and injects it as the
 * Authorization header on proxied calls; this server verifies the signature
 * against Edison's published JWKS — no per-request callback to Edison.
 *
 * Contract (both sides must agree — Edison mint side is
 * edison-watch `src/mcp_jwt.py`):
 *   header:  { alg: "RS256", kid, typ: "JWT" }
 *   claims:  { iss, aud, sub, iat, exp }   // aud = this server's id
 *
 * Only RS256 is accepted: Workers WebCrypto verifies RSASSA-PKCS1-v1_5+SHA-256
 * natively, and pinning one alg avoids the classic "alg confusion" downgrade.
 */

export interface EdisonJwtConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
}

export interface JwtOk {
  ok: true;
  sub: string;
}

export interface JwtFail {
  ok: false;
  status: number;
  message: string;
}

export type JwtResult = JwtOk | JwtFail;

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

export interface Jwks {
  keys: Jwk[];
}

const CLOCK_SKEW_SEC = 60;
const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30 * 1000;

// Module-scoped JWKS cache. A cold isolate refetches; within an isolate we
// avoid a fetch per request but still pick up rotations within JWKS_TTL_MS (and
// on a kid miss, subject to the refetch cooldown — see ensureJwks).
let jwksCache: { url: string; jwks: Jwks; fetchedAt: number } | null = null;
let lastFetchAt = 0;

/** Reset the JWKS cache. Test-only. */
export function __resetJwksCacheForTest(): void {
  jwksCache = null;
  lastFetchAt = 0;
}

function fail(status: number, message: string): JwtFail {
  return { ok: false, status, message };
}

function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input))) as T;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

/** Validate the standard registered claims against the server's config. */
function checkClaims(claims: JwtClaims, config: EdisonJwtConfig, now: number): JwtFail | null {
  if (claims.iss !== config.issuer) return fail(401, "token issuer mismatch");
  if (!audienceMatches(claims.aud, config.audience)) return fail(401, "token audience mismatch");
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_SEC) {
    return fail(401, "token expired");
  }
  if (typeof claims.nbf === "number" && now + CLOCK_SKEW_SEC < claims.nbf) {
    return fail(401, "token not yet valid");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return fail(401, "token missing sub");
  }
  return null;
}

async function verifySignature(
  jwk: Jwk,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
  return crypto.subtle.verify(algo, key, signature, new TextEncoder().encode(signingInput));
}

/**
 * Verify a token against an already-resolved JWKS. Pure (no network): the
 * signature-and-claims core, so it is unit-testable without stubbing fetch.
 */
export async function verifyJwtWithJwks(
  token: string,
  jwks: Jwks,
  config: EdisonJwtConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<JwtResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return fail(401, "malformed token");
  const [rawHeader, rawPayload, rawSig] = parts;

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = b64urlToJson<JwtHeader>(rawHeader);
    claims = b64urlToJson<JwtClaims>(rawPayload);
  } catch {
    return fail(401, "unreadable token");
  }
  if (header.alg !== "RS256") return fail(401, `unsupported alg: ${header.alg}`);
  // Edison always sets `kid` (mcp_jwt.py), so a kid-less token is not one Edison
  // minted. Require it, and match on it exactly — no "try every key" fallback.
  if (!header.kid) return fail(401, "missing kid");

  const candidates = jwks.keys.filter((k) => k.kty === "RSA" && k.kid === header.kid);
  if (candidates.length === 0) return fail(401, "no matching signing key");

  let signature: Uint8Array;
  try {
    signature = b64urlToBytes(rawSig);
  } catch {
    return fail(401, "unreadable signature");
  }
  const signingInput = `${rawHeader}.${rawPayload}`;

  let verified = false;
  for (const jwk of candidates) {
    if (await verifySignature(jwk, signingInput, signature)) {
      verified = true;
      break;
    }
  }
  if (!verified) return fail(401, "invalid token signature");

  const claimError = checkClaims(claims, config, now);
  if (claimError) return claimError;
  return { ok: true, sub: claims.sub as string };
}

async function fetchJwks(url: string): Promise<Jwks | null> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as Jwks;
  return Array.isArray(body?.keys) ? body : null;
}

/**
 * Return a JWKS for `url`, cached with a TTL. If `wantKid` is set and the cached
 * set lacks it, refetch once so a freshly rotated key is picked up before the
 * TTL lapses.
 */
async function ensureJwks(url: string, wantKid: string | undefined, now: number): Promise<Jwks | null> {
  const fresh = jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS;
  const hasKid = wantKid ? jwksCache?.jwks.keys.some((k) => k.kid === wantKid) : true;
  if (fresh && hasKid) return jwksCache!.jwks;

  // Rate-limit refetches so an attacker-chosen `kid` can't force one upstream
  // JWKS GET per request. Until the cooldown lapses, serve the cached set (a kid
  // miss then 401s) rather than hammering Edison's /.well-known/jwks.json.
  if (now - lastFetchAt < JWKS_MIN_REFETCH_MS) return jwksCache ? jwksCache.jwks : null;
  lastFetchAt = now;

  const jwks = await fetchJwks(url);
  if (!jwks) return fresh ? jwksCache!.jwks : null; // network blip: fall back to a cached set if we have one
  jwksCache = { url, jwks, fetchedAt: now };
  return jwks;
}

/** Full verify: resolve Edison's JWKS (cached) and verify the token against it. */
export async function verifyEdisonJwt(token: string, config: EdisonJwtConfig): Promise<JwtResult> {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  let kid: string | undefined;
  try {
    kid = b64urlToJson<JwtHeader>(token.split(".")[0]).kid;
  } catch {
    return fail(401, "malformed token");
  }
  const jwks = await ensureJwks(config.jwksUrl, kid, nowMs);
  if (!jwks) return fail(503, "could not fetch Edison JWKS");
  return verifyJwtWithJwks(token, jwks, config, now);
}
