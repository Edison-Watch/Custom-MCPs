# `telegram-bot` - Edison first-party MCP server

Drive your own Telegram bot through the Bot API: read the messages it receives,
look up chats, and send, edit, forward, react to, pin, and delete messages.

- **Runtime:** TypeScript on a Cloudflare Worker, **stateless** (no Durable Object).
- **Transport:** streamable HTTP at `/mcp`, JSON responses, no session id.
- **Credential:** each user's own bot token from [@BotFather](https://t.me/BotFather),
  sent as the `X-Telegram-Bot-Token` header. SealGate stores it in its
  zero-knowledge template values (catalog `auth: "token"`) and injects it on
  every call.
- **Fleet auth:** `open` in production (the bot token is what authorizes the work,
  and every call spends the caller's own bot). Self-hosters can set
  `AUTH_MODE=bearer` + an `AUTH_TOKEN` secret to lock the endpoint down.

```
 AI client ──► SealGate (policies, trifecta tracking, encrypted token)
                 │  X-Telegram-Bot-Token: <token>
                 ▼
     telegram.sealgate.ai/mcp   (one McpServer per request, then dropped)
                 │
                 ▼
          api.telegram.org/bot<token>/<method>
```

## Why stateless

`McpAgent` persists its `props` into Durable Object storage, so passing the
token that way would write a live credential to disk. Instead each request
builds its own `McpServer` closed over that request's token and discards it
after responding. The Bot API is itself stateless, so nothing is lost. The token
is checked for shape (`<bot id>:<secret>`, which also stops it reshaping the URL
it is placed in), validated with `getMe` on `initialize` (a rejected token is a
401 at install time), and never logged or echoed in an error.

## Tools

| tool | Bot API | notes |
|------|---------|-------|
| `telegram_get_me` | `getMe` | Which bot is connected. |
| `telegram_get_updates` | `getUpdates` | Unacknowledged messages/events (Telegram keeps 24h). Returns `next_offset`; pass it back as `offset` to acknowledge. Short poll (`timeout: 0`). |
| `telegram_get_chat` | `getChat` + `getChatMemberCount` | Type, title, username, description, member count, pinned message. |
| `telegram_send_message` | `sendMessage` | Text up to 4096 chars, optional `parse_mode`, reply, forum topic, silent, no link preview. |
| `telegram_send_photo` | `sendPhoto` | By `https://` URL (Telegram fetches it) or `file_id`. |
| `telegram_send_document` | `sendDocument` | Same sources as photo. |
| `telegram_forward_message` | `forwardMessage` | Between chats the bot can see. |
| `telegram_edit_message_text` | `editMessageText` | The bot's own messages. |
| `telegram_delete_message` | `deleteMessage` | Own messages, or others' as a group admin (48h). |
| `telegram_set_reaction` | `setMessageReaction` | One emoji, or omit to clear. |
| `telegram_pin_message` | `pinChatMessage` / `unpinChatMessage` | `unpin: true` to unpin. |

`chat_id` is an integer id (negative for groups/channels) or a public
`@username`. Messages come back normalized: `message_id`, ISO `date`, `chat`,
`from`, `text` (or caption), `reply_to_message_id`, `message_thread_id`, and
`media` (`kind`, `file_id`, `file_name`, `mime_type`).

## Limits of a bot

- **No history.** Bots only see messages sent after they joined, through
  `getUpdates`. Older chat history is not readable with the Bot API.
- **One consumer.** Telegram delivers each update once. `getUpdates` fails with
  409 while the bot has a webhook, or while another process polls it. Use a
  dedicated bot, never SealGate's own notification bot.
- **Groups:** with privacy mode on (the default) a bot only receives commands and
  replies to it. Turn it off in @BotFather (`/setprivacy`) to see all messages.

## Develop

```bash
bun install
bun run test               # unit (offline)
bun run typecheck
bun run test:integration   # workerd, Telegram mocked with fetchMock
bun run dev                # wrangler dev
```

## Deploy

`servers_deploy.yaml` deploys every connector with a `wrangler.jsonc` on merge.
There are no secrets to set. The custom domain `telegram.sealgate.ai` must be on
a zone in the same Cloudflare account.
