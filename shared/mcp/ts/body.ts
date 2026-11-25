// Bounded read of an MCP POST body, shared by every Worker in the fleet.
//
// The SDK 2.x handler's `maxRequestBodySize` only bounds the 2026-07-28 lane:
// agents 0.34.1 routes 2025-era (`initialize`) requests to its stateless legacy
// fallback without forwarding the option, so that lane falls back to the SDK
// default (4 MiB). Reading the body here, once, bounds both eras the same way
// (CVE-2026-111768). Dependency-free so shared/ needs no node_modules.

/** JSON-RPC 413 reply, matching the SDK handler's own over-limit response. */
export function bodyTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: `Payload Too Large: Request body must not exceed ${maxBytes} bytes` },
      id: null,
    },
    { status: 413 },
  );
}

/**
 * Read `request`'s body, stopping as soon as it exceeds `maxBytes` (counted on
 * the bytes actually received, not a declared Content-Length). Returns a 413
 * Response when over the bound, else an equivalent Request with the buffered
 * body. Non-POST requests pass through untouched.
 */
export async function boundRequestBody(request: Request, maxBytes: number): Promise<Request | Response> {
  if (request.method !== "POST" || request.body === null) return request;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body.cancel().catch(() => {});
    return bodyTooLargeResponse(maxBytes);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return bodyTooLargeResponse(maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body });
}
