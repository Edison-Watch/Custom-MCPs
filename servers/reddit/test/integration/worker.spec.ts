import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const AUTH = "Bearer test-token";
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: AUTH,
};

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

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
}

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "reddit" });
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

  it("413s an oversized body before it reaches the MCP handler", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(2 * 1024 * 1024) } }),
    });
    expect(res.status).toBe(413);
  });

  // The handler's own maxRequestBodySize only bounds the 2026-07-28 lane; a
  // 2025-era body above our 1 MiB (but under the SDK's 4 MiB default) must
  // still be refused, on both the modern-classified and legacy-classified paths.
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
        headers: { ...MCP_HEADERS, ...extra },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(413);
    });
  }
});

for (const era of ["modern", "legacy"] as const) {
  describe(`tool listing (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    it("lists all three tools with input and output schemas", async () => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.reddit_scrape?.inputSchema.properties).toHaveProperty("search");
      expect(byName.reddit_scrape?.outputSchema?.properties).toHaveProperty("items");
      expect(byName.reddit_scrape_start?.inputSchema.properties).toHaveProperty("search");
      expect(byName.reddit_scrape_start?.outputSchema?.properties).toHaveProperty("run_id");
      expect(byName.reddit_scrape_fetch?.inputSchema.properties).toHaveProperty("run_id");
      expect(byName.reddit_scrape_fetch?.outputSchema?.properties).toHaveProperty("status");
    });
  });

  describe(`reddit_scrape tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    // The test env sets no APIFY_TOKEN, so the tool fails closed at the misconfig
    // guard - exercising the full MCP transport + tool registration + guard with
    // no live Apify call (the live scrape path is covered by the Python service's
    // e2e and the pure mapping logic by test/unit/reddit.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "reddit_scrape", { search: "rust" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no search and no start_urls", async () => {
      const result = await callTool(client, "reddit_scrape", {});
      expect(result.isError).toBe(true);
    });
  });

  describe(`reddit_scrape_start tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    // No APIFY_TOKEN in the test env, so the async start also fails closed at the
    // misconfig guard - exercising registration + guard over the full transport
    // with no live Apify call (the run-parse logic is covered by the unit tests).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "reddit_scrape_start", { search: "rust" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no search and no start_urls", async () => {
      const result = await callTool(client, "reddit_scrape_start", {});
      expect(result.isError).toBe(true);
    });
  });

  describe(`reddit_scrape_fetch tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });

    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "reddit_scrape_fetch", { run_id: "RUN123" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no run_id", async () => {
      const result = await callTool(client, "reddit_scrape_fetch", {});
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("run_id");
    });
  });
}
