/**
 * telegram-bot - an Edison first-party MCP server.
 *
 * Drive a Telegram bot through the Bot API: read the updates it receives, look
 * up chats, and send, edit, forward, react to, pin and delete messages. Each
 * user brings their own bot from @BotFather; SealGate stores the token in its
 * zero-knowledge template values and injects it per request as the
 * `X-Telegram-Bot-Token` header (catalog `auth: "token"`).
 *
 * Transport: streamable HTTP at `/mcp`, **stateless**. Unlike the Durable
 * Object connectors, every request builds its own McpServer closed over that
 * request's token and discards it after responding. That keeps the token out
 * of any storage: McpAgent persists its `props` into Durable Object storage,
 * which is fine for a JWT subject and not for a live bot credential. The Bot
 * API itself is stateless, so there is no per-bot session worth keeping.
 *
 * Auth: the bot token is the credential that authorizes the work (every call
 * spends the caller's own bot, never a first-party account). The fleet auth
 * contract (./auth) still gates `/mcp` in front of it, so a self-hosted deploy
 * can add `bearer`. A bad token is a 401 without an OAuth challenge, which
 * SealGate reports as rejected credentials rather than starting OAuth.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { checkAuth } from "./auth";
import {
  ALLOWED_UPDATE_KINDS,
  BOT_TOKEN_HEADER,
  CHAT_ID_RE,
  MAX_CAPTION_LEN,
  MAX_TEXT_LEN,
  MAX_UPDATES_LIMIT,
  isRecord,
  isValidBotToken,
  nextOffset,
  normalizeChatInfo,
  normalizeMessage,
  normalizeUpdate,
  normalizeUser,
  telegramClient,
  validateFileRef,
  type TelegramCall,
} from "./telegram";

export interface Env {
  // Optional override of https://api.telegram.org (tests, a local Bot API server).
  TELEGRAM_API_BASE?: string;
  // Fleet auth (see ./auth, ./jwt).
  AUTH_TOKEN?: string;
  AUTH_MODE?: string;
  EDISON_JWKS_URL?: string;
  EDISON_JWT_ISSUER?: string;
  EDISON_JWT_AUDIENCE?: string;
}

const SERVICE = "telegram-bot";

// --- input schemas ------------------------------------------------------------
// Validation and normalization live in the schemas: the SDK hands handlers the
// parsed (transformed) value, and a failure never reaches Telegram.

const chatId = z
  .union([z.number().int(), z.string()])
  .transform((v, ctx) => {
    const id = String(v).trim();
    if (CHAT_ID_RE.test(id)) return id;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "chat_id must be an integer id or a public '@username'" });
    return z.NEVER;
  })
  .describe("Chat id (integer, negative for groups/channels) or a public '@channelusername'.");

const fileRef = (kind: string) =>
  z
    .string()
    .max(2048)
    .transform((v, ctx) => {
      const ref = validateFileRef(v);
      if (ref) return ref;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${kind} must be an https:// URL without credentials, or a Telegram file_id` });
      return z.NEVER;
    })
    .describe("An https:// URL (Telegram fetches it) or the file_id of a file the bot has seen.");

const messageId = z.number().int().positive().describe("Message id within the chat.");
const parseMode = z
  .enum(["MarkdownV2", "HTML"])
  .optional()
  .describe("Telegram formatting mode. Omit for plain text. Length limits apply after Telegram parses the markup.");
const text = z.string().min(1).max(MAX_TEXT_LEN).describe(`Message text (1-${MAX_TEXT_LEN} characters).`);
const disableNotification = z.boolean().optional().describe("Deliver silently (no sound).");

/** Fields shared by every tool that sends a new message into a chat. */
const sendFields = {
  chat_id: chatId,
  reply_to_message_id: z.number().int().positive().optional().describe("Reply to this message id in the same chat."),
  message_thread_id: z.number().int().positive().optional().describe("Forum topic id (supergroups with topics)."),
  disable_notification: disableNotification,
};
const fileFields = {
  ...sendFields,
  caption: z.string().max(MAX_CAPTION_LEN).optional().describe(`Caption (max ${MAX_CAPTION_LEN}).`),
  parse_mode: parseMode,
};

type SendArgs = {
  chat_id: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
  disable_notification?: boolean;
};

/** Bot API params for `sendFields`; allow_sending_without_reply keeps a deleted target from failing the send. */
function sendParams({ reply_to_message_id, ...rest }: SendArgs): Record<string, unknown> {
  return reply_to_message_id === undefined
    ? rest
    : { ...rest, reply_parameters: { message_id: reply_to_message_id, allow_sending_without_reply: true } };
}

