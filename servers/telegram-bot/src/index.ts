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
 * can add `bearer`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { checkAuth } from "./auth";
import {
  BOT_TOKEN_HEADER,
  MAX_CAPTION_LEN,
  MAX_TEXT_LEN,
  MAX_UPDATES_LIMIT,
  TELEGRAM_API_BASE,
  callTelegram,
  isRecord,
  isValidBotToken,
  nextOffset,
  normalizeChatId,
  normalizeMessage,
  normalizeUpdate,
  normalizeUser,
  validateFileRef,
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

type ToolResult = {
  isError?: true;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
};

function textError(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

// --- shared input fragments --------------------------------------------------

const chatId = z
  .union([z.string(), z.number().int()])
  .describe("Chat id (integer, negative for groups/channels) or a public '@channelusername'.");
const messageId = z.number().int().positive().describe("Message id within the chat.");
const parseMode = z
  .enum(["MarkdownV2", "HTML"])
  .optional()
  .describe("Telegram formatting mode for the text. Omit to send plain text.");
const disableNotification = z.boolean().optional().describe("Deliver silently (no sound).");
const replyTo = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Reply to this message id in the same chat.");
const threadId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Forum topic id, for supergroups with topics enabled.");

function badChat(): ToolResult {
  return textError("chat_id must be an integer id or a public '@username'");
}

function replyParameters(id: number | undefined) {
  // allow_sending_without_reply: a deleted target should not fail the send.
  return id === undefined ? undefined : { message_id: id, allow_sending_without_reply: true };
}

/** Build one request's MCP server, closed over that request's bot token. */
export function buildServer(token: string, env: Env): McpServer {
  const server = new McpServer({ name: SERVICE, version: "0.1.0" });
  const base = env.TELEGRAM_API_BASE?.trim() || TELEGRAM_API_BASE;
  const call = <T>(method: string, params: Record<string, unknown>) =>
    callTelegram<T>(token, method, params, { base });

  server.registerTool(
    "telegram_get_me",
    {
      description: "Return the bot's own identity (id, username, name). Use it to confirm which bot is connected.",
      inputSchema: {},
    },
    async () => {
      const res = await call<unknown>("getMe", {});
      if (!res.ok) return textError(res.error);
      const me = normalizeUser(res.result);
      return ok(`Connected as @${me?.username ?? "unknown"}`, { bot: me });
    },
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
          .optional()
          .describe(`Max updates to return (1-${MAX_UPDATES_LIMIT}, default 50).`),
        allowed_updates: z
          .array(
            z.enum([
              "message",
              "edited_message",
              "channel_post",
              "edited_channel_post",
              "message_reaction",
              "callback_query",
            ]),
          )
          .max(6)
          .optional()
          .describe("Only return these update kinds. Omit for the bot's current setting."),
      },
    },
    async (args: { offset?: number; limit?: number; allowed_updates?: string[] }) => {
      const res = await call<unknown[]>("getUpdates", {
        offset: args.offset,
        limit: args.limit ?? 50,
        // Short poll: a Worker request must not hang waiting for new messages.
        timeout: 0,
        allowed_updates: args.allowed_updates,
      });
      if (!res.ok) return textError(res.error);
      const updates = Array.isArray(res.result) ? res.result.map(normalizeUpdate) : [];
      return ok(`${updates.length} update(s)`, {
        count: updates.length,
        next_offset: nextOffset(updates),
        updates,
      });
    },
  );

  server.registerTool(
    "telegram_get_chat",
    {
      description:
        "Look up a chat the bot can see: type, title, username, description, member count. Private chats " +
        "are only visible after that user has messaged the bot.",
      inputSchema: { chat_id: chatId },
    },
    async (args: { chat_id: string | number }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const chat = await call<Record<string, unknown>>("getChat", { chat_id: id });
      if (!chat.ok) return textError(chat.error);
      const count = await call<number>("getChatMemberCount", { chat_id: id });
      const c = isRecord(chat.result) ? chat.result : {};
      return ok(`Chat ${id}`, {
        chat: {
          id: c.id ?? null,
          type: c.type ?? null,
          title: c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || null),
          username: c.username ?? null,
          description: c.description ?? c.bio ?? null,
          member_count: count.ok ? count.result : null,
          pinned_message: normalizeMessage(c.pinned_message),
        },
      });
    },
  );

  server.registerTool(
    "telegram_send_message",
    {
      description: "Send a text message from the bot to a chat, optionally as a reply or into a forum topic.",
      inputSchema: {
        chat_id: chatId,
        text: z.string().min(1).max(MAX_TEXT_LEN).describe(`Message text (1-${MAX_TEXT_LEN} characters).`),
        parse_mode: parseMode,
        reply_to_message_id: replyTo,
        message_thread_id: threadId,
        disable_notification: disableNotification,
        disable_link_preview: z.boolean().optional().describe("Do not render a preview for links in the text."),
      },
    },
    async (args: {
      chat_id: string | number;
      text: string;
      parse_mode?: string;
      reply_to_message_id?: number;
      message_thread_id?: number;
      disable_notification?: boolean;
      disable_link_preview?: boolean;
    }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const res = await call<unknown>("sendMessage", {
        chat_id: id,
        text: args.text,
        parse_mode: args.parse_mode,
        message_thread_id: args.message_thread_id,
        disable_notification: args.disable_notification,
        reply_parameters: replyParameters(args.reply_to_message_id),
        link_preview_options: args.disable_link_preview ? { is_disabled: true } : undefined,
      });
      if (!res.ok) return textError(res.error);
      const msg = normalizeMessage(res.result);
      return ok(`Sent message ${msg?.message_id ?? "?"} to ${id}`, { message: msg });
    },
  );

  const sendFileTool = (tool: string, method: "sendPhoto" | "sendDocument", field: "photo" | "document") => {
    server.registerTool(
      tool,
      {
        description:
          `Send a ${field} to a chat by https URL (Telegram fetches it) or by the file_id of a file the bot ` +
          "has already seen (from telegram_get_updates).",
        inputSchema: {
          chat_id: chatId,
          [field]: z.string().min(1).max(2048).describe("An https:// URL or a Telegram file_id."),
          caption: z.string().max(MAX_CAPTION_LEN).optional().describe(`Caption (max ${MAX_CAPTION_LEN}).`),
          parse_mode: parseMode,
          reply_to_message_id: replyTo,
          message_thread_id: threadId,
          disable_notification: disableNotification,
        },
      },
      async (args: Record<string, unknown>) => {
        const id = normalizeChatId(args.chat_id as string | number);
        if (!id) return badChat();
        const ref = validateFileRef(String(args[field] ?? ""));
        if (!ref) return textError(`${field} must be an https:// URL without credentials, or a Telegram file_id`);
        const res = await call<unknown>(method, {
          chat_id: id,
          [field]: ref,
          caption: args.caption,
          parse_mode: args.parse_mode,
          message_thread_id: args.message_thread_id,
          disable_notification: args.disable_notification,
          reply_parameters: replyParameters(args.reply_to_message_id as number | undefined),
        });
        if (!res.ok) return textError(res.error);
        const msg = normalizeMessage(res.result);
        return ok(`Sent ${field} as message ${msg?.message_id ?? "?"} to ${id}`, { message: msg });
      },
    );
  };
  sendFileTool("telegram_send_photo", "sendPhoto", "photo");
  sendFileTool("telegram_send_document", "sendDocument", "document");

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
    async (args: {
      chat_id: string | number;
      from_chat_id: string | number;
      message_id: number;
      disable_notification?: boolean;
    }) => {
      const to = normalizeChatId(args.chat_id);
      const from = normalizeChatId(args.from_chat_id);
      if (!to || !from) return badChat();
      const res = await call<unknown>("forwardMessage", {
        chat_id: to,
        from_chat_id: from,
        message_id: args.message_id,
        disable_notification: args.disable_notification,
      });
      if (!res.ok) return textError(res.error);
      const msg = normalizeMessage(res.result);
      return ok(`Forwarded as message ${msg?.message_id ?? "?"} in ${to}`, { message: msg });
    },
  );

  server.registerTool(
    "telegram_edit_message_text",
    {
      description: "Replace the text of a message the bot sent earlier.",
      inputSchema: {
        chat_id: chatId,
        message_id: messageId,
        text: z.string().min(1).max(MAX_TEXT_LEN).describe(`New text (1-${MAX_TEXT_LEN} characters).`),
        parse_mode: parseMode,
      },
    },
    async (args: { chat_id: string | number; message_id: number; text: string; parse_mode?: string }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const res = await call<unknown>("editMessageText", {
        chat_id: id,
        message_id: args.message_id,
        text: args.text,
        parse_mode: args.parse_mode,
      });
      if (!res.ok) return textError(res.error);
      return ok(`Edited message ${args.message_id} in ${id}`, { message: normalizeMessage(res.result) });
    },
  );

  server.registerTool(
    "telegram_delete_message",
    {
      description:
        "Delete a message. Bots can delete their own messages, and others' in groups where they are an admin " +
        "with delete rights (within 48 hours).",
      inputSchema: { chat_id: chatId, message_id: messageId },
    },
    async (args: { chat_id: string | number; message_id: number }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const res = await call<boolean>("deleteMessage", { chat_id: id, message_id: args.message_id });
      if (!res.ok) return textError(res.error);
      return ok(`Deleted message ${args.message_id} in ${id}`, { deleted: true });
    },
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
    async (args: { chat_id: string | number; message_id: number; emoji?: string }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const res = await call<boolean>("setMessageReaction", {
        chat_id: id,
        message_id: args.message_id,
        reaction: args.emoji ? [{ type: "emoji", emoji: args.emoji }] : [],
      });
      if (!res.ok) return textError(res.error);
      return ok(args.emoji ? `Reacted ${args.emoji}` : "Reaction cleared", { reacted: true });
    },
  );

  server.registerTool(
    "telegram_pin_message",
    {
      description: "Pin a message in a chat, or unpin it with `unpin: true`. Needs pin rights in groups.",
      inputSchema: {
        chat_id: chatId,
        message_id: messageId,
        unpin: z.boolean().optional().describe("Unpin this message instead of pinning it."),
        disable_notification: disableNotification,
      },
    },
    async (args: { chat_id: string | number; message_id: number; unpin?: boolean; disable_notification?: boolean }) => {
      const id = normalizeChatId(args.chat_id);
      if (!id) return badChat();
      const res = args.unpin
        ? await call<boolean>("unpinChatMessage", { chat_id: id, message_id: args.message_id })
        : await call<boolean>("pinChatMessage", {
            chat_id: id,
            message_id: args.message_id,
            disable_notification: args.disable_notification,
          });
      if (!res.ok) return textError(res.error);
      const verb = args.unpin ? "Unpinned" : "Pinned";
      return ok(`${verb} message ${args.message_id} in ${id}`, { pinned: !args.unpin });
    },
  );

  return server;
}

