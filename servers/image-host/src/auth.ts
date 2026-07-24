/**
 * Pluggable auth for fleet servers.
 *
 * v1 ships `open` and `bearer`. `edison-jwt` — where Edison mints a per-user
 * JWT and injects it as the Authorization header (no end-user consent screen,
 * attributable `sub`) — is the planned drop-in and is intentionally stubbed so
 * that *selecting* the mode fails loudly rather than silently allowing traffic.
 *
 * The verify layer lives here (not in the Durable Object) so a caller is
 * identified before any work happens, and so the same seam serves every fleet
 * server. See ../../../docs/mcp_commodity_fleet_strategy.md (§6 Auth model).
 */

export type AuthMode = "open" | "bearer" | "edison-jwt";

export interface AuthEnv {
  AUTH_MODE?: string;
  AUTH_TOKEN?: string;
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

/** Minimal structural shape of the bits of `Request` we need — keeps this testable. */
export interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

/**
 * Resolve the effective auth mode. Explicit `AUTH_MODE` wins; otherwise default
 * to `bearer` when a token is configured and `open` when it isn't (self-host
 * friendly — a fresh clone with no secrets just works, read-only-ish).
 */
export function resolveAuthMode(env: AuthEnv): AuthMode {
  const raw = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "open" || raw === "bearer" || raw === "edison-jwt") return raw;
  if (raw) return raw as AuthMode; // unknown value: surfaced as an explicit reject in checkAuth
  return env.AUTH_TOKEN ? "bearer" : "open";
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
export function checkAuth(request: HeaderCarrier, env: AuthEnv): AuthResult {
  const mode = resolveAuthMode(env);
  switch (mode) {
    case "open":
      return { ok: true, mode, subject: "anonymous" };
    case "bearer": {
      if (!env.AUTH_TOKEN) {
        return { ok: false, status: 500, message: "server misconfigured: AUTH_TOKEN not set for bearer mode" };
      }
      const presented = extractBearer(request.headers.get("authorization"));
      if (!presented) return { ok: false, status: 401, message: "missing bearer token" };
      if (!timingSafeEqual(presented, env.AUTH_TOKEN)) {
        return { ok: false, status: 401, message: "invalid bearer token" };
      }
      return { ok: true, mode, subject: "bearer" };
    }
    case "edison-jwt":
      // TODO(fleet): verify the Edison-minted JWT via the published JWKS and set
      // subject = the token's `sub` claim for per-user usage attribution.
      return { ok: false, status: 501, message: "auth mode 'edison-jwt' is not implemented yet" };
    default:
      return { ok: false, status: 500, message: `unknown auth mode: ${mode}` };
  }
}
