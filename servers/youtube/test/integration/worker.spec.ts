import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const AUTH = "Bearer test-token";

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

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "youtube" });
  });

  it("unknown path is 404", async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope`)).status).toBe(404);
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
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer nope",
      },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });
});

describe("request body bound", () => {
  // The SDK handler's maxRequestBodySize only bounds the 2026-07-28 lane, so a
  // 2025-era (legacy-classified) body must be refused by our own bound too.
  for (const [label, extra, body] of [
    ["modern lane", {}, { jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(1024 * 1024 + 1) }],
    [
      "legacy lane",
      { "mcp-protocol-version": "2025-06-18" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1024 * 1024 + 1) } },
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
  describe(`youtube_scrape tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    it("lists the tool with input and output schemas", async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "youtube_scrape");
      expect(tool?.inputSchema.properties).toHaveProperty("search");
      expect(tool?.outputSchema?.properties).toHaveProperty("videos");
    });

    // The test env sets no APIFY_TOKEN, so the tool fails closed at the misconfig
    // guard - exercising the full MCP transport + tool registration + guard with
    // no live Apify call (the live scrape path is covered manually against the
    // real Actors, and the pure mapping logic by test/unit/youtube.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await client.callTool({ name: "youtube_scrape", arguments: { search: "rust" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no search and no start_urls", async () => {
      const result = await client.callTool({ name: "youtube_scrape", arguments: {} });
      expect(result.isError).toBe(true);
    });
  });
}
