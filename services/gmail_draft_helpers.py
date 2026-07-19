"""Shared helpers for the Gmail draft services.

These functions are imported by both ``gmail_drafts_svc`` (compose / update /
get) and ``gmail_attachments_svc`` (add / remove attachment). They live here -
rather than in either service module - so neither has to import the other,
keeping the import graph acyclic.

The central idea: Gmail's ``drafts().update`` is a *whole-message replace*. To
edit one field (or one attachment) without clobbering the rest, callers read
the current draft, compute the desired full state, and hand it to
``_rebuild_draft``. Existing attachment bytes are re-downloaded from the live
message (Gmail stores them separately, keyed by ``attachmentId``) and
re-attached so they survive the replace.
"""

from __future__ import annotations

import base64
from typing import Any

from models.gmail import (
    AttachmentReference,
    AttachmentUpload,
    GmailDraft,
    GmailDraftAttachment,
    GmailUpdateDraftInput,
    InlineImageUpload,
    _UnsetType,
)
from services.gmail_svc import _build_raw_message, _parse_message_resource


def _attachment_not_found(attachment_id: str, draft_id: str) -> ValueError:
    """Uniform error for an attachment_id that is not on a draft."""
    return ValueError(f"attachment_id {attachment_id!r} is not on draft {draft_id!r}")


def _draft_resource_to_model(draft: dict[str, Any]) -> GmailDraft:
    """Map a Gmail ``drafts.get(format=full)`` payload to ``GmailDraft``."""
    msg = draft.get("message") or {}
    parsed = _parse_message_resource(msg)
    msg_id = parsed.get("message_id") or ""
    atts = [
        GmailDraftAttachment(
            filename=a.get("filename"),
            mime_type=a.get("mime_type"),
            size=a.get("size"),
            attachment_id=a.get("attachment_id"),
            message_id=msg_id,
        )
        for a in parsed.get("attachments") or []
        if a.get("filename")
    ]
    return GmailDraft(
        draft_id=draft.get("id") or "",
        thread_id=parsed.get("thread_id"),
        to=parsed.get("to"),
        cc=parsed.get("cc"),
        bcc=parsed.get("bcc"),  # drafts retain Bcc until sent
        subject=parsed.get("subject"),
        body=parsed.get("body_text") or parsed.get("body_html"),
        attachments=atts,
    )


def _fetch_draft_model(svc: Any, draft_id: str) -> GmailDraft:
    """Re-read a draft at ``format=full`` and map it - the authoritative saved state.

    Gmail's ``drafts().create`` / ``drafts().update`` responses carry only a
    minimal message (``id`` / ``threadId``), so mapping them directly yields an
    all-null ``GmailDraft`` and misses the attachment ids Gmail assigns during
    the whole-message replace. A follow-up ``get`` returns the persisted
    recipients, subject, body, and current attachment ids that every draft
    mutation's response contract promises.
    """
    full = svc.users().drafts().get(userId="me", id=draft_id, format="full").execute()
    return _draft_resource_to_model(full)


def _download_attachment_data(svc: Any, message_id: str, attachment_id: str) -> str:
    """Return the base64url-encoded bytes of an attachment already on a message.

    Gmail stores attachment bodies separately from the message envelope, keyed
    by ``attachmentId``. ``drafts().update`` replaces the whole MIME message, so
    to preserve an existing file across an edit we must re-download its bytes
    and re-attach them.
    """
    blob = (
        svc.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=message_id, id=attachment_id)
        .execute()
    )
    return blob.get("data") or ""


