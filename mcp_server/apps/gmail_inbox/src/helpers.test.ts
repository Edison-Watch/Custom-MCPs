import { describe, expect, it } from "vitest";
import { buildAttachmentsPayload } from "./helpers";
import type { ExistingAttachment, FileAttachment } from "./types";

const upload = (filename: string): FileAttachment => ({
  filename,
  mime_type: "application/pdf",
  data_base64: "QkFTRTY0",
  size: 10,
});

const existing = (attachment_id?: string): ExistingAttachment => ({
  filename: `keep-${attachment_id ?? "none"}.pdf`,
  mime_type: "application/pdf",
  size: 20,
  attachment_id,
  message_id: "m-1",
});

describe("buildAttachmentsPayload", () => {
  it("returns undefined when attachments were not changed so the arg is omitted (preserve-all)", () => {
    expect(buildAttachmentsPayload([], [existing("att-1")], false)).toBeUndefined();
  });

  it("keeps existing files by reference ahead of new uploads", () => {
    const result = buildAttachmentsPayload(
      [upload("new.pdf")],
      [existing("att-1"), existing("att-2")],
      true,
    );
    expect(result).toEqual([
      { attachment_id: "att-1" },
      { attachment_id: "att-2" },
      { filename: "new.pdf", mime_type: "application/pdf", data_base64: "QkFTRTY0" },
    ]);
  });

  it("skips existing attachments that have no attachment_id (cannot be referenced)", () => {
    const result = buildAttachmentsPayload(
      [upload("new.pdf")],
      [existing(undefined), existing("att-9")],
      true,
    );
    expect(result).toEqual([
      { attachment_id: "att-9" },
      { filename: "new.pdf", mime_type: "application/pdf", data_base64: "QkFTRTY0" },
    ]);
  });

  it("emits only the new uploads when there are no existing files", () => {
    const result = buildAttachmentsPayload([upload("a.pdf")], [], true);
    expect(result).toEqual([
      { filename: "a.pdf", mime_type: "application/pdf", data_base64: "QkFTRTY0" },
    ]);
  });

  it("sends existing refs alone when a new upload was added then removed (changed, no uploads)", () => {
    // Removing the last new upload must still emit the desired set so the
    // removal takes effect server-side rather than preserve-all keeping it.
    const result = buildAttachmentsPayload([], [existing("att-1"), existing("att-2")], true);
    expect(result).toEqual([{ attachment_id: "att-1" }, { attachment_id: "att-2" }]);
  });

  it("clears all when everything was removed (changed, nothing left)", () => {
    expect(buildAttachmentsPayload([], [], true)).toEqual([]);
  });
});
