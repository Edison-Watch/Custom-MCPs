import { describe, expect, test } from "bun:test";

import {
  botIdFromToken,
  callTelegram,
  explainError,
  isValidBotToken,
  methodUrl,
  nextOffset,
  normalizeChatId,
  normalizeMessage,
  normalizeUpdate,
  validateFileRef,
} from "../../src/telegram";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE";

describe("isValidBotToken", () => {
  test("accepts a @BotFather token", () => {
    expect(isValidBotToken(TOKEN)).toBe(true);
  });

  test("rejects anything that could reshape the request URL", () => {
    for (const bad of [
      "",
      "123",
      "abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE",
      `${TOKEN}/sendMessage`,
      `${TOKEN}?x=1`,
      "123456789:../../AAHdqTcvCH1vGWJxfSeofSAs0K5P",
      `${TOKEN}#frag`,
    ]) {
      expect(isValidBotToken(bad)).toBe(false);
    }
    expect(isValidBotToken(null)).toBe(false);
  });

  test("bot id is the public half", () => {
    expect(botIdFromToken(TOKEN)).toBe("123456789");
  });
});

describe("normalizeChatId", () => {
  test("keeps integer ids and public usernames", () => {
    expect(normalizeChatId(42)).toBe("42");
    expect(normalizeChatId("-1001234567890")).toBe("-1001234567890");
    expect(normalizeChatId(" @my_channel ")).toBe("@my_channel");
  });

  test("rejects free text and short usernames", () => {
    expect(normalizeChatId("general")).toBeNull();
    expect(normalizeChatId("@ab")).toBeNull();
    expect(normalizeChatId("1.5")).toBeNull();
  });
});

describe("methodUrl", () => {
  test("puts the token in the path and trims a trailing slash on the base", () => {
    expect(methodUrl(TOKEN, "getMe", "http://local/")).toBe(`http://local/bot${TOKEN}/getMe`);
  });
});

describe("callTelegram", () => {
  const fakeFetch = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("unwraps a successful result and drops undefined params", async () => {
    let sent: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
    }) as unknown as typeof fetch;
    const res = await callTelegram(TOKEN, "getChat", { chat_id: "1", x: undefined }, { fetchImpl });
    expect(res).toEqual({ ok: true, result: { id: 1 } });
    expect(sent).toEqual({ chat_id: "1" });
  });

  test("maps a Telegram error to an actionable message", async () => {
    const res = await callTelegram(TOKEN, "getMe", {}, {
      fetchImpl: fakeFetch(401, { ok: false, error_code: 401, description: "Unauthorized" }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain("@BotFather");
    }
  });

  test("never echoes the token when the network fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`);
    }) as unknown as typeof fetch;
    const res = await callTelegram(TOKEN, "getMe", {}, { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(TOKEN);
      expect(res.error).toContain("TypeError");
    }
  });

  test("handles a non-JSON body", async () => {
    const fetchImpl = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const res = await callTelegram(TOKEN, "getMe", {}, { fetchImpl });
    expect(res.ok).toBe(false);
  });
});

describe("explainError", () => {
  test("names the webhook conflict", () => {
    expect(explainError(409, "Conflict: can't use getUpdates method while webhook is active")).toContain(
      "deleteWebhook",
    );
  });

  test("names a second poller", () => {
    expect(explainError(409, "Conflict: terminated by other getUpdates request")).toContain("one consumer");
  });
});

const RAW_MESSAGE = {
  message_id: 7,
  date: 1_700_000_000,
  chat: { id: -100123, type: "supergroup", title: "Team" },
  from: { id: 55, is_bot: false, first_name: "Ada", last_name: "L", username: "ada" },
  text: "hello",
  reply_to_message: { message_id: 6 },
  message_thread_id: 3,
};

describe("normalizeMessage", () => {
  test("keeps the useful fields", () => {
    expect(normalizeMessage(RAW_MESSAGE)).toEqual({
      message_id: 7,
      date: "2023-11-14T22:13:20.000Z",
      chat: { id: -100123, type: "supergroup", title: "Team", username: null },
      from: { id: 55, is_bot: false, username: "ada", name: "Ada L" },
      text: "hello",
      reply_to_message_id: 6,
      message_thread_id: 3,
      media: [],
    });
  });

  test("uses the caption as text and lists media, largest photo first", () => {
    const msg = normalizeMessage({
      message_id: 8,
      chat: { id: 1, type: "private", first_name: "Bo" },
      caption: "look",
      photo: [{ file_id: "small" }, { file_id: "large" }],
      document: { file_id: "doc1", file_name: "a.pdf", mime_type: "application/pdf" },
    });
    expect(msg?.text).toBe("look");
    expect(msg?.chat?.title).toBe("Bo");
    expect(msg?.media).toEqual([
      { kind: "photo", file_id: "large", file_name: null, mime_type: null },
      { kind: "document", file_id: "doc1", file_name: "a.pdf", mime_type: "application/pdf" },
    ]);
  });

  test("returns null for non-objects", () => {
    expect(normalizeMessage(undefined)).toBeNull();
  });
});

describe("normalizeUpdate", () => {
  test("message kinds", () => {
    const u = normalizeUpdate({ update_id: 10, channel_post: RAW_MESSAGE });
    expect(u.type).toBe("channel_post");
    expect(u.message?.message_id).toBe(7);
  });

  test("reactions", () => {
    const u = normalizeUpdate({
      update_id: 11,
      message_reaction: {
        chat: { id: 1, type: "private" },
        message_id: 7,
        user: { id: 55, first_name: "Ada" },
        date: 1_700_000_000,
        new_reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "x" }],
      },
    });
    expect(u.type).toBe("message_reaction");
    expect(u.reaction).toEqual({ emoji: ["👍"] });
    expect(u.message?.from?.id).toBe(55);
  });

  test("callback queries carry the presser and the data", () => {
    const u = normalizeUpdate({
      update_id: 12,
      callback_query: { id: "q", from: { id: 99, first_name: "Cy" }, data: "approve", message: RAW_MESSAGE },
    });
    expect(u.callback_data).toBe("approve");
    expect(u.message?.from?.id).toBe(99);
  });

  test("unknown kinds are named, not dropped", () => {
    expect(normalizeUpdate({ update_id: 13, poll: {} })).toMatchObject({ update_id: 13, type: "poll", message: null });
  });
});

describe("nextOffset", () => {
  test("is the highest update id plus one", () => {
    expect(nextOffset([normalizeUpdate({ update_id: 5 }), normalizeUpdate({ update_id: 9 })])).toBe(10);
    expect(nextOffset([])).toBeNull();
  });
});

describe("validateFileRef", () => {
  test("accepts https URLs and file ids", () => {
    expect(validateFileRef("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(validateFileRef("AgACAgQAAxkBAAIB")).toBe("AgACAgQAAxkBAAIB");
  });

  test("rejects plain http, credentials, and junk", () => {
    expect(validateFileRef("http://example.com/a.png")).toBeNull();
    expect(validateFileRef("https://user:pw@example.com/a.png")).toBeNull();
    expect(validateFileRef("file:///etc/passwd")).toBeNull();
    expect(validateFileRef("  ")).toBeNull();
  });
});
