import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

// First text block of a tool result (the SDK types `content` as a union).
function text(result: { content?: unknown }): string | undefined {
  return (result.content as { text?: string }[] | undefined)?.[0]?.text;
}

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "x" });
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
    ["no protocol header", {}, { jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(1024 * 1024 + 1) }],
    [
      "2025-era protocol header",
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
  describe(`tools/list (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    it("lists every tool with input and output schemas", async () => {
      const { tools } = await client.listTools();
      // Input schemas stay closed, as under SDK 1.x (zod 4 omits it by default).
      for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get("x_scrape")?.inputSchema.properties).toHaveProperty("search");
      expect(byName.get("x_scrape")?.outputSchema?.properties).toHaveProperty("items");
      expect(byName.get("x_profile")?.inputSchema.properties).toHaveProperty("handles");
      expect(byName.get("x_profile")?.outputSchema?.properties).toHaveProperty("not_found");
      expect(byName.get("x_engagers")?.inputSchema.properties).toHaveProperty("tweet_id");
      expect(byName.get("x_engagers")?.outputSchema?.properties).toHaveProperty("engagers");
    });
  });

  describe(`x_scrape tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // The test env sets no APIFY_TOKEN, so the tool fails closed at the misconfig
    // guard - exercising the full MCP transport + tool registration + guard with
    // no live Apify call (the pure mapping logic is covered by test/unit/x.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await client.callTool({ name: "x_scrape", arguments: { search: "apify" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no search and no from_user", async () => {
      const result = await client.callTool({ name: "x_scrape", arguments: {} });
      expect(result.isError).toBe(true);
    });

    it("rejects an unparseable date bound before running a scrape", async () => {
      const result = await client.callTool({ name: "x_scrape", arguments: { search: "apify", since: "2024-02-30" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("invalid 'since' date");
    });
  });

  describe(`x_profile tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // Same rationale as x_scrape: no APIFY_TOKEN in the test env, so the tool fails
    // closed at the misconfig guard (pure logic is covered by test/unit/profile.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await client.callTool({ name: "x_profile", arguments: { handles: ["openai"] } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("APIFY_TOKEN");
    });

    it("answers a malformed-only lookup with not_found, without a run", async () => {
      // Runs before the APIFY_TOKEN guard: nothing here can match an account.
      const result = await client.callTool({
        name: "x_profile",
        arguments: {
          handles: ["foo.bar"],
          profile_urls: ["https://x.com/this_handle_is_way_too_long"],
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        count: 0,
        profiles: [],
        not_found: ["foo.bar", "https://x.com/this_handle_is_way_too_long"],
      });
    });

    it("rejects a call with no handles and no profile_urls", async () => {
      const result = await client.callTool({ name: "x_profile", arguments: {} });
      expect(result.isError).toBe(true);
    });

    it("rejects profile_urls with no resolvable handle (tweet permalink)", async () => {
      const result = await client.callTool({
        name: "x_profile",
        arguments: {
          profile_urls: ["https://x.com/openai/status/1"],
        },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("no resolvable");
    });

    it("rejects a combined target count over the cap (per-field limits stay under it)", async () => {
      // 40 handles + 40 urls: each field is <= the 50 per-field schema cap, but
      // the 80 combined unique targets exceed the per-call limit.
      const handles = Array.from({ length: 40 }, (_, i) => `user${i}`);
      const profile_urls = Array.from({ length: 40 }, (_, i) => `https://x.com/acct${i}`);
      const result = await client.callTool({ name: "x_profile", arguments: { handles, profile_urls } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("too many targets");
    });
  });
}
