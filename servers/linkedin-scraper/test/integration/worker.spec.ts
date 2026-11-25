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

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return result as { isError?: boolean; content?: { text?: string }[] };
}

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "linkedin" });
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
  describe(`tool listing (${era} protocol)`, () => {
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
      expect(tools.map((t) => t.name).sort()).toEqual([
        "linkedin_company",
        "linkedin_profile",
        "linkedin_profile_search",
        "linkedin_scrape",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.properties).toHaveProperty("count");
      }
    });
  });

  describe(`linkedin_scrape tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // The test env sets no APIFY_TOKEN, so the tool fails closed at the misconfig
    // guard - exercising the full MCP transport + tool registration + guard with
    // no live Apify call (the pure mapping logic is covered by
    // test/unit/linkedin.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "linkedin_scrape", { search: "b2b sales" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no search and no start_urls", async () => {
      const result = await callTool(client, "linkedin_scrape", {});
      expect(result.isError).toBe(true);
    });
  });

  describe(`linkedin_profile_search tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // Same rationale as linkedin_scrape: no APIFY_TOKEN in the test env, so the
    // tool fails closed at the misconfig guard (pure logic is covered by
    // test/unit/profile.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "linkedin_profile_search", { search: "growth lead" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no query and no filters", async () => {
      const result = await callTool(client, "linkedin_profile_search", {});
      expect(result.isError).toBe(true);
    });

    it("rejects a call whose only signal is a boolean refinement", async () => {
      const result = await callTool(client, "linkedin_profile_search", { recently_posted: true });
      expect(result.isError).toBe(true);
    });
  });

  describe(`linkedin_profile tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // Same rationale: no APIFY_TOKEN in the test env, so the tool fails closed at
    // the misconfig guard (pure logic is covered by test/unit/profile_hydrate.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "linkedin_profile", {
        profile_urls: ["https://www.linkedin.com/in/williamhgates"],
      });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no profile_urls", async () => {
      const result = await callTool(client, "linkedin_profile", {});
      expect(result.isError).toBe(true);
    });

    it("rejects a profile_urls entry that is not a LinkedIn URL", async () => {
      const result = await callTool(client, "linkedin_profile", {
        profile_urls: ["https://evil.com/in/x"],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe(`linkedin_company tool (${era} protocol)`, () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect(era);
    });
    afterAll(async () => {
      await client.close();
    });

    // Same rationale: no APIFY_TOKEN in the test env, so the tool fails closed at
    // the misconfig guard (pure logic is covered by test/unit/company.test.ts).
    it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
      const result = await callTool(client, "linkedin_company", { names: ["OpenAI"] });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
    });

    it("rejects a call with no company_urls and no names", async () => {
      const result = await callTool(client, "linkedin_company", {});
      expect(result.isError).toBe(true);
    });

    it("rejects a company_urls entry that is not a LinkedIn URL", async () => {
      const result = await callTool(client, "linkedin_company", {
        company_urls: ["https://evil.com/company/x"],
      });
      expect(result.isError).toBe(true);
    });
  });
}