function jsonError(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => isRecord(m) && m.method === "initialize");
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const auth = await checkAuth(request, env);
  if (!auth.ok) {
    const extra: Record<string, string> = auth.status === 401 ? { "www-authenticate": `Bearer realm="${SERVICE}"` } : {};
    return jsonError(auth.status, auth.message, extra);
  }

  const token = request.headers.get(BOT_TOKEN_HEADER)?.trim();
  if (!token) return jsonError(401, `missing ${BOT_TOKEN_HEADER} header (a @BotFather bot token)`);
  if (!isValidBotToken(token)) return jsonError(401, `malformed ${BOT_TOKEN_HEADER}: expected '<bot id>:<secret>'`);

  // Stateless transport: no session, so GET (server-initiated SSE) and DELETE
  // (session teardown) have nothing to act on.
  if (request.method !== "POST") {
    return jsonError(405, "method not allowed: this server is stateless, POST JSON-RPC to /mcp", { allow: "POST" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "request body must be JSON-RPC");
  }

  // Check the token once per connection, on initialize, so a wrong token fails
  // at install time with a 401 instead of on the first tool call.
  if (isInitialize(body)) {
    const base = env.TELEGRAM_API_BASE?.trim() || TELEGRAM_API_BASE;
    const me = await callTelegram<unknown>(token, "getMe", {}, { base, timeoutMs: 10_000 });
    if (!me.ok) return jsonError(me.status === 401 ? 401 : 502, me.error);
  }

  const server = buildServer(token, env);
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
