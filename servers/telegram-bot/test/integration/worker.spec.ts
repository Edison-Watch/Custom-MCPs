import { fetchMock, SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE";
const TG = "https://api.telegram.org";
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-telegram-bot-token": TOKEN,
  authorization: "Bearer test-token",
};

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
};

const EXPECTED_TOOLS = [
  "telegram_delete_message",
  "telegram_edit_message_text",
  "telegram_forward_message",
  "telegram_get_chat",
  "telegram_get_me",
  "telegram_get_updates",
  "telegram_pin_message",
  "telegram_send_document",
  "telegram_send_message",
  "telegram_send_photo",
  "telegram_set_reaction",
  "telegram_unpin_message",
];

function mockTelegram(method: string, status: number, body: unknown, onBody?: (b: unknown) => void) {
  fetchMock
    .get(TG)
    .intercept({ path: `/bot${TOKEN}/${method}`, method: "POST" })
    .reply(status, (opts) => {
      onBody?.(JSON.parse(String(opts.body)));
      return JSON.stringify(body);
    });
}

async function rpc(body: unknown, headers: Record<string, string> = HEADERS) {
  return SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

type Era = "legacy" | "modern";
const ERAS = ["modern", "legacy"] as const;

const GET_ME_OK = { ok: true, result: { id: 123456789, is_bot: true, first_name: "B", username: "b_bot" } };

// A real SDK 2.x client driven through the Worker (SELF.fetch). "modern" pins
// the 2026-07-28 per-request protocol (server/discover, no handshake);
// "legacy" is the plain 2025 `initialize` sequence served statelessly. Either
// opening request validates the bot token with getMe, so mock it first.
async function connect(era: Era): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client(
    { name: "test", version: "1.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const { "content-type": _ct, accept: _accept, ...headers } = HEADERS;
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers },
    fetch: (input, init) => SELF.fetch(input as string, init),
  });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as Record<string, any>;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("routing", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "telegram-bot" });
  });

  it("unknown path is 404", async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope`)).status).toBe(404);
  });
});

describe("fleet auth gate on /mcp", () => {
  it("401s without the gateway credential, even with a valid bot token", async () => {
    const { authorization: _, ...rest } = HEADERS;
    const res = await rpc(INIT, rest);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("401s a wrong gateway credential", async () => {
    const res = await rpc(INIT, { ...HEADERS, authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });
});

describe("bot token gate on /mcp", () => {
  it("401s without the token header", async () => {
    const { "x-telegram-bot-token": _, ...rest } = HEADERS;
    const res = await rpc(INIT, rest);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("x-telegram-bot-token");
  });

  it("401s a malformed token without calling Telegram", async () => {
    const res = await rpc(INIT, { ...HEADERS, "x-telegram-bot-token": `${TOKEN}/../x` });
    expect(res.status).toBe(401);
  });

  it("401s on initialize when Telegram rejects the token", async () => {
    mockTelegram("getMe", 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const res = await rpc(INIT);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("@BotFather");
    expect(body).not.toContain(TOKEN);
  });

  it("413s an oversized body without calling Telegram", async () => {
    const res = await rpc({ ...INIT, params: { pad: "x".repeat(2 * 1024 * 1024) } });
    expect(res.status).toBe(413);
  });

  it("405s a GET, even without a token: the server is stateless", async () => {
    const { "x-telegram-bot-token": _, ...rest } = HEADERS;
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "GET", headers: rest });
    expect(res.status).toBe(405);
  });
});

// Every tool that maps to one Bot API method: call it, and assert both the exact
// body sent to Telegram and that the tool reports success.
const SENT = { message_id: 42, date: 1_700_000_000, chat: { id: 555, type: "private" }, text: "x" };
const REPLY = {
  message_id: 7,
  allow_sending_without_reply: true,
};
const TOOL_CASES: { tool: string; args: Record<string, unknown>; method: string; body: unknown; result: unknown }[] = [
  { tool: "telegram_get_me", args: {}, method: "getMe", body: {}, result: { id: 1, is_bot: true, username: "b_bot" } },
  {
    tool: "telegram_send_message",
    args: { chat_id: 555, text: "hi", reply_to_message_id: 7, disable_link_preview: true },
    method: "sendMessage",
    body: { chat_id: "555", text: "hi", reply_parameters: REPLY, link_preview_options: { is_disabled: true } },
    result: SENT,
  },
  {
    tool: "telegram_send_photo",
    args: { chat_id: "@my_channel", photo: "https://example.com/a.png", caption: "c" },
    method: "sendPhoto",
    body: { chat_id: "@my_channel", photo: "https://example.com/a.png", caption: "c" },
    result: SENT,
  },
  {
    tool: "telegram_send_document",
    args: { chat_id: 555, document: "BQACAgQAAxkBAAIB", message_thread_id: 3 },
    method: "sendDocument",
    body: { chat_id: "555", document: "BQACAgQAAxkBAAIB", message_thread_id: 3 },
    result: SENT,
  },
  {
    tool: "telegram_forward_message",
    args: { chat_id: 1, from_chat_id: -100, message_id: 9 },
    method: "forwardMessage",
    body: { chat_id: "1", from_chat_id: "-100", message_id: 9 },
    result: SENT,
  },
  {
    tool: "telegram_edit_message_text",
    args: { chat_id: 555, message_id: 42, text: "new", parse_mode: "HTML" },
    method: "editMessageText",
    body: { chat_id: "555", message_id: 42, text: "new", parse_mode: "HTML" },
    result: SENT,
  },
  {
    tool: "telegram_delete_message",
    args: { chat_id: 555, message_id: 42 },
    method: "deleteMessage",
    body: { chat_id: "555", message_id: 42 },
    result: true,
  },
  {
    tool: "telegram_set_reaction",
    args: { chat_id: 555, message_id: 42, emoji: "👍" },
    method: "setMessageReaction",
    body: { chat_id: "555", message_id: 42, reaction: [{ type: "emoji", emoji: "👍" }] },
    result: true,
  },
  {
    tool: "telegram_set_reaction",
    args: { chat_id: 555, message_id: 42 },
    method: "setMessageReaction",
    body: { chat_id: "555", message_id: 42, reaction: [] },
    result: true,
  },
  {
    tool: "telegram_pin_message",
    args: { chat_id: 555, message_id: 42, disable_notification: true },
    method: "pinChatMessage",
    body: { chat_id: "555", message_id: 42, disable_notification: true },
    result: true,
  },
  {
    tool: "telegram_unpin_message",
    args: { chat_id: 555, message_id: 42 },
    method: "unpinChatMessage",
    body: { chat_id: "555", message_id: 42 },
    result: true,
  },
];

describe("connect-time token check (modern protocol)", () => {
  it("rejects the server/discover probe when Telegram rejects the token", async () => {
    mockTelegram("getMe", 401, { ok: false, error_code: 401, description: "Unauthorized" });
    await expect(connect("modern")).rejects.toThrow();
  });
});

for (const era of ERAS) {
  describe(`MCP over the stateless transport (${era} protocol)`, () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;
    beforeAll(async () => {
      mockTelegram("getMe", 200, GET_ME_OK);
      ({ client, transport } = await connect(era));
    });
    afterAll(async () => {
      await client.close();
    });

    it("connects with a valid token and issues no session id", () => {
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerVersion()?.name).toBe("telegram-bot");
    });

    it("lists every tool", async () => {
      const { tools } = await client.listTools();
      // Input schemas stay closed, as under SDK 1.x (zod 4 omits it by default).
      // telegram_get_me takes no arguments and declares no schema (as under 1.x).
      for (const t of tools.filter((t) => t.name !== "telegram_get_me")) {
        expect(t.inputSchema.additionalProperties).toBe(false);
      }
      expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    });

    it("surfaces the webhook conflict on get_updates", async () => {
      mockTelegram("getUpdates", 409, {
        ok: false,
        error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      });
      const result = await callTool(client, "telegram_get_updates", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("deleteWebhook");
    });

    it("short-polls for updates and returns the offset that acknowledges them", async () => {
      let sent: unknown;
      mockTelegram("getUpdates", 200, {
        ok: true,
        result: [
          { update_id: 100, message: { message_id: 1, date: 1_700_000_000, chat: { id: 5, type: "private" }, text: "a" } },
          { update_id: 101, message: { message_id: 2, date: 1_700_000_001, chat: { id: 5, type: "private" }, text: "b" } },
        ],
      }, (b) => (sent = b));
      const result = await callTool(client, "telegram_get_updates", { limit: 10 });
      expect(sent).toEqual({ limit: 10, timeout: 0 });
      expect(result.structuredContent).toMatchObject({ count: 2, next_offset: 102 });
    });

    it("rejects a bad chat id in the schema, before calling Telegram", async () => {
      const result = await callTool(client, "telegram_send_message", { chat_id: "general", text: "hi" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("chat_id");
    });

    it("rejects a non-https photo in the schema, before calling Telegram", async () => {
      const result = await callTool(client, "telegram_send_photo", { chat_id: 5, photo: "http://example.com/a.png" });
      expect(result.isError).toBe(true);
      // The schema's own message, not the 502 a blocked Telegram call would produce.
      expect(JSON.stringify(result.content)).toContain("photo must be an https:// URL");
    });

    it("returns chat info with a null member count when that call fails", async () => {
      mockTelegram("getChat", 200, { ok: true, result: { id: -100, type: "supergroup", title: "T", description: "d" } });
      mockTelegram("getChatMemberCount", 400, { ok: false, error_code: 400, description: "Bad Request" });
      const result = await callTool(client, "telegram_get_chat", { chat_id: -100 });
      expect(result.structuredContent.chat).toMatchObject({ id: -100, title: "T", description: "d", member_count: null });
    });

    it.each(TOOL_CASES)("$tool -> $method", async ({ tool, args, method, body, result }) => {
      let sent: unknown;
      mockTelegram(method, 200, { ok: true, result }, (b) => (sent = b));
      const out = await callTool(client, tool, args);
      expect(out.isError).toBeUndefined();
      expect(sent).toEqual(body);
    });
  });
}