// --- results --------------------------------------------------------------------

function textError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function ok(summary: string, data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

type Render<T> = (result: T) => [summary: string, data: Record<string, unknown>];

/** Call one Bot API method and turn the outcome into a tool result. */
function runner(call: TelegramCall) {
  return async <T>(method: string, params: Record<string, unknown>, render: Render<T>) => {
    const res = await call<T>(method, params);
    return res.ok ? ok(...render(res.result)) : textError(res.error);
  };
}

const sentMessage =
  (what: string): Render<unknown> =>
  (raw) => {
    const message = normalizeMessage(raw);
    return [`Sent ${what} as message ${message?.message_id ?? "?"}`, { message }];
  };

// --- server ---------------------------------------------------------------------

/** Build one request's MCP server over that request's Telegram client. */
export function buildServer(call: TelegramCall): McpServer {
  const server = new McpServer({ name: SERVICE, version: "0.1.0" });
  const run = runner(call);

  server.registerTool(
    "telegram_get_me",
    { description: "Return the bot's own identity (id, username, name). Use it to confirm which bot is connected." },
    () =>
      run("getMe", {}, (raw) => {
        const bot = normalizeUser(raw);
        return [`Connected as @${bot?.username ?? "unknown"}`, { bot }];
      }),
  );

  server.registerTool(
    "telegram_get_updates",
    {
      description:
        "Fetch messages and events the bot has received and not yet acknowledged (Telegram keeps them " +
        "for 24 hours). Bots cannot read older chat history. Pass the returned `next_offset` as `offset` " +
        "on the next call to acknowledge what you have read, or updates will be returned again. Fails if " +
        "the bot has a webhook set.",
      inputSchema: {
        offset: z
          .number()
          .int()
          .optional()
          .describe("Return updates from this id on; acknowledges all earlier ones. Use the previous next_offset."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_UPDATES_LIMIT)
          .default(50)
          .describe(`Max updates to return (1-${MAX_UPDATES_LIMIT}, default 50).`),
        allowed_updates: z
          .array(z.enum(ALLOWED_UPDATE_KINDS))
          .max(ALLOWED_UPDATE_KINDS.length)
          .optional()
          .describe("Only return these update kinds. Omit for the bot's current setting."),
      },
    },
    // timeout 0 = short poll: a Worker request must not hang waiting for new messages.
    (args) =>
      run<unknown[]>("getUpdates", { ...args, timeout: 0 }, (raw) => {
        const updates = Array.isArray(raw) ? raw.map(normalizeUpdate) : [];
        return [
          `${updates.length} update(s)`,
          { count: updates.length, next_offset: nextOffset(updates), updates },
        ];
      }),
  );

  server.registerTool(
    "telegram_get_chat",
    {
      description:
        "Look up a chat the bot can see: type, title, username, description, member count, pinned message. " +
        "Private chats are only visible after that user has messaged the bot.",
      inputSchema: { chat_id: chatId },
    },
    async ({ chat_id }) => {
      const [chat, count] = await Promise.all([
        call<unknown>("getChat", { chat_id }),
        call<number>("getChatMemberCount", { chat_id }),
      ]);
      if (!chat.ok) return textError(chat.error);
      return ok(`Chat ${chat_id}`, { chat: normalizeChatInfo(chat.result, count.ok ? count.result : null) });
    },
  );

  server.registerTool(
    "telegram_send_message",
    {
      description: "Send a text message from the bot to a chat, optionally as a reply or into a forum topic.",
      inputSchema: {
        ...sendFields,
        text,
        parse_mode: parseMode,
        disable_link_preview: z.boolean().optional().describe("Do not render a preview for links in the text."),
      },
    },
    ({ text, parse_mode, disable_link_preview, ...send }) =>
      run(
        "sendMessage",
        {
          ...sendParams(send),
          text,
          parse_mode,
          link_preview_options: disable_link_preview ? { is_disabled: true } : undefined,
        },
        sentMessage("text"),
      ),
  );

  server.registerTool(
    "telegram_send_photo",
    { description: "Send a photo to a chat.", inputSchema: { ...fileFields, photo: fileRef("photo") } },
    ({ photo, caption, parse_mode, ...send }) =>
      run("sendPhoto", { ...sendParams(send), photo, caption, parse_mode }, sentMessage("photo")),
  );

  server.registerTool(
    "telegram_send_document",
    { description: "Send a file to a chat.", inputSchema: { ...fileFields, document: fileRef("document") } },
    ({ document, caption, parse_mode, ...send }) =>
      run("sendDocument", { ...sendParams(send), document, caption, parse_mode }, sentMessage("document")),
  );

  server.registerTool(
    "telegram_forward_message",
    {
      description: "Forward a message from one chat the bot can see into another.",
      inputSchema: {
        chat_id: chatId.describe("Destination chat id or '@username'."),
        from_chat_id: chatId.describe("Source chat id or '@username'."),
        message_id: messageId,
        disable_notification: disableNotification,
      },
    },
    (args) => run("forwardMessage", args, sentMessage("forward")),
  );

  server.registerTool(
    "telegram_edit_message_text",
    {
      description: "Replace the text of a message the bot sent earlier.",
      inputSchema: { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode },
    },
    (args) =>
      run("editMessageText", args, (raw) => [
        `Edited message ${args.message_id}`,
        { message: normalizeMessage(raw) },
      ]),
  );

  server.registerTool(
    "telegram_delete_message",
    {
      description:
        "Delete a message. Bots can delete their own messages, and others' in groups where they are an admin " +
        "with delete rights (within 48 hours).",
      inputSchema: { chat_id: chatId, message_id: messageId },
    },
    (args) => run("deleteMessage", args, () => [`Deleted message ${args.message_id}`, { deleted: true }]),
  );

  server.registerTool(
    "telegram_set_reaction",
    {
      description: "Set the bot's emoji reaction on a message, or clear it by omitting `emoji`.",
      inputSchema: {
        chat_id: chatId,
        message_id: messageId,
        emoji: z
          .string()
          .min(1)
          .max(16)
          .optional()
          .describe("One emoji from Telegram's allowed reaction set, e.g. '👍'. Omit to remove the reaction."),
      },
    },
    ({ emoji, ...target }) =>
      run("setMessageReaction", { ...target, reaction: emoji ? [{ type: "emoji", emoji }] : [] }, () => [
        emoji ? `Reacted ${emoji}` : "Reaction cleared",
        { reaction: emoji ?? null },
      ]),
  );

  server.registerTool(
    "telegram_pin_message",
    {
      description: "Pin a message in a chat. Needs pin rights in groups.",
      inputSchema: { chat_id: chatId, message_id: messageId, disable_notification: disableNotification },
    },
    (args) => run("pinChatMessage", args, () => [`Pinned message ${args.message_id}`, { pinned: true }]),
  );

  server.registerTool(
    "telegram_unpin_message",
    {
      description: "Unpin a pinned message in a chat. Needs pin rights in groups.",
      inputSchema: { chat_id: chatId, message_id: messageId },
    },
    (args) => run("unpinChatMessage", args, () => [`Unpinned message ${args.message_id}`, { pinned: false }]),
  );

  return server;
}

// --- HTTP -----------------------------------------------------------------------

function jsonError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function isInitialize(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some((m) => isRecord(m) && m.method === "initialize");
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless transport: no session, so GET (server-initiated SSE) and DELETE
  // (session teardown) have nothing to act on.
  if (request.method !== "POST") {
    return jsonError(405, "method not allowed: this server is stateless, POST JSON-RPC to /mcp", { allow: "POST" });
  }

  const auth = await checkAuth(request, env);
  if (!auth.ok) {
    const extra: Record<string, string> = auth.status === 401 ? { "www-authenticate": `Bearer realm="${SERVICE}"` } : {};
    return jsonError(auth.status, auth.message, extra);
  }

  const token = request.headers.get(BOT_TOKEN_HEADER)?.trim();
  if (!token) return jsonError(401, `missing ${BOT_TOKEN_HEADER} header (a @BotFather bot token)`);
  if (!isValidBotToken(token)) return jsonError(401, `malformed ${BOT_TOKEN_HEADER}: expected '<bot id>:<secret>'`);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "request body must be JSON-RPC");
  }

  const call = telegramClient(token, { base: env.TELEGRAM_API_BASE?.trim() });

  // Check the token once per connection, on initialize, so a wrong token fails
  // at install time instead of on the first tool call.
  if (isInitialize(body)) {
    const me = await call("getMe", {}, 10_000);
    if (!me.ok) return jsonError(me.status === 401 ? 401 : 502, me.error);
  }

  const server = buildServer(call);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    // JSON-response mode resolves only once every reply is ready, so the
    // per-request server can be dropped straight away.
    await server.close();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: SERVICE });
    }
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
