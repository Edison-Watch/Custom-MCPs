import { describe, expect, test } from "bun:test";

import {
  base64PayloadTooLarge,
  decodeBase64,
  generateKey,
  normalizeType,
  sanitizePrefix,
  slugify,
  sniffContentType,
  validateImage,
} from "../../src/images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("sniffContentType", () => {
  test("detects each allowed format by magic bytes", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(JPEG)).toBe("image/jpeg");
    expect(sniffContentType(GIF)).toBe("image/gif");
    expect(sniffContentType(WEBP)).toBe("image/webp");
  });

  test("rejects SVG and unknown bytes", () => {
    expect(sniffContentType(SVG)).toBeNull();
    expect(sniffContentType(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  test("requires the FULL png/gif signature, not just the ascii prefix", () => {
    // "\x89PNG" followed by the wrong trailing 4 bytes is not a real PNG.
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffContentType(fakePng)).toBeNull();
    // "GIF" but not "GIF87a"/"GIF89a".
    const fakeGif = new Uint8Array([0x47, 0x49, 0x46, 0x30, 0x30, 0x30]);
    expect(sniffContentType(fakeGif)).toBeNull();
  });
});

describe("normalizeType", () => {
  test("canonicalizes aliases and strips params", () => {
    expect(normalizeType("image/jpg")).toBe("image/jpeg");
    expect(normalizeType("IMAGE/PNG")).toBe("image/png");
    expect(normalizeType("image/webp; charset=binary")).toBe("image/webp");
    expect(normalizeType("png")).toBe("image/png");
    expect(normalizeType("image/svg+xml")).toBeNull();
  });
});

describe("decodeBase64", () => {
  test("round-trips bare base64", () => {
    expect([...decodeBase64(toBase64(PNG))]).toEqual([...PNG]);
  });

  test("handles data URLs and embedded whitespace", () => {
    const wrapped = `data:image/png;base64,${toBase64(PNG).slice(0, 4)}\n${toBase64(PNG).slice(4)}`;
    expect([...decodeBase64(wrapped)]).toEqual([...PNG]);
  });

  test("throws on invalid base64", () => {
    expect(() => decodeBase64("@@@not base64@@@!")).toThrow();
  });
});

describe("validateImage", () => {
  test("accepts a valid PNG", () => {
    const result = validateImage({ bytes: PNG });
    expect(result).toMatchObject({ contentType: "image/png", ext: "png" });
  });

  test("rejects empty payloads", () => {
    expect(validateImage({ bytes: new Uint8Array(0) })).toEqual({ error: "empty image payload" });
  });

  test("rejects oversize payloads", () => {
    const result = validateImage({ bytes: PNG, maxBytes: 4 });
    expect(result).toHaveProperty("error");
  });

  test("rejects SVG bytes", () => {
    expect(validateImage({ bytes: SVG })).toHaveProperty("error");
  });

  test("rejects a declared type that disagrees with the bytes", () => {
    const result = validateImage({ bytes: PNG, declaredType: "image/gif" });
    expect(result).toHaveProperty("error");
  });

  test("accepts a matching declared type (jpg alias)", () => {
    expect(validateImage({ bytes: JPEG, declaredType: "image/jpg" })).toMatchObject({
      contentType: "image/jpeg",
    });
  });

  test("rejects a declared type we can't normalize instead of silently sniffing", () => {
    // svg / html / garbage declarations are caller errors: fail, don't fall
    // back to the sniffed type as if the declaration were absent.
    expect(validateImage({ bytes: PNG, declaredType: "image/svg+xml" })).toHaveProperty("error");
    expect(validateImage({ bytes: PNG, declaredType: "text/html" })).toHaveProperty("error");
  });
});

describe("base64PayloadTooLarge", () => {
  test("passes payloads that could plausibly fit under the cap", () => {
    // ~1MB of base64 chars, cap 10 MiB -> comfortably under.
    expect(base64PayloadTooLarge("a".repeat(1_000_000), 10 * 1024 * 1024)).toBe(false);
  });

  test("rejects payloads that cannot fit even at best packing", () => {
    // 1MB of base64 decodes to ~750KB, over a 4-byte cap.
    expect(base64PayloadTooLarge("a".repeat(1_000_000), 4)).toBe(true);
  });

  test("allows slack for line-wrap newlines and a data: prefix", () => {
    // A payload exactly at the char-count for maxBytes plus modest wrapping
    // must not be rejected by the pre-decode guard.
    const maxBytes = 1024;
    const exactChars = Math.ceil(maxBytes / 3) * 4;
    expect(base64PayloadTooLarge("a".repeat(exactChars + 40), maxBytes)).toBe(false);
  });
});

describe("slugify", () => {
  test("drops extension, lowercases, collapses separators", () => {
    expect(slugify("My Screenshot (v2).PNG")).toBe("my-screenshot-v2");
  });

  test("caps length and falls back when empty", () => {
    expect(slugify("!!!.png")).toBe("image");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("sanitizePrefix", () => {
  test("defaults when missing", () => {
    expect(sanitizePrefix(undefined)).toBe("img");
    expect(sanitizePrefix("")).toBe("img");
  });

  test("neutralizes path traversal and leading slashes", () => {
    expect(sanitizePrefix("../../etc")).not.toContain("..");
    expect(sanitizePrefix("/screenshots/")).toBe("screenshots");
    expect(sanitizePrefix("a//b")).toBe("a/b");
  });
});

describe("generateKey", () => {
  test("produces an unguessable, well-formed key", () => {
    const key = generateKey({ ext: "png", filename: "hello world.png", prefix: "shots" });
    expect(key).toMatch(/^shots\/[0-9a-f]{16}-hello-world\.png$/);
  });

  test("two keys never collide", () => {
    const a = generateKey({ ext: "png" });
    const b = generateKey({ ext: "png" });
    expect(a).not.toBe(b);
  });
});
