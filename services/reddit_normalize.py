"""Actor-agnostic normalization for the Reddit scraper service.

Each Apify Actor names its output fields differently, so the service maps every
item onto the stable ``NormalizedRedditItem`` shape defined in
``models/reddit.py`` and keeps the untouched Actor item under ``raw``. Splitting
this pure mapping layer out of ``services/reddit_svc.py`` keeps that module
focused on the Apify HTTP transport (sync run and the async run + poll pair),
which all funnel their dataset items through ``normalize_items`` here.

The per-Actor field map (which raw keys feed each normalized field) lives with
that Actor's input builder in ``services/reddit_adapters.py``; this module reads
it via ``adapter_for`` and owns only the coercion helpers (types, dates, etc.).

Mirrors the TypeScript normalizer in ``servers/reddit/src/reddit.ts``.
"""

import math
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from models.reddit import NormalizedRedditItem, RedditItemType
from services.reddit_adapters import adapter_for

# Raw type/kind discriminators (incl. Reddit's t1/t3/t5/t2 codes) -> our literal.
_TYPE_ALIASES: dict[str, RedditItemType] = {
    "post": "post",
    "link": "post",
    "t3": "post",
    "comment": "comment",
    "t1": "comment",
    "community": "community",
    "subreddit": "community",
    "sr": "community",
    "t5": "community",
    "user": "user",
    "account": "user",
    "t2": "user",
}


def _first_present(raw: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        value = raw.get(key)
        if value is not None:
            return value
    return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def _as_int(value: Any) -> int | None:
    # bool is an int subclass but never a count, so reject it explicitly.
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        f = value
    elif isinstance(value, str):
        try:
            f = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    # NaN/Infinity have no integer form (int(inf) raises OverflowError,
    # int(nan) ValueError); return None to match the TS normalizer's null.
    if not math.isfinite(f):
        return None
    try:
        return int(f)
    except (ValueError, OverflowError):
        return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        try:
            f = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    # A non-finite float (NaN/Infinity) is not a usable ratio; match TS -> None.
    return f if math.isfinite(f) else None


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "1", "yes"):
            return True
        if low in ("false", "0", "no", ""):
            return False
    return None


def _as_iso(value: Any) -> str | None:
    # A Unix epoch (seconds) becomes an ISO8601 UTC string; a string passes
    # through unchanged (trudax already emits ISO8601).
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        # Emit the canonical `Z` suffix with millisecond precision so this
        # matches the Worker's Date.toISOString() output byte for byte (it
        # always emits exactly three fractional digits).
        return (
            datetime.fromtimestamp(value, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    if isinstance(value, str):
        return value.strip() or None
    return None


def _as_type(value: Any) -> RedditItemType | None:
    if not isinstance(value, str):
        return None
    return _TYPE_ALIASES.get(value.strip().lower())


def _clean_subreddit(value: Any) -> str | None:
    text = _as_str(value)
    if text is None:
        return None
    text = text.strip()
    for prefix in ("/r/", "r/"):
        if text.lower().startswith(prefix):
            text = text[len(prefix) :]
            break
    return text or None


def _derive_permalink(explicit: Any, url: Any) -> str | None:
    # Prefer an explicit permalink; otherwise recover the path from a reddit.com
    # URL so downstream consumers get a stable permalink even when the Actor
    # only returns a full URL.
    text = _as_str(explicit)
    if text:
        return text
    full = _as_str(url)
    if not full:
        return None
    try:
        parsed = urlparse(full)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if parsed.path and (host == "reddit.com" or host.endswith(".reddit.com")):
        return parsed.path
    return None


def normalize_item(raw: dict[str, Any], actor_id: str) -> NormalizedRedditItem:
    """Map one raw Actor item onto the stable NormalizedRedditItem shape."""
    fmap = adapter_for(actor_id).field_map

    def pick(field: str) -> Any:
        return _first_present(raw, fmap.get(field, []))

    return NormalizedRedditItem(
        id=_as_str(pick("id")),
        type=_as_type(pick("type")),
        title=_as_str(pick("title")),
        body=_as_str(pick("body")),
        author=_as_str(pick("author")),
        subreddit=_clean_subreddit(pick("subreddit")),
        url=_as_str(pick("url")),
        permalink=_derive_permalink(pick("permalink"), pick("url")),
        created_at=_as_iso(pick("created_at")),
        score=_as_int(pick("score")),
        num_comments=_as_int(pick("num_comments")),
        upvote_ratio=_as_float(pick("upvote_ratio")),
        over_18=_as_bool(pick("over_18")),
        num_crossposts=_as_int(pick("num_crossposts")),
        raw=raw,
    )


def normalize_items(
    items: list[dict[str, Any]], actor_id: str
) -> list[NormalizedRedditItem]:
    return [normalize_item(item, actor_id) for item in items]
