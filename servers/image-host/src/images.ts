/**
 * Pure, runtime-agnostic helpers for the image-host MCP server.
 *
 * Nothing here touches Cloudflare bindings or the MCP SDK on purpose: the
 * upload path's real decisions (what counts as a valid image, what key it gets)
 * are the part worth unit-testing, and keeping them dependency-free lets
 * `bun test` exercise them offline with no workerd / node_modules.
 */

/** Content types we accept, mapped to their canonical file extension. */
export const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Reverse map used to normalize a caller-declared type or a filename ext. */
export const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface ValidatedImage {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

export interface ValidationError {
  error: string;
}

/**
 * Decode base64 image content. Accepts a bare base64 string or a full
 * `data:image/png;base64,....` data URL, and tolerates embedded whitespace /
 * newlines (common when base64 is line-wrapped). Throws on invalid base64.
 */
export function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(",");
  const raw = input.startsWith("data:") && comma !== -1 ? input.slice(comma + 1) : input;
  const cleaned = raw.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Cheap pre-decode size guard. Base64 for N bytes is ~ceil(N/3)*4 characters,
 * so an input far larger than that can't possibly fit under `maxBytes` (short
 * of being mostly whitespace, which is itself abuse). Rejecting here avoids the
 * ~3x peak allocation that `atob` + the byte copy would otherwise incur before
 * the exact post-decode check in `validateImage` ever runs. Slack: +10% for
 * line-wrap newlines, +64 for a `data:` URL prefix.
 */
export function base64PayloadTooLarge(input: string, maxBytes: number): boolean {
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  return input.length > maxChars + Math.ceil(maxChars * 0.1) + 64;
}

/**
 * Identify an image by its magic bytes. This is the security-relevant check:
 * we trust the bytes, not the caller's declared content type, so a caller
 * cannot smuggle an SVG/HTML payload behind an `image/png` label. Returns null
 * for anything not on the allowlist (SVG included - it has no binary magic and
 * is an XSS vector when served inline).
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 && // "\x89PNG"
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a // full 8-byte PNG signature (CRLF/EOF/LF), not just "PNG"
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 && // "GIF8"
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61 // full "GIF87a" / "GIF89a" signature, not just "GIF"
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Normalize a caller-declared MIME type to one of our canonical types. */
export function normalizeType(raw: string): string | null {
  const lower = raw.trim().toLowerCase().split(";")[0].trim();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower in EXT_BY_TYPE) return lower;
  if (lower in TYPE_BY_EXT) return TYPE_BY_EXT[lower];
  return null;
}

export interface ValidateArgs {
  bytes: Uint8Array;
  declaredType?: string;
  maxBytes?: number;
}

/**
 * Validate decoded image bytes: non-empty, under the size cap, a recognized
 * format, and (if the caller declared a content type) that the declaration
 * agrees with the sniffed bytes.
 */
export function validateImage(args: ValidateArgs): ValidatedImage | ValidationError {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (args.bytes.length === 0) return { error: "empty image payload" };
  if (args.bytes.length > maxBytes) {
    return { error: `image is ${args.bytes.length} bytes, over the ${maxBytes}-byte limit` };
  }

  const sniffed = sniffContentType(args.bytes);
  if (!sniffed) {
    return { error: "unrecognized image format (allowed: png, jpeg, webp, gif; svg is rejected)" };
  }

  if (args.declaredType !== undefined) {
    // `!== undefined` (not truthiness): an explicitly-supplied empty string is a
    // declaration too, and must be rejected like any other unsupported value -
    // not silently treated as "omitted" and served under the sniffed type.
    const declared = normalizeType(args.declaredType);
    if (!declared) {
      // A declared type we can't normalize (svg, html, garbage) is a caller
      // error: reject it rather than silently serving under the sniffed type.
      return { error: `unsupported declared content_type '${args.declaredType}'` };
    }
    if (declared !== sniffed) {
      return { error: `declared content_type ${declared} does not match the actual bytes (${sniffed})` };
    }
  }

  return { bytes: args.bytes, contentType: sniffed, ext: EXT_BY_TYPE[sniffed] };
}

/** Turn a filename into a short, URL-safe slug (extension dropped). */
export function slugify(name: string, fallback = "image"): string {
  const base = name.replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Clean a caller-supplied key prefix. Prevents path traversal (`..`), strips
 * leading/trailing slashes, and restricts to a safe charset while still
 * allowing nested prefixes like `screenshots/2026`.
 */
export function sanitizePrefix(prefix: string | undefined, fallback = "img"): string {
  if (!prefix) return fallback;
  const cleaned = prefix
    .toLowerCase()
    .replace(/\.{2,}/g, "") // kill `..` before it can form a traversal
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[/-]+|[/-]+$/g, "");
  return cleaned || fallback;
}

/** Cryptographically-random hex, `nBytes * 2` characters. */
export function randomHex(nBytes = 8): string {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface KeyArgs {
  ext: string;
  filename?: string;
  prefix?: string;
}

/**
 * Build an unguessable object key: `${prefix}/${16-hex}-${slug}.${ext}`.
 * Obscurity is the privacy model - there is no listing endpoint - so the random
 * component must stay in the key.
 */
export function generateKey(args: KeyArgs): string {
  const prefix = sanitizePrefix(args.prefix);
  const slug = slugify(args.filename ?? "");
  return `${prefix}/${randomHex(8)}-${slug}.${args.ext}`;
}
