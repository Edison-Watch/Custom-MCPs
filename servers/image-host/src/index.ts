/**
 * image-host - an Edison first-party MCP server.
 *
 * Accepts an image as base64 (the server is remote and cannot read a caller's
 * filesystem) and returns a public, non-expiring URL suitable for embedding in
 * Markdown, a GitHub issue, or a chat message. Storage is Cloudflare R2 via a
 * binding (no S3 keys in code); the Worker also serves the stored objects at
 * `/i/<key>` so a fresh deploy needs no public-bucket setup.
 *
 * Transport: streamable HTTP at `/mcp` (McpAgent / Durable Object).
 * Auth: pluggable (see ./auth); v1 ships `bearer`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import { checkAuth } from "./auth";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  base64PayloadTooLarge,
  decodeBase64,
  generateKey,
  isDeleteAuthorized,
  validateImage,
} from "./images";

export interface Env {
  IMAGE_BUCKET: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  AUTH_MODE?: string;
  // edison-jwt mode (see ./auth, ./jwt): JWKS source + claims to enforce.
  EDISON_JWKS_URL?: string;
  EDISON_JWT_ISSUER?: string;
  EDISON_JWT_AUDIENCE?: string;
  PUBLIC_BASE_URL?: string;
  MAX_UPLOAD_BYTES?: string;
  KEY_PREFIX?: string;
}

const IMAGE_PATH_PREFIX = "/i/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Request-scoped data injected by the fetch handler into the Durable Object. */
interface Props extends Record<string, unknown> {
  /** Origin the client connected on, used as the URL base when PUBLIC_BASE_URL is unset. */
  baseUrl?: string;
  /**
   * Authenticated caller identity (the JWT `sub` under edison-jwt; a constant
   * like "bearer"/"anonymous" in single-tenant modes). Recorded as the object
   * owner on upload and enforced on delete so one caller cannot delete another's
   * image. Resolved by `checkAuth` before any tool runs.
   */
  subject?: string;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  // `Number` (not `parseInt`) so lenient junk like "10MB" is rejected as bad
  // config instead of silently truncating to 10.
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Absolute base for returned URLs, e.g. `https://image-host.acme.workers.dev`. */
function resolvePublicBase(env: Env): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function textError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

export class ImageHostMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "image-host", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "upload_image",
      {
        description:
          "Upload an image (PNG/JPEG/WebP/GIF) and get back a public, non-expiring URL you can " +
          "embed in Markdown, a GitHub issue, or a chat message. The server is remote and cannot " +
          "read local files, so send the image content as base64 (a `data:` URL is also accepted).",
        inputSchema: {
          content_base64: z.string().describe("Base64-encoded image bytes, or a full `data:` URL."),
          filename: z.string().optional().describe("Original filename; used only to build a readable slug."),
          content_type: z
            .string()
            .optional()
            .describe("MIME type such as image/png. Verified against the actual bytes."),
          prefix: z.string().optional().describe("Optional key prefix / folder, e.g. 'screenshots'."),
        },
        outputSchema: {
          url: z.string().describe("Public URL of the uploaded image."),
          key: z.string().describe("Storage key; pass to delete_image to remove it."),
          bytes: z.number().describe("Size of the stored image in bytes."),
          content_type: z.string().describe("Detected MIME type."),
        },
      },
      async ({ content_base64, filename, content_type, prefix }) => {
        // Resolve the absolute base up front: the tool's whole promise is an
        // embeddable URL, so if we can't build one, fail loud rather than hand
        // back a broken relative path. Explicit PUBLIC_BASE_URL wins (e.g. a
        // custom domain); otherwise fall back to the origin the client
        // connected on, injected via props by the fetch handler.
        const base = resolvePublicBase(this.env) ?? this.props?.baseUrl ?? null;
        if (!base) {
          return textError(
            "server misconfigured: could not resolve a public base URL (set PUBLIC_BASE_URL)",
          );
        }

        const maxBytes = parsePositiveInt(this.env.MAX_UPLOAD_BYTES) ?? DEFAULT_MAX_UPLOAD_BYTES;
        // Reject oversized inputs before decoding to avoid the ~3x allocation.
        if (base64PayloadTooLarge(content_base64, maxBytes)) {
          return textError(`image exceeds the ${maxBytes}-byte limit`);
        }

        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(content_base64);
        } catch {
          return textError("content_base64 is not valid base64");
        }

        const validated = validateImage({ bytes, declaredType: content_type, maxBytes });
        if ("error" in validated) return textError(validated.error);

