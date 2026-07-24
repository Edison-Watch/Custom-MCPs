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
  test("open mode admits everyone", () => {
    expect(checkAuth(req(), {})).toMatchObject({ ok: true, mode: "open", subject: "anonymous" });
  });

  test("bearer mode: missing, wrong, and correct tokens", () => {
    const env = { AUTH_TOKEN: "s3cret" };
    expect(checkAuth(req(), env)).toMatchObject({ ok: false, status: 401 });
    expect(checkAuth(req({ authorization: "Bearer nope" }), env)).toMatchObject({ ok: false, status: 401 });
    expect(checkAuth(req({ authorization: "Bearer s3cret" }), env)).toMatchObject({
      ok: true,
      subject: "bearer",
    });
  });

  test("bearer mode with no configured token is a 500 misconfig", () => {
    expect(checkAuth(req({ authorization: "Bearer x" }), { AUTH_MODE: "bearer" })).toMatchObject({
      ok: false,
      status: 500,
    });
  });

  test("edison-jwt is not implemented yet (501)", () => {
    expect(checkAuth(req(), { AUTH_MODE: "edison-jwt" })).toMatchObject({ ok: false, status: 501 });
  });

  test("an unknown mode is rejected, never admitted", () => {
    const result = checkAuth(req(), { AUTH_MODE: "totally-made-up" });
    expect(result.ok).toBe(false);
  });
});
