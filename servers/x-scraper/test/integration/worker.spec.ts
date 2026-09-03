import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const AUTH = "Bearer test-token";
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: AUTH,
};

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
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const msg = extractMessage(buffer);
      // Surface a JSON-RPC error (unknown tool, invalid params) instead of
      // mapping it to {}, so an assertion failure names the real cause.
      if (msg) return (msg.result ?? msg.error ?? {}) as Record<string, any>;
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

describe("x_scrape tool", () => {
  let sessionId: string;
  beforeAll(async () => {
    sessionId = await initSession();
  });

  // The test env sets no APIFY_TOKEN, so the tool fails closed at the misconfig
  // guard - exercising the full MCP transport + tool registration + guard with
  // no live Apify call (the pure mapping logic is covered by test/unit/x.test.ts).
  it("fails closed with a clear error when APIFY_TOKEN is unset", async () => {
    const result = await callTool(sessionId, "x_scrape", { search: "apify" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("APIFY_TOKEN");
  });

  it("rejects a call with no search and no from_user", async () => {
    const result = await callTool(sessionId, "x_scrape", {});
    expect(result.isError).toBe(true);
  });
});
