// Fixture data for the MCP-UI dev preview. No Gmail, no OAuth, no network -
// these canned payloads stand in for the responses a real MCP server would
// return, so a committed app bundle can be rendered in isolation.
//
// Shapes mirror the app types (see mcp_server/apps/*/src/*.tsx). When a tool's
// contract changes, update the matching entry here.

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: (data ?? {}) as Record<string, unknown>,
  };
}

// --- gmail_inbox ----------------------------------------------------------

const INBOX_CURATE = {
  threads: [
    {
      thread_id: "t-1001",
      subject: "Series A term sheet - final redlines",
      from: "Dana Whitfield <dana@northwind.vc>",
      snippet:
        "Great call today. Attaching the final redlines - one open point on the liquidation preference…",
      last_message_at: "2026-07-05T09:14:00Z",
      importance_score: 0.97,
      reasons: ["Unread", "VIP sender", "Awaiting reply"],
      labels: [
        { name: "Unread", bg_color: "#e8f0fe", text_color: "#1a73e8" },
        { name: "Finance", bg_color: "#e6f4ea", text_color: "#137333" },
      ],
      has_draft: false,
    },
    {
      thread_id: "t-1002",
      subject: "Re: Onsite interview loop for Staff Eng",
      from: "Priya Nair <priya@peoplehq.io>",
      snippet:
        "Confirming Thursday 10am–2pm. I've looped in the panel. Let me know if the schedule works…",
      last_message_at: "2026-07-05T07:41:00Z",
      importance_score: 0.82,
      reasons: ["Unread", "Calendar"],
      labels: [{ name: "Unread", bg_color: "#e8f0fe", text_color: "#1a73e8" }],
      has_draft: true,
      draft_id: "d-9001",
    },
    {
      thread_id: "t-1003",
      subject: "Your invoice #INV-2043 is ready",
      from: "billing@vercel.com",
      snippet: "Your monthly invoice is now available. Amount due: $240.00…",
      last_message_at: "2026-07-04T22:03:00Z",
      importance_score: 0.44,
      reasons: ["Receipt"],
      labels: [{ name: "Receipts", bg_color: "#fef7e0", text_color: "#b06000" }],
      has_draft: false,
    },
  ],
};

const THREADS: Record<string, unknown> = {
  "t-1001": {
    thread_id: "t-1001",
    messages: [
      {
        message_id: "m-1",
        from: "Dana Whitfield <dana@northwind.vc>",
        to: "you@startup.com",
        date: "2026-07-05T09:14:00Z",
        subject: "Series A term sheet - final redlines",
        body_html:
          "<p>Hi,</p><p>Great call today. Attaching the final redlines - one open point on the <b>liquidation preference</b> (we're proposing 1x non-participating).</p><p>If that works, we can sign this week.</p><p>Best,<br/>Dana</p>",
        attachments: [
          { filename: "termsheet-v7.pdf", mime_type: "application/pdf", size: 184320 },
        ],
      },
    ],
  },
  "t-1002": {
    thread_id: "t-1002",
    messages: [
      {
        message_id: "m-2",
        from: "Priya Nair <priya@peoplehq.io>",
        to: "you@startup.com",
        date: "2026-07-05T07:41:00Z",
        subject: "Re: Onsite interview loop for Staff Eng",
        body_text:
          "Confirming Thursday 10am-2pm. I've looped in the panel. Let me know if the schedule works and I'll send calendar holds.\n\nThanks,\nPriya",
        attachments: [],
      },
    ],
    draft: {
      draft_id: "d-9001",
      to: "priya@peoplehq.io",
      subject: "Re: Onsite interview loop for Staff Eng",
      body: "Thursday works great - please send the holds. Looking forward to it.",
      thread_id: "t-1002",
      attachments: [],
    },
  },
  "t-1003": {
    thread_id: "t-1003",
    messages: [
      {
        message_id: "m-3",
        from: "billing@vercel.com",
        to: "you@startup.com",
        date: "2026-07-04T22:03:00Z",
        subject: "Your invoice #INV-2043 is ready",
        body_text:
          "Your monthly invoice is now available. Amount due: $240.00. No action needed - auto-pay is on.",
        attachments: [],
      },
    ],
  },
};

// --- gmail_composer -------------------------------------------------------

const COMPOSER_DRAFT = {
  draft_id: "d-9001",
  to: "priya@peoplehq.io",
  cc: "",
  bcc: "",
  subject: "Re: Onsite interview loop for Staff Eng",
  body:
    "Hi Priya,\n\nThursday 10am–2pm works great - please send the calendar holds and I'll confirm with the panel on my side.\n\nLooking forward to it.\n\nBest,\nAlex",
  thread_id: "t-1002",
  attachments: [],
};

// --- dispatch -------------------------------------------------------------

/** The first tool result pushed to the app on init (drives the initial paint). */
export function initialResult(app: string): ToolResult {
  if (app === "gmail_composer") return ok(COMPOSER_DRAFT);
  return ok(INBOX_CURATE);
}

/** Answer an app's callServerTool by name, as a real server would. */
export function dispatch(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "gmail_inbox.refresh":
      return ok(INBOX_CURATE);
    case "gmail_inbox.open_thread":
    case "gmail_composer.get_thread":
      return ok(THREADS[String(args.thread_id)] ?? {});
    case "gmail_composer.refresh":
      return ok(COMPOSER_DRAFT);
    case "gmail_composer.send":
      // A real message_id so the composer's Sent state (and the model-context
      // push it triggers) carries a plausible identifier.
      return ok({ message_id: "msg-fixture-0042", thread_id: "t-1002" });
    default:
      // set_focus, mark_read, archive, mark_done, reply, forward, save_draft,
      // send, discard … acknowledged with an empty structured result.
      return ok({});
  }
}