def _current_attachments(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Named, byte-retrievable attachments currently on a parsed draft message.

    Filters to parts that have a filename AND either a Gmail ``attachmentId``
    (downloadable via the attachments API) or inline ``data`` already in hand.
    Parts with neither (some inline image variants, malformed parts) are
    excluded so a preserve/rebuild never calls the attachments API with an
    empty id.
    """
    return [
        a
        for a in (parsed.get("attachments") or [])
        if a.get("filename") and (a.get("attachment_id") or a.get("data"))
    ]


def _resolve_inline_images(
    svc: Any, message_id: str, parsed: dict[str, Any]
) -> list[InlineImageUpload]:
    """Resolve CID-referenced inline images (filename-less ``Content-ID`` parts).

    These belong to the HTML body, so they are preserved whenever the HTML body
    is. ``_parse_message_resource`` captures inline-image bytes as *standard*
    base64; normalize to base64url (the shape ``_build_raw_message`` decodes),
    or re-download by ``attachmentId`` when the bytes were not inlined.
    """
    out: list[InlineImageUpload] = []
    for a in parsed.get("attachments") or []:
        content_id = a.get("content_id")
        if not content_id or a.get("filename"):
            continue
        std_data = a.get("data")
        if std_data:
            raw = base64.b64decode(std_data + "=" * (-len(std_data) % 4))
            data_b64 = base64.urlsafe_b64encode(raw).decode("ascii")
        elif a.get("attachment_id"):
            data_b64 = _download_attachment_data(svc, message_id, a["attachment_id"])
        else:
            continue
        out.append(
            InlineImageUpload(
                content_id=content_id,
                mime_type=a.get("mime_type") or "application/octet-stream",
                data_base64=data_b64,
            )
        )
    return out


def _existing_to_upload(
    svc: Any, message_id: str, meta: dict[str, Any]
) -> AttachmentUpload:
    """Resolve an existing draft attachment into an ``AttachmentUpload``.

    Uses inline ``data`` when the parse already captured it; otherwise
    re-downloads the bytes by ``attachmentId`` (Gmail stores them separately).
    """
    data = meta.get("data") or _download_attachment_data(
        svc, message_id, meta.get("attachment_id") or ""
    )
    return AttachmentUpload(
        filename=meta.get("filename") or "attachment",
        mime_type=meta.get("mime_type") or "application/octet-stream",
        data_base64=data,
    )


def _resolve_update_attachments(
    svc: Any,
    message_id: str,
    parsed: dict[str, Any],
    input: GmailUpdateDraftInput,
) -> list[AttachmentUpload]:
    """Resolve the desired attachment uploads for an update, honoring omit/null.

    - ``attachments`` omitted (``UNSET``)   -> preserve every existing file.
    - ``attachments`` is ``null`` or ``[]`` -> clear all files.
    - ``attachments`` is a list            -> each item is a new upload
      (``AttachmentInput``) or a reference to keep an existing file
      (``AttachmentReference``).
    """
    current = _current_attachments(parsed)
    if isinstance(input.attachments, _UnsetType):
        return [_existing_to_upload(svc, message_id, a) for a in current]
    if input.attachments is None:
        return []

    by_id = {a.get("attachment_id"): a for a in current}
    uploads: list[AttachmentUpload] = []
    for item in input.attachments:
        if isinstance(item, AttachmentReference):
            meta = by_id.get(item.attachment_id)
            if meta is None:
                raise _attachment_not_found(item.attachment_id, input.draft_id)
            uploads.append(_existing_to_upload(svc, message_id, meta))
        else:  # AttachmentInput - fresh upload
            uploads.append(
                AttachmentUpload(
                    filename=item.filename,
                    mime_type=item.mime_type,
                    data_base64=item.data_base64,
                )
            )
    return uploads


def draft_message_body(raw: str, thread_id: str | None) -> dict[str, Any]:
    """Assemble the ``drafts().create``/``update`` request body from a raw MIME.

    Shared so create (compose/reply) and update (rebuild) agree on the
    ``{"message": {"raw", "threadId"}}`` envelope.
    """
    body_dict: dict[str, Any] = {"message": {"raw": raw}}
    if thread_id:
        body_dict["message"]["threadId"] = thread_id
    return body_dict


def _rebuild_draft(
    svc: Any,
    *,
    draft_id: str,
    parsed: dict[str, Any],
    to: str,
    subject: str,
    body: str,
    cc: str | None,
    bcc: str | None,
    attachment_uploads: list[AttachmentUpload],
    body_html: str | None = None,
    in_reply_to: str | None = None,
    references: str | None = None,
    inline_images: list[InlineImageUpload] | None = None,
) -> GmailDraft:
    """Replace a draft's MIME with the given state and return its echoed model.

    ``drafts().update`` is a whole-message replace; callers compute the desired
    field values (preserving what they did not change) and the full attachment
    set before calling this. ``body_html`` preserves HTML-only bodies,
    ``inline_images`` keeps its cid: images, and ``in_reply_to``/``references``
    preserve reply-threading headers.
    """
    raw = _build_raw_message(
        to=to,
        subject=subject,
        body=body,
        body_html=body_html,
        cc=cc,
        bcc=bcc,
        in_reply_to=in_reply_to,
        references=references,
        attachments=attachment_uploads or None,
        inline_images=inline_images or None,
    )
    body_dict = draft_message_body(raw, parsed.get("thread_id"))
    svc.users().drafts().update(userId="me", id=draft_id, body=body_dict).execute()
    # The update response omits the message payload and its post-replace
    # attachment ids; re-fetch at format=full for the true saved state.
    return _fetch_draft_model(svc, draft_id)
