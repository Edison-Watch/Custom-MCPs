"""Reddit scraper service - first-party wrapper over an Apify Actor.

Calls the Apify ``run-sync-get-dataset-items`` endpoint, which starts the Actor,
blocks until it finishes, and returns its dataset in one HTTP response. That
keeps the service a pure synchronous ``@service`` function with no polling or
run-state bookkeeping. Apify caps a synchronous run at 300s; queries expected to
exceed that should move to an async run + dataset fetch instead.

Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
"""

from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from loguru import logger as log

from common import global_config
from models.reddit import (
    NormalizedRedditItem,
    RedditItemType,
    RedditScrapeInput,
    RedditScrapeResult,
)
from services import service

# Default Actor slug in tilde form (username~name). trudax/reddit-scraper-lite is
# pay-per-result (~$0.0038/item) rather than the $45/mo flat-rate sibling.
# Overridable at runtime via APIFY_ACTOR_ID; the normalizer maps whichever Actor
# is configured onto the stable NormalizedRedditItem shape (see below).
_DEFAULT_ACTOR_ID = "trudax~reddit-scraper-lite"
_APIFY_BASE = "https://api.apify.com/v2"
# Apify's hard ceiling for a synchronous run; also what we ask the run to honour.
_RUN_TIMEOUT_S = 300
# Give httpx headroom over the server-side run timeout so the 300s cap surfaces
# as an Apify response, not a client read timeout.
_HTTP_TIMEOUT_S = 330.0


def _actor_id() -> str:
    """The configured Actor slug, or the default when APIFY_ACTOR_ID is unset."""
    return (global_config.APIFY_ACTOR_ID or "").strip() or _DEFAULT_ACTOR_ID


