import { SELF, env } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const AUTH = "Bearer test-token";
// 12 bytes: PNG signature + filler - enough for magic-byte sniffing + round-trip.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

type Era = "legacy" | "modern";

// A real SDK 2.x client driven through the Worker (SELF.fetch). "modern" pins
// the 2026-07-28 per-request protocol (server/discover, no handshake);
// "legacy" is the plain 2025 `initialize` sequence served statelessly.
async function connect(era: Era): Promise<Client> {
  const client = new Client(
    { name: "test", version: "1.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { authorization: AUTH } },
    fetch: (input, init) => SELF.fetch(input as string, init),
  });
  await client.connect(transport);
  return client;
}

type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
};

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
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

describe("request body bound", () => {
  // The SDK handler's maxRequestBodySize only bounds the 2026-07-28 lane, so a
  // 2025-era (legacy-classified) body must be refused by our own bound too.
  for (const [label, extra, body] of [
    ["modern lane", {}, { jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(4 * 1024 * 1024 + 1) }],
    [
      "legacy lane",
      { "mcp-protocol-version": "2025-06-18" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4 * 1024 * 1024 + 1) } },
    ],
  ] as const) {
    it(`413s a just-over-bound body on the ${label}`, async () => {
      const res = await SELF.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: AUTH,
          ...extra,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(413);
    });
  }
});

for (const era of ["modern", "legacy"] as const) {
  describe(`MCP tools (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    it("lists both tools with input and output schemas", async () => {
      const { tools } = await client.listTools();
      const upload = tools.find((t) => t.name === "upload_image");
      const del = tools.find((t) => t.name === "delete_image");
      expect(upload?.inputSchema.properties).toHaveProperty("content_base64");
      expect(upload?.outputSchema?.properties).toHaveProperty("url");
      expect(del?.inputSchema.properties).toHaveProperty("key");
      expect(del?.outputSchema?.properties).toHaveProperty("deleted");
    });

    it("upload_image stores an image and serves it back via an origin-derived absolute URL", async () => {
      const result = await callTool(client, "upload_image", {
        content_base64: toBase64(PNG_BYTES),
        filename: "shot.png",
      });
      const structured = result.structuredContent;
      expect(structured).toBeTruthy();
      // PUBLIC_BASE_URL is empty in the test env, so the URL must derive from the
      // connected origin (the props passed to buildServer).
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
      const result = await callTool(client, "upload_image", { content_base64: toBase64(svg) });
      expect(result.isError).toBe(true);
    });

    it("delete_image reports deleted:false for a key that never existed", async () => {
      const result = await callTool(client, "delete_image", { key: "img/does-not-exist.png" });
      expect(result.structuredContent).toMatchObject({ deleted: false, key: "img/does-not-exist.png" });
    });

    it("upload_image stamps the authenticated caller as the object owner", async () => {
      const uploaded = await callTool(client, "upload_image", {
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
      const uploaded = await callTool(client, "upload_image", {
        content_base64: toBase64(PNG_BYTES),
        filename: "to-delete.png",
      });
      const key = uploaded.structuredContent.key as string;
      expect(key).toBeTruthy();

      const del = await callTool(client, "delete_image", { key });
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

      const result = await callTool(client, "delete_image", { key });
      expect(result.isError).toBe(true);
      // Pin the *ownership* refusal specifically: delete_image also errors on the
      // fail-closed "subject missing" branch, so assert the message so a plumbing
      // error can't masquerade as a passing ownership test.
      expect(result.content?.[0]?.text).toContain("not authorized");
      // Refusal must not delete: the object is still there.
      expect(await env.IMAGE_BUCKET.head(key)).not.toBeNull();
    });
  });
}
