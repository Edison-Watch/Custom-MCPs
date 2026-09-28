import { describe, expect, test } from "bun:test";

import {
  CHAT_ID_RE,
  explainError,
  fullName,
  isValidBotToken,
  isoDate,
  nextOffset,
  normalizeChatInfo,
  normalizeMessage,
  normalizeUpdate,
  telegramClient,
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
});

describe("CHAT_ID_RE", () => {
  test("matches integer ids and public usernames only", () => {
    for (const good of ["42", "-1001234567890", "@my_channel"]) expect(CHAT_ID_RE.test(good)).toBe(true);
    for (const bad of ["general", "@ab", "1.5", "@1abc", ""]) expect(CHAT_ID_RE.test(bad)).toBe(false);
  });
});

describe("telegramClient", () => {
  const replying = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("posts to <base>/bot<token>/<method> and unwraps the result", async () => {
    let url = "";
    let sent: unknown;
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
    }) as unknown as typeof fetch;
    const call = telegramClient(TOKEN, { base: "http://local/", fetchImpl });
    expect(await call("getChat", { chat_id: "1" })).toEqual({ ok: true, result: { id: 1 } });
    expect(url).toBe(`http://local/bot${TOKEN}/getChat`);
    expect(sent).toEqual({ chat_id: "1" });
  });

  test("maps a Telegram error to an actionable message", async () => {
    const call = telegramClient(TOKEN, {
      fetchImpl: replying(401, { ok: false, error_code: 401, description: "Unauthorized" }),
    });
    const res = await call("getMe", {});
    expect(res).toMatchObject({ ok: false, status: 401 });
    if (!res.ok) expect(res.error).toContain("@BotFather");
  });

  test("never echoes the token when the network fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`);
    }) as unknown as typeof fetch;
    const res = await telegramClient(TOKEN, { fetchImpl })("getMe", {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(TOKEN);
      expect(res.error).toContain("TypeError");
    }
  });

  test("handles a non-JSON body", async () => {
    const fetchImpl = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    expect((await telegramClient(TOKEN, { fetchImpl })("getMe", {})).ok).toBe(false);
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

describe("small helpers", () => {
  test("isoDate converts unix seconds and rejects junk", () => {
    expect(isoDate(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(isoDate("1700000000")).toBeNull();
  });

  test("fullName joins what is present", () => {
    expect(fullName({ first_name: "Ada", last_name: "L" })).toBe("Ada L");
    expect(fullName({ first_name: "Ada" })).toBe("Ada");
    expect(fullName({})).toBeNull();
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

describe("normalizeChatInfo", () => {
  test("extends the chat with description, member count and pinned message", () => {
    expect(
      normalizeChatInfo({ id: 1, type: "private", first_name: "Ada", bio: "hi", pinned_message: RAW_MESSAGE }, null),
    ).toMatchObject({
      id: 1,
      title: "Ada",
      description: "hi",
      member_count: null,
      pinned_message: { message_id: 7 },
    });
    expect(normalizeChatInfo({ id: 2, type: "group", title: "G" }, 12)?.member_count).toBe(12);
    expect(normalizeChatInfo(null, 1)).toBeNull();
  });
});

describe("normalizeUpdate", () => {
  test("message kinds carry the message", () => {
    const u = normalizeUpdate({ update_id: 10, channel_post: RAW_MESSAGE });
    expect(u.type).toBe("channel_post");
    if (u.type === "channel_post") expect(u.message?.message_id).toBe(7);
  });

  test("reactions carry their own fields, not a fake message", () => {
    expect(
      normalizeUpdate({
        update_id: 11,
        message_reaction: {
          chat: { id: 1, type: "private" },
          message_id: 7,
          user: { id: 55, first_name: "Ada" },
          date: 1_700_000_000,
          new_reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "x" }],
        },
      }),
    ).toEqual({
      update_id: 11,
      type: "message_reaction",
      chat: { id: 1, type: "private", title: null, username: null },
      from: { id: 55, is_bot: null, username: null, name: "Ada" },
      message_id: 7,
      date: "2023-11-14T22:13:20.000Z",
      emoji: ["👍"],
    });
  });

  test("callback queries carry the presser and the data", () => {
    const u = normalizeUpdate({
      update_id: 12,
      callback_query: { id: "q", from: { id: 99, first_name: "Cy" }, data: "approve", message: RAW_MESSAGE },
    });
    expect(u).toMatchObject({ type: "callback_query", data: "approve", from: { id: 99 }, message: { message_id: 7 } });
  });

  test("unknown kinds are named, not dropped", () => {
    expect(normalizeUpdate({ update_id: 13, poll: {} })).toEqual({ update_id: 13, type: "other", kind: "poll" });
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
