/**
 * Pure Telegram Bot API helpers for the telegram-bot connector: token and
 * chat-id validation, the method call wrapper, and the normalization that turns
 * raw Bot API updates/messages into a compact, stable shape.
 *
 * Nothing here holds state. The bot token is a per-request argument and is only
 * ever placed in the request URL path (the Bot API has no header form), never
 * in an error message or log line.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Header SealGate injects from the user's encrypted TELEGRAM_BOT_TOKEN field. */
export const BOT_TOKEN_HEADER = "x-telegram-bot-token";

// Bot API limits (https://core.telegram.org/bots/api#sendmessage and friends).
export const MAX_TEXT_LEN = 4096;
export const MAX_CAPTION_LEN = 1024;
export const MAX_UPDATES_LIMIT = 100;

/**
 * `<bot id>:<secret>` as issued by @BotFather. The token is interpolated into
 * the URL path, so the charset check is also what stops a caller-supplied value
 * from reshaping the request URL (no `/`, `?`, `#`, `..`).
 */
const BOT_TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{30,60}$/;

export function isValidBotToken(token: string | null | undefined): token is string {
  return typeof token === "string" && BOT_TOKEN_RE.test(token);
}

/** The numeric bot id is the public half of the token: safe to log and attribute by. */
export function botIdFromToken(token: string): string {
  return token.slice(0, token.indexOf(":"));
}

/** Integer chat id (negative for groups/channels) or a public `@username`. */
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

export function normalizeChatId(value: string | number): string | null {
  const s = String(value).trim();
  return CHAT_ID_RE.test(s) ? s : null;
}

export function methodUrl(token: string, method: string, base: string = TELEGRAM_API_BASE): string {
  return `${base.replace(/\/+$/, "")}/bot${token}/${method}`;
}

export type CallResult<T> = { ok: true; result: T } | { ok: false; status: number; error: string };

/**
 * Call one Bot API method with a JSON body. Every failure is folded into a
 * `{ ok: false }` with a message that never contains the token: network errors
 * report only the error class (a fetch error can echo the URL), and Telegram's
 * own `description` never includes it.
 */
export async function callTelegram<T>(
  token: string,
  method: string,
  params: Record<string, unknown>,
  opts: { base?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CallResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(methodUrl(token, method, opts.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dropUndefined(params)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
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
  const description =
    isRecord(json) && typeof json.description === "string" ? json.description : "unknown error";
  return { ok: false, status: res.status, error: explainError(res.status, description) };
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

function dropUndefined(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v;
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- normalization ----------------------------------------------------------

export interface NormalizedChat {
  id: number | null;
  type: string | null;
  title: string | null;
  username: string | null;
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

export interface NormalizedUpdate {
  update_id: number | null;
  type: string;
  message: NormalizedMessage | null;
  reaction: { emoji: string[] } | null;
  callback_data: string | null;
}

const MESSAGE_UPDATE_KINDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
] as const;

// Media fields whose value is a single object carrying a file_id.
const SINGLE_FILE_MEDIA = [
  "document",
  "audio",
  "video",
  "voice",
  "video_note",
  "animation",
  "sticker",
] as const;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function normalizeChat(raw: unknown): NormalizedChat | null {
  if (!isRecord(raw)) return null;
  const personal = [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ");
  return {
    id: num(raw.id),
    type: str(raw.type),
    title: str(raw.title) ?? (personal || null),
    username: str(raw.username),
  };
}

export function normalizeUser(raw: unknown): NormalizedUser | null {
  if (!isRecord(raw)) return null;
  const name = [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ");
  return {
    id: num(raw.id),
    is_bot: typeof raw.is_bot === "boolean" ? raw.is_bot : null,
    username: str(raw.username),
    name: name || null,
  };
}

function mediaOf(raw: Record<string, unknown>): NormalizedMedia[] {
  const media: NormalizedMedia[] = [];
  // `photo` is an array of sizes; the last is the largest.
  if (Array.isArray(raw.photo) && raw.photo.length > 0) {
    const largest = raw.photo[raw.photo.length - 1];
    media.push({
      kind: "photo",
      file_id: isRecord(largest) ? str(largest.file_id) : null,
      file_name: null,
      mime_type: null,
    });
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
  const date = num(raw.date);
  const reply = isRecord(raw.reply_to_message) ? num(raw.reply_to_message.message_id) : null;
  return {
    message_id: num(raw.message_id),
    date: date === null ? null : new Date(date * 1000).toISOString(),
    chat: normalizeChat(raw.chat),
    from: normalizeUser(raw.from) ?? normalizeUser(raw.sender_chat),
    text: str(raw.text) ?? str(raw.caption),
    reply_to_message_id: reply,
    message_thread_id: num(raw.message_thread_id),
    media: mediaOf(raw),
  };
}

export function normalizeUpdate(raw: unknown): NormalizedUpdate {
  const rec = isRecord(raw) ? raw : {};
  const update_id = num(rec.update_id);
  for (const kind of MESSAGE_UPDATE_KINDS) {
    if (isRecord(rec[kind])) {
      return { update_id, type: kind, message: normalizeMessage(rec[kind]), reaction: null, callback_data: null };
    }
  }
  if (isRecord(rec.message_reaction)) {
    const r = rec.message_reaction;
    const emoji = Array.isArray(r.new_reaction)
      ? r.new_reaction.flatMap((x) => (isRecord(x) && typeof x.emoji === "string" ? [x.emoji] : []))
      : [];
    return {
      update_id,
      type: "message_reaction",
      message: {
        message_id: num(r.message_id),
        date: num(r.date) === null ? null : new Date((r.date as number) * 1000).toISOString(),
        chat: normalizeChat(r.chat),
        from: normalizeUser(r.user) ?? normalizeUser(r.actor_chat),
        text: null,
        reply_to_message_id: null,
        message_thread_id: null,
        media: [],
      },
      reaction: { emoji },
      callback_data: null,
    };
  }
  if (isRecord(rec.callback_query)) {
    const q = rec.callback_query;
    const msg = normalizeMessage(q.message);
    return {
      update_id,
      type: "callback_query",
      message: msg ? { ...msg, from: normalizeUser(q.from) } : null,
      reaction: null,
      callback_data: str(q.data),
    };
  }
  // Any other update kind (poll, chat_member, ...): report its kind so the
  // caller knows it exists and can advance the offset past it.
  const kind = Object.keys(rec).find((k) => k !== "update_id") ?? "unknown";
  return { update_id, type: kind, message: null, reaction: null, callback_data: null };
}

/** Offset that acknowledges every update in `updates` (Bot API: last id + 1). */
export function nextOffset(updates: NormalizedUpdate[]): number | null {
  let max: number | null = null;
  for (const u of updates) if (u.update_id !== null && (max === null || u.update_id > max)) max = u.update_id;
  return max === null ? null : max + 1;
}

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