class ApifyError(RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out."""


# --- Normalization ----------------------------------------------------------
#
# Each Actor names its output fields differently, so callers should never depend
# on a specific Actor's raw keys. These per-Actor field maps translate an Actor's
# item onto the stable NormalizedRedditItem shape. A map keys a normalized field
# to an ordered list of candidate source keys; the first key present with a
# non-None value wins. Adding a new Actor is a data change (one map + one
# registry entry), not new mapping code.

# The trudax family (reddit-scraper-lite and its flat-rate reddit-scraper
# sibling) share one output schema, verified from Apify's documented actor
# schemas: posts carry upVotes / numberOfComments / upVoteRatio; comments carry
# numberOfVotes and their text under description. reddit-scraper-lite in its
# default RSS mode omits the engagement fields, so they normalize to None; the
# flat-rate reddit-scraper returns them, so pointing APIFY_ACTOR_ID at it makes
# counts flow through this same map with no code change.
_TRUDAX_FIELD_MAP: dict[str, list[str]] = {
    "id": ["id", "parsedId"],
    "type": ["dataType"],
    "title": ["title"],
    "body": ["body", "description", "html"],
    "author": ["username", "author"],
    "subreddit": ["communityName", "parsedCommunityName"],
    "url": ["url"],
    "permalink": ["permalink"],
    "created_at": ["createdAt"],
    "score": ["upVotes", "numberOfVotes"],
    "num_comments": ["numberOfComments"],
    "upvote_ratio": ["upVoteRatio"],
    "over_18": ["over18"],
    "num_crossposts": ["numberOfCrossposts"],
}

# Fallback for an Actor with no registered map: a broad candidate-key list
# spanning snake_case (Reddit's own JSON API) and common camelCase variants.
# Best-effort only - a bespoke Actor should get its own entry in
# _FIELD_MAP_BY_ACTOR rather than rely on these guesses.
_DEFAULT_FIELD_MAP: dict[str, list[str]] = {
    "id": ["id", "name"],
    "type": ["type", "dataType", "kind"],
    "title": ["title"],
    "body": ["body", "selftext", "text", "description", "html"],
    "author": ["author", "username", "user"],
    "subreddit": ["subreddit", "communityName", "community"],
    "url": ["url", "link"],
    "permalink": ["permalink"],
    "created_at": ["created_at", "createdAt", "created_utc", "created"],
    "score": ["score", "upVotes", "ups", "numberOfVotes"],
    "num_comments": ["num_comments", "numberOfComments", "comments", "commentCount"],
    "upvote_ratio": ["upvote_ratio", "upVoteRatio"],
    "over_18": ["over_18", "over18", "nsfw"],
    "num_crossposts": ["num_crossposts", "numberOfCrossposts", "crossposts"],
}

_FIELD_MAP_BY_ACTOR: dict[str, dict[str, list[str]]] = {
    "trudax~reddit-scraper-lite": _TRUDAX_FIELD_MAP,
    "trudax~reddit-scraper": _TRUDAX_FIELD_MAP,
}

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


def _field_map_for(actor_id: str) -> dict[str, list[str]]:
    # Strip an Apify build tag (`actor:tag`) before lookup.
    base = actor_id.split(":", 1)[0]
    return _FIELD_MAP_BY_ACTOR.get(base, _DEFAULT_FIELD_MAP)


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
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except ValueError:
            return None
    return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


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
        return datetime.fromtimestamp(value, tz=UTC).isoformat()
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
    fmap = _field_map_for(actor_id)

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


def _build_actor_input(inp: RedditScrapeInput) -> dict:
    """Map the first-party input onto the Actor's input schema."""
    actor_input: dict = {
        "maxItems": inp.max_items,
        "maxPostCount": inp.max_items,
        "skipComments": not inp.include_comments,
        "includeNSFW": inp.include_nsfw,
        "sort": inp.sort,
        "proxy": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
    }
    if inp.search:
        actor_input["searches"] = [inp.search]
    if inp.subreddit:
        actor_input["searchCommunityName"] = inp.subreddit
    if inp.start_urls:
        actor_input["startUrls"] = [{"url": u} for u in inp.start_urls]
    if inp.time_filter:
        actor_input["time"] = inp.time_filter
    return actor_input


@service(
    name="reddit_scrape",
    description=(
        "Scrape Reddit posts, comments, communities, or users via a search term "
        "or explicit URLs. Returns the matched items."
    ),
    input_model=RedditScrapeInput,
    output_model=RedditScrapeResult,
)
def reddit_scrape(input: RedditScrapeInput) -> RedditScrapeResult:
    token = global_config.APIFY_API_KEY
    if not token:
        raise ApifyError(
            "APIFY_API_KEY is not configured. Set it in your .env to use the "
            "Reddit scraper."
        )

    actor_id = _actor_id()
    url = f"{_APIFY_BASE}/acts/{actor_id}/run-sync-get-dataset-items"
    params = {"timeout": _RUN_TIMEOUT_S, "format": "json"}
    # Bearer header rather than a ?token= query param: Apify recommends it, and
    # it keeps the secret out of URLs that proxies and servers may log.
    headers = {"Authorization": f"Bearer {token}"}
    actor_input = _build_actor_input(input)

    log.info("reddit_scrape: starting Apify run for actor {}", actor_id)
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, params=params, headers=headers, json=actor_input)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Apify puts a JSON {"error": {...}} body on 4xx/5xx; surface it.
        raise ApifyError(
            f"Apify returned {exc.response.status_code}: {exc.response.text[:500]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ApifyError(f"Could not reach Apify: {type(exc).__name__}: {exc}") from exc

    try:
        items = resp.json()
    except ValueError as exc:
        raise ApifyError(f"Apify returned invalid JSON: {exc}") from exc

    if not isinstance(items, list):
        raise ApifyError(f"Unexpected Apify response shape: {type(items).__name__}")
    if not all(isinstance(item, dict) for item in items):
        raise ApifyError("Apify returned a dataset item that is not an object")

    log.info("reddit_scrape: run returned {} items", len(items))
    normalized = normalize_items(items, actor_id)
    return RedditScrapeResult(count=len(normalized), items=normalized)