        const key = generateKey({ ext: validated.ext, filename, prefix: prefix ?? this.env.KEY_PREFIX });

        // Record who uploaded this object so delete_image can enforce ownership.
        // customMetadata is private R2 metadata - serveImage only writes
        // httpMetadata, so the owner is never exposed on the public URL.
        //
        // Fail closed if the subject is missing. checkAuth always resolves one
        // (open mode included, as "anonymous"), and the fetch handler always
        // injects it, so an absent subject here is a broken invariant - props
        // failed to propagate - not a caller we may stamp with a default
        // identity. Defaulting would let a plumbing bug collapse every caller to
        // one owner and silently enable cross-caller deletion.
        const owner = this.props?.subject;
        if (!owner) return textError("server misconfigured: authenticated subject missing");
        await this.env.IMAGE_BUCKET.put(key, validated.bytes, {
          httpMetadata: { contentType: validated.contentType, cacheControl: IMMUTABLE_CACHE },
          customMetadata: { owner },
        });

        const url = `${base}${IMAGE_PATH_PREFIX}${key}`;
        const structuredContent = {
          url,
          key,
          bytes: validated.bytes.length,
          content_type: validated.contentType,
        };
        return {
          content: [{ type: "text" as const, text: `Uploaded ${validated.bytes.length} bytes -> ${url}` }],
          structuredContent,
        };
      },
    );

    this.server.registerTool(
      "delete_image",
      {
        description:
          "Delete a previously uploaded image by the key returned from upload_image. " +
          "You can only delete images you uploaded.",
        inputSchema: { key: z.string().describe("The storage key returned by upload_image.") },
        outputSchema: { deleted: z.boolean(), key: z.string() },
      },
      async ({ key }) => {
        // R2 `delete` is a no-op on a missing key and resolves either way, so
        // head first: it reports honest existence AND carries the owner metadata
        // we need for the authorization check - no extra R2 round-trip.
        const head = await this.env.IMAGE_BUCKET.head(key);
        if (head === null) {
          return {
            content: [{ type: "text" as const, text: `No object found for ${key}` }],
            structuredContent: { deleted: false, key },
          };
        }
        // Same fail-closed contract as upload: a missing subject is a broken
        // invariant, never a caller to default to a shared identity.
        const caller = this.props?.subject;
        if (!caller) return textError("server misconfigured: authenticated subject missing");
        if (!isDeleteAuthorized(head.customMetadata?.owner, caller)) {
          // Refuse without echoing the real owner, so this isn't an ownership
          // oracle. The key is not a secret that could stand in for this check -
          // it lives in the public image URL - so authorization is what guards
          // deletion, not knowledge of the key.
          return textError(`not authorized to delete ${key}`);
        }
        await this.env.IMAGE_BUCKET.delete(key);
        return {
          content: [{ type: "text" as const, text: `Deleted ${key}` }],
          structuredContent: { deleted: true, key },
        };
      },
    );
  }
}

/** Serve a stored object straight from R2 (Mode A: no public bucket required). */
async function serveImage(rawKey: string, env: Env): Promise<Response> {
  if (!rawKey) return new Response("Not found", { status: 404 });
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // Malformed percent-encoding (e.g. `/i/%ZZ`) - treat as a missing object,
    // not a 500 on this public unauthenticated endpoint.
    return new Response("Not found", { status: 404 });
  }
  const object = await env.IMAGE_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", IMMUTABLE_CACHE);
  // Defense-in-depth: we serve user-supplied bytes from the app origin, so pin
  // the declared (byte-sniffed) content type and forbid MIME sniffing.
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "image-host" });
    }

    if (request.method === "GET" && url.pathname.startsWith(IMAGE_PATH_PREFIX)) {
      return serveImage(url.pathname.slice(IMAGE_PATH_PREFIX.length), env);
    }

    if (url.pathname === "/mcp") {
      const auth = await checkAuth(request, env);
      if (!auth.ok) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (auth.status === 401) headers["www-authenticate"] = 'Bearer realm="image-host"';
        return new Response(JSON.stringify({ error: auth.message }), { status: auth.status, headers });
      }
      // Inject the connected origin so upload_image can build absolute URLs
      // without requiring PUBLIC_BASE_URL to be configured first, plus the
      // authenticated subject so upload can stamp ownership and delete can
      // enforce it.
      (ctx as ExecutionContext & { props?: Props }).props = { baseUrl: url.origin, subject: auth.subject };
      return ImageHostMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
