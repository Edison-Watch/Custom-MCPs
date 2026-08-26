import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const AUTH = "Bearer test-token";
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: AUTH,
};

// 12 bytes: PNG signature + filler - enough for magic-byte sniffing + round-trip.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Streamable-HTTP replies are SSE (`data: {json}\n\n`). Pull the first JSON-RPC
// message carrying a result/error out of the buffered stream so far.
function extractMessage(buffer: string): Record<string, any> | null {
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice("data:".length).trim();
    if (!json) continue;
    try {
      const msg = JSON.parse(json);
      if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg;
    } catch {
      // JSON split across chunks - wait for the next read.
    }
  }
  return null;
}

async function initSession(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  // NB: the initialize response is a long-lived SSE stream - do not read it to
  // completion (it never ends) and do not cancel it (that aborts the session).
  // Leaving it open holds one connection; we establish exactly one session for
  // the whole file to keep that to a single held connection.
  const notif = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await notif.text();
  return sessionId!;
}

async function callTool(sessionId: string, name: string, args: Record<string, unknown>) {
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  // Read only until the result event arrives, then stop - the response SSE
  // stream otherwise stays open until an idle timeout (~10s).
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const msg = extractMessage(buffer);
      if (msg) return (msg.result ?? {}) as Record<string, any>;
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error("no JSON-RPC result found in SSE response");
}

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "image-host" });
  });

  it("unknown path is 404", async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope`)).status).toBe(404);
  });

  it("malformed image key percent-encoding is 404, not 500", async () => {
    expect((await SELF.fetch(`${ORIGIN}/i/%ZZ`)).status).toBe(404);
  });
});

describe("auth gate on /mcp", () => {
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  it("rejects a request with no bearer token (401 + WWW-Authenticate)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initBody,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token (401)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer nope" },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });
});

describe("MCP tools", () => {
  // One session, reused across the tool tests (see vitest.config isolatedStorage).
  let sessionId: string;
  beforeAll(async () => {
    sessionId = await initSession();
  });

  it("upload_image stores an image and serves it back via an origin-derived absolute URL", async () => {
    const result = await callTool(sessionId, "upload_image", {
      content_base64: toBase64(PNG_BYTES),
      filename: "shot.png",
    });
    const structured = result.structuredContent;
    expect(structured).toBeTruthy();
    // PUBLIC_BASE_URL is empty in the test env, so the URL must derive from the
    // connected origin (the ctx.props path).
    expect(structured.url).toMatch(/^https:\/\/example\.com\/i\/img\/[0-9a-f]{16}-shot\.png$/);
    expect(structured.content_type).toBe("image/png");
    expect(structured.bytes).toBe(PNG_BYTES.length);

    const served = await SELF.fetch(structured.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...PNG_BYTES]);
  });

  it("upload_image rejects an SVG payload with a tool error", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const result = await callTool(sessionId, "upload_image", { content_base64: toBase64(svg) });
    expect(result.isError).toBe(true);
  });

  it("delete_image reports deleted:false for a key that never existed", async () => {
    const result = await callTool(sessionId, "delete_image", { key: "img/does-not-exist.png" });
    expect(result.structuredContent).toMatchObject({ deleted: false, key: "img/does-not-exist.png" });
  });

  it("upload_image stamps the authenticated caller as the object owner", async () => {
    const uploaded = await callTool(sessionId, "upload_image", {
      content_base64: toBase64(PNG_BYTES),
      filename: "owned.png",
    });
    const key = uploaded.structuredContent.key as string;
    // Ownership is recorded in private R2 customMetadata (never on the URL). The
    // test env runs bearer mode, so every caller's subject is "bearer".
    const stored = await env.IMAGE_BUCKET.head(key);
    expect(stored?.customMetadata?.owner).toBe("bearer");
  });

  it("delete_image removes an image the same caller uploaded, then it 404s", async () => {
    const uploaded = await callTool(sessionId, "upload_image", {
      content_base64: toBase64(PNG_BYTES),
      filename: "to-delete.png",
    });
    const key = uploaded.structuredContent.key as string;
    expect(key).toBeTruthy();

    const del = await callTool(sessionId, "delete_image", { key });
    expect(del.structuredContent).toMatchObject({ deleted: true, key });

    // The object is gone: the previously-working URL now 404s.
    expect((await SELF.fetch(uploaded.structuredContent.url)).status).toBe(404);
  });

  it("delete_image refuses a caller who does not own the object", async () => {
    // Seed an object owned by a DIFFERENT subject than the bearer test caller.
    // (Bearer mode collapses every request to subject "bearer", so we can't get
    // a second real subject through the transport - stamp the owner directly.)
    const key = "img/owned-by-another-user.png";
    await env.IMAGE_BUCKET.put(key, PNG_BYTES, { customMetadata: { owner: "another-user" } });

    const result = await callTool(sessionId, "delete_image", { key });
    expect(result.isError).toBe(true);
    // Refusal must not delete: the object is still there.
    expect(await env.IMAGE_BUCKET.head(key)).not.toBeNull();
  });
});
