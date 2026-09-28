/**
 * Pure Telegram Bot API helpers for the telegram-bot connector: token, chat-id
 * and file-ref validation, the per-request API client, and the normalization
 * that turns raw Bot API objects into a compact, stable shape.
 *
 * Nothing here holds state. The bot token is only ever placed in the request
 * URL path (the Bot API has no header form), never in an error message or log.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Header SealGate injects from the user's encrypted TELEGRAM_BOT_TOKEN field. */
export const BOT_TOKEN_HEADER = "x-telegram-bot-token";

// Bot API limits (https://core.telegram.org/bots/api#sendmessage and friends).
export const MAX_TEXT_LEN = 4096;
export const MAX_CAPTION_LEN = 1024;
export const MAX_UPDATES_LIMIT = 100;

/** Update kinds that carry a whole message. */
export const MESSAGE_UPDATE_KINDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
] as const;
export type MessageUpdateKind = (typeof MESSAGE_UPDATE_KINDS)[number];

/** Update kinds a caller may ask `getUpdates` for (the ones normalizeUpdate understands). */
export const ALLOWED_UPDATE_KINDS = [...MESSAGE_UPDATE_KINDS, "message_reaction", "callback_query"] as const;

/**
 * `<bot id>:<secret>` as issued by @BotFather. The token is interpolated into
 * the URL path, so the charset check is also what stops a caller-supplied value
 * from reshaping the request URL (no `/`, `?`, `#`, `..`).
 */
const BOT_TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{30,60}$/;

export function isValidBotToken(token: string | null | undefined): token is string {
  return typeof token === "string" && BOT_TOKEN_RE.test(token);
}

/** Integer chat id (negative for groups/channels) or a public `@username`. */
export const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

/** File sources a caller may hand to sendPhoto/sendDocument: an https URL or a Telegram file_id. */
export function validateFileRef(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^https:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      // No embedded credentials: they would be forwarded to Telegram's fetcher.
      if (u.username || u.password) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_-]{10,300}$/.test(v) ? v : null;
}

// --- client -----------------------------------------------------------------

export type CallResult<T> = { ok: true; result: T } | { ok: false; status: number; error: string };
export type TelegramCall = <T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<CallResult<T>>;

/**
 * Bind a token to a Bot API client. Every failure folds into `{ ok: false }`
 * with a message that never contains the token: network errors report only the
 * error class (a fetch error can echo the URL), and Telegram's own
 * `description` never includes it.
 */
export function telegramClient(
  token: string,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): TelegramCall {
  const base = (opts.base || TELEGRAM_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return async <T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000) => {
    let res: Response;
    try {
      res = await doFetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "Error";
      return { ok: false, status: 502, error: `could not reach Telegram: ${name}` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, status: 502, error: `Telegram returned ${res.status} with a non-JSON body` };
    }
    if (isRecord(json) && json.ok === true) {
      return { ok: true, result: json.result as T };
    }
    const description = isRecord(json) ? (str(json.description) ?? "unknown error") : "unknown error";
    return { ok: false, status: res.status, error: explainError(res.status, description) };
  };
}

/** Turn the Bot API errors a user can act on into a next step. */
export function explainError(status: number, description: string): string {
  const base = `Telegram ${status}: ${description.slice(0, 300)}`;
  if (status === 401) return `${base}. The bot token was rejected; re-issue it with @BotFather.`;
  if (status === 409 && /webhook/i.test(description)) {
    return (
      `${base}. This bot has a webhook set, so updates cannot be polled. Use a bot that no ` +
      "other service consumes, or remove the webhook with deleteWebhook."
    );
  }
  if (status === 409) {
    return `${base}. Another process is polling this bot; only one consumer can read its updates.`;
  }
  if (status === 403) return `${base}. The bot is not a member of that chat or was blocked by the user.`;
  return base;
}

