import type { Draft, DraftAttachment, Thread } from "./types";

// Pull the draft's existing attachments (each with a stable attachment_id) off a
// GmailDraft payload. Only files with an id are usable: the id is what a save
// passes back as a reference to preserve the file in the whole-set replace.
export function extractAttachments(raw: unknown): DraftAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const id = a["attachment_id"];
    if (typeof id !== "string" || id.length === 0) continue;
    // GmailDraftAttachment emits both `size` and the computed `size_bytes`;
    // prefer the public `size_bytes` name and fall back to `size`.
    const rawSize = a["size_bytes"] ?? a["size"];
    out.push({
      attachment_id: id,
      filename:
        typeof a["filename"] === "string" ? (a["filename"] as string) : "(file)",
      mime_type:
        typeof a["mime_type"] === "string" ? (a["mime_type"] as string) : undefined,
      size: typeof rawSize === "number" ? rawSize : undefined,
    });
  }
  return out;
}

export function extractDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapper = raw as { structuredContent?: unknown };
  const data = (wrapper.structuredContent ?? raw) as Record<string, unknown>;
  if (typeof data !== "object" || data === null) return null;
  const draftId = data["draft_id"];
  if (typeof draftId !== "string") return null;
  return {
    draft_id: draftId,
    from: typeof data["from"] === "string" ? (data["from"] as string) : undefined,
    to: typeof data["to"] === "string" ? (data["to"] as string) : undefined,
    cc: typeof data["cc"] === "string" ? (data["cc"] as string) : undefined,
    bcc: typeof data["bcc"] === "string" ? (data["bcc"] as string) : undefined,
    subject:
      typeof data["subject"] === "string" ? (data["subject"] as string) : undefined,
    body: typeof data["body"] === "string" ? (data["body"] as string) : undefined,
    thread_id:
      typeof data["thread_id"] === "string"
        ? (data["thread_id"] as string)
        : undefined,
    attachments: extractAttachments(data["attachments"]),
  };
}

export function fieldsEqual(a: Draft, b: Draft): boolean {
  return (
    a.to === b.to &&
    a.cc === b.cc &&
    a.bcc === b.bcc &&
    a.subject === b.subject &&
    a.body === b.body
  );
}

export function extractThread(raw: unknown): Thread | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapper = raw as { structuredContent?: unknown };
  const data = (wrapper.structuredContent ?? raw) as Record<string, unknown>;
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray((data as { messages?: unknown }).messages)) return null;
  return data as unknown as Thread;
}

// Canonical enumeration of the user-editable draft fields, normalized to the
// empty-string wire form the server tools expect. persistDraft, onSend, and
// sentContextText must all agree on this set - a new Draft field is added
// here, not at each call site.
export function draftFields(draft: Draft): {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
} {
  return {
    to: draft.to ?? "",
    cc: draft.cc ?? "",
    bcc: draft.bcc ?? "",
    subject: draft.subject ?? "",
    body: draft.body ?? "",
  };
}
