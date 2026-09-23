/**
 * Stateless verification of Edison-minted per-user JWTs (the `edison-jwt` auth
 * mode). Edison signs a short-lived RS256 token per user and injects it as the
 * Authorization header on proxied calls; this server verifies the signature
 * against Edison's published JWKS - no per-request callback to Edison.
 *
 * Shared TypeScript port: each connector re-exports it from its own
 * `src/jwt.ts` so the verifier is defined once (see ../README.md).
 *
 * Contract (both sides must agree - Edison mint side is
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
// on a kid miss, subject to the refetch cooldown - see ensureJwks).
let jwksCache: { url: string; jwks: Jwks; fetchedAt: number } | null = null;
let lastFetchAt = 0;
// A single outstanding fetch, so a cold/stale-cache burst coalesces into ONE
// upstream GET instead of one per concurrent request (see ensureJwks).
let inFlight: { url: string; promise: Promise<Jwks | null> } | null = null;

/** Reset the JWKS cache. Test-only. */
export function __resetJwksCacheForTest(): void {
  jwksCache = null;
  lastFetchAt = 0;
  inFlight = null;
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
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
    return await crypto.subtle.verify(algo, key, signature, new TextEncoder().encode(signingInput));
  } catch {
    // A malformed/unsupported JWK makes importKey/verify throw. Treat it as a
    // failed verification (401), never an uncaught rejection that escapes to 500.
    return false;
  }
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
  // A structurally valid JSON `null`, array, or primitive parses without
  // throwing but would blow up the property reads below (`header.alg`,
  // `claims.iss`) with an uncaught TypeError -> 500. Reject a non-object
  // header/claims as a 401 so this function never throws on hostile input.
  if (!isPlainObject(header) || !isPlainObject(claims)) return fail(401, "unreadable token");
  if (header.alg !== "RS256") return fail(401, `unsupported alg: ${header.alg}`);
  // Edison always sets `kid` (mcp_jwt.py), so a kid-less token is not one Edison
  // minted. Require it, and match on it exactly - no "try every key" fallback.
  if (!header.kid) return fail(401, "missing kid");

  // Require the public RSA params too, so a malformed JWKS entry can't reach importKey.
  const candidates = jwks.keys.filter(
    (k) => k.kty === "RSA" && k.kid === header.kid && k.n && k.e,
  );
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

/** A plain (non-null, non-array) object - the only shape safe to read fields off. */
function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parsed JWKS body is only usable if `keys` is an array of non-null objects. */
function isUsableJwks(body: unknown): body is Jwks {
  const keys = (body as { keys?: unknown } | null)?.keys;
  return Array.isArray(keys) && keys.every(isPlainObject);
}

// Cap the JWKS fetch: a stalled endpoint must not hold the shared inFlight
// promise (and every /mcp auth request joined to it) open until the Worker's
// own request budget expires. A timeout aborts the fetch, the catch below maps
// it to "no JWKS", and the caller 503s.
const JWKS_FETCH_TIMEOUT_MS = 5000;

async function fetchJwks(url: string): Promise<Jwks | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    // Reject a `keys` array that carries a null/non-object entry: caching it
    // would make the verify path dereference the bad entry and 500. A malformed
    // JWKS is treated as "no JWKS" (caller 503s), never handed downstream.
    return isUsableJwks(body) ? body : null;
  } catch {
    // Network error or unparseable body: report "no JWKS" (caller 503s) rather
    // than letting the rejection escape verifyEdisonJwt/checkAuth to a 500.
    return null;
  }
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

  // Only the cache fetched from THIS url is a valid fallback - never serve a set
  // fetched for a different jwksUrl (which would verify against the wrong issuer).
  const cachedForUrl = jwksCache && jwksCache.url === url ? jwksCache.jwks : null;

  // If a fetch for this url is already outstanding, join it rather than opening
  // a second upstream GET. This is what actually bounds a concurrent burst: the
  // cooldown below only throttles *sequential* requests, so without dedup every
  // request in a cold-isolate burst would fetch (lastFetchAt only advances after
  // success). Failures don't advance the cooldown, so the next request retries.
  if (inFlight && inFlight.url === url) return (await inFlight.promise) ?? cachedForUrl;

  // Rate-limit sequential refetches so an attacker-chosen `kid` can't force one
  // upstream JWKS GET per request. Until the cooldown lapses, serve the cached
  // set for this url (a kid miss then 401s) rather than hammering the endpoint.
  if (now - lastFetchAt < JWKS_MIN_REFETCH_MS) return cachedForUrl;

  const promise = fetchJwks(url);
  inFlight = { url, promise };
  let jwks: Jwks | null;
  try {
    jwks = await promise;
  } finally {
    if (inFlight && inFlight.promise === promise) inFlight = null;
  }
  if (!jwks) return cachedForUrl; // network blip: fall back to a same-url cached set, else null (503)
  // Advance the cooldown only after a *successful* fetch, so a failed fetch can
  // retry on the next request instead of being suppressed for the whole window.
  lastFetchAt = now;
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