// --- normalization ----------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Bot API unix-seconds timestamp to ISO8601. */
export function isoDate(v: unknown): string | null {
  const seconds = num(v);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** "First Last" from a User or private Chat, or null when neither is set. */
export function fullName(raw: Record<string, unknown>): string | null {
  return [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ") || null;
}

export interface NormalizedChat {
  id: number | null;
  type: string | null;
  title: string | null;
  username: string | null;
}

export interface NormalizedChatInfo extends NormalizedChat {
  description: string | null;
  member_count: number | null;
  pinned_message: NormalizedMessage | null;
}

export interface NormalizedUser {
  id: number | null;
  is_bot: boolean | null;
  username: string | null;
  name: string | null;
}

export interface NormalizedMedia {
  kind: string;
  file_id: string | null;
  file_name: string | null;
  mime_type: string | null;
}

export interface NormalizedMessage {
  message_id: number | null;
  date: string | null;
  chat: NormalizedChat | null;
  from: NormalizedUser | null;
  text: string | null;
  reply_to_message_id: number | null;
  message_thread_id: number | null;
  media: NormalizedMedia[];
}

/** One update, discriminated on `type`; kinds normalizeUpdate does not model arrive as `other`. */
export type NormalizedUpdate = { update_id: number | null } & (
  | { type: MessageUpdateKind; message: NormalizedMessage | null }
  | {
      type: "message_reaction";
      chat: NormalizedChat | null;
      from: NormalizedUser | null;
      message_id: number | null;
      date: string | null;
      emoji: string[];
    }
  | { type: "callback_query"; from: NormalizedUser | null; data: string | null; message: NormalizedMessage | null }
  | { type: "other"; kind: string }
);

// Media fields whose value is a single object carrying a file_id.
const SINGLE_FILE_MEDIA = ["document", "audio", "video", "voice", "video_note", "animation", "sticker"] as const;

export function normalizeChat(raw: unknown): NormalizedChat | null {
  if (!isRecord(raw)) return null;
  return {
    id: num(raw.id),
    type: str(raw.type),
    title: str(raw.title) ?? fullName(raw),
    username: str(raw.username),
  };
}

/** A `getChat` ChatFullInfo plus its member count, on top of the basic chat shape. */
export function normalizeChatInfo(raw: unknown, memberCount: number | null): NormalizedChatInfo | null {
  const chat = normalizeChat(raw);
  if (!chat || !isRecord(raw)) return null;
  return {
    ...chat,
    description: str(raw.description) ?? str(raw.bio),
    member_count: memberCount,
    pinned_message: normalizeMessage(raw.pinned_message),
  };
}

export function normalizeUser(raw: unknown): NormalizedUser | null {
  if (!isRecord(raw)) return null;
  return {
    id: num(raw.id),
    is_bot: typeof raw.is_bot === "boolean" ? raw.is_bot : null,
    username: str(raw.username),
    name: fullName(raw),
  };
}

function mediaOf(raw: Record<string, unknown>): NormalizedMedia[] {
  const media: NormalizedMedia[] = [];
  // `photo` is an array of sizes; the last is the largest.
  if (Array.isArray(raw.photo) && raw.photo.length > 0) {
    const largest = raw.photo[raw.photo.length - 1];
    media.push({ kind: "photo", file_id: isRecord(largest) ? str(largest.file_id) : null, file_name: null, mime_type: null });
  }
  for (const kind of SINGLE_FILE_MEDIA) {
    const m = raw[kind];
    if (isRecord(m)) {
      media.push({ kind, file_id: str(m.file_id), file_name: str(m.file_name), mime_type: str(m.mime_type) });
    }
  }
  return media;
}

export function normalizeMessage(raw: unknown): NormalizedMessage | null {
  if (!isRecord(raw)) return null;
  return {
    message_id: num(raw.message_id),
    date: isoDate(raw.date),
    chat: normalizeChat(raw.chat),
    from: normalizeUser(raw.from) ?? normalizeUser(raw.sender_chat),
    text: str(raw.text) ?? str(raw.caption),
    reply_to_message_id: isRecord(raw.reply_to_message) ? num(raw.reply_to_message.message_id) : null,
    message_thread_id: num(raw.message_thread_id),
    media: mediaOf(raw),
  };
}

export function normalizeUpdate(raw: unknown): NormalizedUpdate {
  const rec = isRecord(raw) ? raw : {};
  const update_id = num(rec.update_id);
  for (const type of MESSAGE_UPDATE_KINDS) {
    if (isRecord(rec[type])) return { update_id, type, message: normalizeMessage(rec[type]) };
  }
  if (isRecord(rec.message_reaction)) {
    const r = rec.message_reaction;
    const emoji = Array.isArray(r.new_reaction)
      ? r.new_reaction.flatMap((x) => (isRecord(x) && typeof x.emoji === "string" ? [x.emoji] : []))
      : [];
    return {
      update_id,
      type: "message_reaction",
      chat: normalizeChat(r.chat),
      from: normalizeUser(r.user) ?? normalizeUser(r.actor_chat),
      message_id: num(r.message_id),
      date: isoDate(r.date),
      emoji,
    };
  }
  if (isRecord(rec.callback_query)) {
    const q = rec.callback_query;
    return {
      update_id,
      type: "callback_query",
      from: normalizeUser(q.from),
      data: str(q.data),
      message: normalizeMessage(q.message),
    };
  }
  // Any other kind (poll, chat_member, ...): name it so the caller knows it
  // exists and can advance the offset past it.
  return { update_id, type: "other", kind: Object.keys(rec).find((k) => k !== "update_id") ?? "unknown" };
}

/** Offset that acknowledges every update in `updates` (Bot API: last id + 1). */
export function nextOffset(updates: NormalizedUpdate[]): number | null {
  let max: number | null = null;
  for (const u of updates) if (u.update_id !== null && (max === null || u.update_id > max)) max = u.update_id;
  return max === null ? null : max + 1;
}
