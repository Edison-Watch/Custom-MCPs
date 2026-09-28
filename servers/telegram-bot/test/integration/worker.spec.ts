import { fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE";
const TG = "https://api.telegram.org";
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-telegram-bot-token": TOKEN,
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

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const msg = (await res.json()) as { result: Record<string, any> };
  return msg.result;
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

  it("405s a GET, even without a token: the server is stateless", async () => {
    const { "x-telegram-bot-token": _, ...rest } = HEADERS;
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "GET", headers: rest });
    expect(res.status).toBe(405);
  });
});

describe("MCP over the stateless transport", () => {
  it("initializes with a valid token and issues no session id", async () => {
    mockTelegram("getMe", 200, { ok: true, result: { id: 123456789, is_bot: true, first_name: "B", username: "b_bot" } });
    const res = await rpc(INIT);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const msg = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(msg.result.serverInfo.name).toBe("telegram-bot");
  });

  it("lists every tool", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const msg = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(msg.result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("surfaces the webhook conflict on get_updates", async () => {
    mockTelegram("getUpdates", 409, {
      ok: false,
      error_code: 409,
      description: "Conflict: can't use getUpdates method while webhook is active",
    });
    const result = await callTool("telegram_get_updates", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("deleteWebhook");
  });

  it("returns updates with the offset that acknowledges them", async () => {
    mockTelegram("getUpdates", 200, {
      ok: true,
      result: [
        { update_id: 100, message: { message_id: 1, date: 1_700_000_000, chat: { id: 5, type: "private" }, text: "a" } },
        { update_id: 101, message: { message_id: 2, date: 1_700_000_001, chat: { id: 5, type: "private" }, text: "b" } },
      ],
    });
    const result = await callTool("telegram_get_updates", { limit: 10 });
    expect(result.structuredContent).toMatchObject({ count: 2, next_offset: 102 });
  });

  it("rejects a bad chat id in the schema, before calling Telegram", async () => {
    const result = await callTool("telegram_send_message", { chat_id: "general", text: "hi" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("chat_id");
  });

  it("rejects a non-https photo in the schema, before calling Telegram", async () => {
    const result = await callTool("telegram_send_photo", { chat_id: 5, photo: "http://example.com/a.png" });
    expect(result.isError).toBe(true);
  });

  it("returns chat info with a null member count when that call fails", async () => {
    mockTelegram("getChat", 200, { ok: true, result: { id: -100, type: "supergroup", title: "T", description: "d" } });
    mockTelegram("getChatMemberCount", 400, { ok: false, error_code: 400, description: "Bad Request" });
    const result = await callTool("telegram_get_chat", { chat_id: -100 });
    expect(result.structuredContent.chat).toMatchObject({ id: -100, title: "T", description: "d", member_count: null });
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

describe("each tool sends the right Bot API call", () => {
  it.each(TOOL_CASES)("$tool -> $method", async ({ tool, args, method, body, result }) => {
    let sent: unknown;
    mockTelegram(method, 200, { ok: true, result }, (b) => (sent = b));
    const out = await callTool(tool, args);
    expect(out.isError).toBeUndefined();
    expect(sent).toEqual(body);
  });
});
