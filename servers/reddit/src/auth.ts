/**
 * Pluggable auth for fleet servers.
 *
 * Ships `open`, `bearer`, and `edison-jwt` - where Edison mints a per-user JWT
 * and injects it as the Authorization header (no end-user consent screen,
 * attributable `sub`), verified statelessly against Edison's published JWKS
 * (see ./jwt.ts).
 *
 * The verify layer lives here (not in the Durable Object) so a caller is
 * identified before any work happens, and so the same seam serves every fleet
 * server. See ../../../docs/mcp_commodity_fleet_strategy.md (§6 Auth model).
 */

import { verifyEdisonJwt } from "./jwt";

export type AuthMode = "open" | "bearer" | "edison-jwt";

export interface AuthEnv {
  AUTH_MODE?: string;
  AUTH_TOKEN?: string;
  // edison-jwt mode: where to fetch Edison's JWKS and the claims to enforce.
  EDISON_JWKS_URL?: string;
  EDISON_JWT_ISSUER?: string;
  EDISON_JWT_AUDIENCE?: string;
}

export interface AuthOk {
  ok: true;
  mode: AuthMode;
  subject: string;
}

export interface AuthFail {
  ok: false;
  status: number;
  message: string;
}

export type AuthResult = AuthOk | AuthFail;

/** Minimal structural shape of the bits of `Request` we need - keeps this testable. */
export interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

/**
 * Resolve the effective auth mode. Explicit `AUTH_MODE` wins; otherwise default
 * to `bearer` when `AUTH_TOKEN` is *present* and `open` only when it is entirely
 * absent (self-host friendly). NOTE: `open` requires NO auth yet still exposes
 * the server's tools - only default to it for a trusted/self-hosted deploy,
 * never a public one.
 *
 * A defined-but-empty `AUTH_TOKEN` (e.g. `AUTH_TOKEN=""`) must NOT collapse to
 * `open`: an operator who set the var clearly meant to require auth, so we keep
 * them in `bearer` where `checkAuth` fails closed with a 500 misconfig rather
 * than silently serving unauthenticated. Only a truly unset token means `open`.
 *
 * Returns `AuthMode | string`: an unrecognized `AUTH_MODE` is passed through as
 * a raw string so `checkAuth` rejects it explicitly (fail closed) rather than
 * this cast smuggling an invalid value into the `AuthMode` type.
 */
export function resolveAuthMode(env: AuthEnv): AuthMode | string {
  const raw = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "open" || raw === "bearer" || raw === "edison-jwt") return raw;
  if (raw) return raw; // unknown value: surfaced as an explicit reject in checkAuth
  // Distinguish absent (undefined -> open) from present-but-empty ("" -> bearer,
  // which then 500s as misconfigured) so an empty token never disables auth.
  return env.AUTH_TOKEN !== undefined ? "bearer" : "open";
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Constant-time string comparison. Workers has no `crypto.timingSafeEqual`, so
 * compare over the max length and fold in the length difference to avoid
 * leaking the secret's length via an early exit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Authenticate a request under the server's configured mode. */
export async function checkAuth(request: HeaderCarrier, env: AuthEnv): Promise<AuthResult> {
  const mode = resolveAuthMode(env);
  switch (mode) {
    case "open":
      return { ok: true, mode, subject: "anonymous" };
    case "bearer": {
      if (!env.AUTH_TOKEN?.trim()) {
        return { ok: false, status: 500, message: "server misconfigured: AUTH_TOKEN not set for bearer mode" };
      }
      const presented = extractBearer(request.headers.get("authorization"));
      if (!presented) return { ok: false, status: 401, message: "missing bearer token" };
      if (!timingSafeEqual(presented, env.AUTH_TOKEN)) {
        return { ok: false, status: 401, message: "invalid bearer token" };
      }
      return { ok: true, mode, subject: "bearer" };
    }
    case "edison-jwt": {
      // Verify the Edison-minted JWT via the published JWKS; subject = `sub`
      // claim for per-user usage attribution. All three config values are
      // required - a missing one fails closed rather than admitting traffic.
      const { EDISON_JWKS_URL, EDISON_JWT_ISSUER, EDISON_JWT_AUDIENCE } = env;
      if (!EDISON_JWKS_URL || !EDISON_JWT_ISSUER || !EDISON_JWT_AUDIENCE) {
        return {
          ok: false,
          status: 500,
          message:
            "server misconfigured: edison-jwt needs EDISON_JWKS_URL, EDISON_JWT_ISSUER, EDISON_JWT_AUDIENCE",
        };
      }
      const presented = extractBearer(request.headers.get("authorization"));
      if (!presented) return { ok: false, status: 401, message: "missing bearer token" };
      const result = await verifyEdisonJwt(presented, {
        jwksUrl: EDISON_JWKS_URL,
        issuer: EDISON_JWT_ISSUER,
        audience: EDISON_JWT_AUDIENCE,
      });
      if (!result.ok) return { ok: false, status: result.status, message: result.message };
      return { ok: true, mode, subject: result.sub };
    }
    default:
      return { ok: false, status: 500, message: `unknown auth mode: ${mode}` };
  }
}
