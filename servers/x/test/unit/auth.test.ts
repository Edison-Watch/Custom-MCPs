import { describe, expect, test } from "bun:test";

import { checkAuth, extractBearer, resolveAuthMode, timingSafeEqual } from "../../src/auth";

function req(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) };
}

describe("resolveAuthMode", () => {
  test("defaults to open with no token, bearer with a token", () => {
    expect(resolveAuthMode({})).toBe("open");
    expect(resolveAuthMode({ AUTH_TOKEN: "x" })).toBe("bearer");
  });

  test("honors an explicit mode", () => {
    expect(resolveAuthMode({ AUTH_MODE: "open", AUTH_TOKEN: "x" })).toBe("open");
    expect(resolveAuthMode({ AUTH_MODE: "edison-jwt" })).toBe("edison-jwt");
  });

  test("passes an unknown mode through verbatim (checkAuth rejects it)", () => {
    expect(resolveAuthMode({ AUTH_MODE: "totally-made-up" })).toBe("totally-made-up");
  });

  test("a defined-but-empty token stays bearer (never silently open)", () => {
    // AUTH_TOKEN="" is a misconfig, not a request for open mode: keep it in
    // bearer so checkAuth 500s rather than serving unauthenticated traffic.
    expect(resolveAuthMode({ AUTH_TOKEN: "" })).toBe("bearer");
    expect(resolveAuthMode({ AUTH_TOKEN: "   " })).toBe("bearer");
  });

  test("an explicitly empty/whitespace AUTH_MODE is invalid, never open", () => {
    // A set-but-empty AUTH_MODE is a misconfig: it must fail closed, not fall
    // through to `open` (which would serve the tools unauthenticated).
    expect(resolveAuthMode({ AUTH_MODE: "" })).toBe("invalid-auth-mode");
    expect(resolveAuthMode({ AUTH_MODE: "   " })).toBe("invalid-auth-mode");
    // ...even with no AUTH_TOKEN present at all.
    expect(resolveAuthMode({ AUTH_MODE: "  " })).toBe("invalid-auth-mode");
  });
});

describe("extractBearer", () => {
  test("parses a bearer header case-insensitively", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer  spaced ")).toBe("spaced");
  });

  test("returns null for missing or malformed headers", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  test("matches equal strings and rejects unequal / different-length", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secre7")).toBe(false);
    expect(timingSafeEqual("secret", "secretx")).toBe(false);
  });
});

describe("checkAuth", () => {
  test("open mode admits everyone", async () => {
    expect(await checkAuth(req(), {})).toMatchObject({ ok: true, mode: "open", subject: "anonymous" });
  });

  test("bearer mode: missing, wrong, and correct tokens", async () => {
    const env = { AUTH_TOKEN: "s3cret" };
    expect(await checkAuth(req(), env)).toMatchObject({ ok: false, status: 401 });
    expect(await checkAuth(req({ authorization: "Bearer nope" }), env)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await checkAuth(req({ authorization: "Bearer s3cret" }), env)).toMatchObject({
      ok: true,
      subject: "bearer",
    });
  });

  test("bearer mode with no configured token is a 500 misconfig", async () => {
    expect(await checkAuth(req({ authorization: "Bearer x" }), { AUTH_MODE: "bearer" })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  test("a defined-but-empty token 500s (misconfig), never admits as open", async () => {
    // No AUTH_MODE + AUTH_TOKEN="" must resolve to bearer and fail closed.
    expect(await checkAuth(req({ authorization: "Bearer anything" }), { AUTH_TOKEN: "" })).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(await checkAuth(req({ authorization: "Bearer anything" }), { AUTH_TOKEN: "   " })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  test("edison-jwt with incomplete config fails closed (500), never admits", async () => {
    // Missing JWKS/issuer/audience must not fall through to allowing traffic.
    expect(await checkAuth(req({ authorization: "Bearer x" }), { AUTH_MODE: "edison-jwt" })).toMatchObject(
      { ok: false, status: 500 },
    );
  });

  test("edison-jwt with full config but no token is a 401", async () => {
    const env = {
      AUTH_MODE: "edison-jwt",
      EDISON_JWKS_URL: "https://edison.example/.well-known/jwks.json",
      EDISON_JWT_ISSUER: "https://edison.example",
      EDISON_JWT_AUDIENCE: "x",
    };
    expect(await checkAuth(req(), env)).toMatchObject({ ok: false, status: 401 });
  });

  test("an unknown mode is rejected, never admitted", async () => {
    const result = await checkAuth(req(), { AUTH_MODE: "totally-made-up" });
    expect(result.ok).toBe(false);
  });

  test("an explicitly empty AUTH_MODE fails closed (500), never admits as open", async () => {
    // AUTH_MODE="" must not resolve to `open` and serve unauthenticated traffic.
    const result = await checkAuth(req({ authorization: "Bearer x" }), { AUTH_MODE: "" });
    expect(result).toMatchObject({ ok: false, status: 500 });
  });
});
