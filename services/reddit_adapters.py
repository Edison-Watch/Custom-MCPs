"""Per-Actor adapters for the Reddit scraper.

Each supported Apify Actor takes a different input schema *and* emits different
output field names. An adapter pairs the two halves - an input builder and an
output field map - into a single object, so the input we send and the output we
normalize can never disagree on the Actor: one registry is the single source of
truth per Actor. Both the HTTP transport (``services/reddit_svc.py``, which
calls ``build_input``) and the normalizer (``services/reddit_normalize.py``,
which reads ``field_map``) resolve through ``adapter_for``.

Adding an Actor is a one-line data change here (one registry entry), never an
edit spread across modules. Mirrors the TypeScript adapters in
``servers/reddit/src/adapters.ts`` - the two registries must register the same
Actor slugs (``tests/test_reddit_adapters.py`` asserts this cross-language).
"""

from collections.abc import Callable
from dataclasses import dataclass

from models.reddit import RedditScrapeInput

# A field map keys a normalized field to an ordered list of candidate source
# keys; the normalizer takes the first present with a non-null value.
FieldMap = dict[str, list[str]]


# --- Output field maps ------------------------------------------------------

# The trudax family (reddit-scraper-lite and its flat-rate reddit-scraper
# sibling) share one output schema, verified from Apify's documented actor
# schemas: posts carry upVotes / numberOfComments / upVoteRatio; comments carry
# numberOfVotes and their text under description. reddit-scraper-lite in its
# default fast RSS mode omits the engagement fields, so they normalize to None;
# setting include_media_links (the Actor's includeMediaLinks input) switches it
# to a detailed scrape that returns them, and they flow through this same map.
_TRUDAX_FIELD_MAP: FieldMap = {
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

# fatihtahta/reddit-scraper-search-fast emits Reddit's native snake_case fields
# plus derived extras. ``kind`` is the post/comment discriminator; ``created_utc``
# arrives as an ISO8601 string (the normalizer's ``_as_iso`` also accepts an
# epoch number, so a numeric variant still normalizes). Engagement counts are
# always present.
_FATIHTAHTA_FIELD_MAP: FieldMap = {
    "id": ["id"],
    "type": ["kind"],
    "title": ["title"],
    "body": ["body"],
    "author": ["author"],
    "subreddit": ["subreddit", "subreddit_name_prefixed"],
    "url": ["url", "canonical_url"],
    "permalink": ["permalink"],
    "created_at": ["created_utc"],
    "score": ["score"],
    "num_comments": ["num_comments"],
    "upvote_ratio": ["upvote_ratio"],
    "over_18": ["over_18"],
    "num_crossposts": ["num_crossposts"],
}

# Fallback for an Actor with no registered adapter: a broad candidate-key list
# spanning snake_case (Reddit's own JSON API) and common camelCase variants.
# Best-effort only - a bespoke Actor should get its own adapter rather than rely
# on these guesses.
_DEFAULT_FIELD_MAP: FieldMap = {
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


# --- Input builders ---------------------------------------------------------


def _build_trudax_input(inp: RedditScrapeInput) -> dict:
    """trudax/reddit-scraper-lite (and its flat-rate sibling) input schema."""
    actor_input: dict = {
        "maxItems": inp.max_items,
        "maxPostCount": inp.max_items,
        "skipComments": not inp.include_comments,
        "includeNSFW": inp.include_nsfw,
        # The Actor's fast RSS mode omits engagement fields; includeMediaLinks
        # switches it to a detailed scrape that returns upVotes / numberOfComments
        # / upVoteRatio (and media URLs), which the trudax field map picks up.
        "includeMediaLinks": inp.include_media_links,
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


def _fatihtahta_sort(sort: str) -> str:
    # This Actor's sort enum omits "rising" (relevance/hot/top/new/comments);
    # map that one value onto the nearest trending sort instead of sending an
    # input the Actor would reject. Every other value passes straight through.
    return "hot" if sort == "rising" else sort


def _build_fatihtahta_input(inp: RedditScrapeInput) -> dict:
    """fatihtahta/reddit-scraper-search-fast input schema.

    Distinct from trudax: ``queries`` (not ``searches``), ``maxPosts`` (not
    maxItems/maxPostCount), ``urls`` as bare strings (not ``{"url": ...}``),
    ``scrapeComments`` (not skipComments), ``subredditName`` (not
    searchCommunityName), ``timeframe`` (not time), ``includeNsfw``. It handles
    its own proxying (no ``proxy`` block) and always returns engagement fields,
    so ``include_media_links`` has no effect here.
    """
    actor_input: dict = {
        "maxPosts": inp.max_items,
        "scrapeComments": inp.include_comments,
        "includeNsfw": inp.include_nsfw,
        "sort": _fatihtahta_sort(inp.sort),
    }
    if inp.search:
        actor_input["queries"] = [inp.search]
    if inp.subreddit:
        actor_input["subredditName"] = inp.subreddit
    if inp.start_urls:
        actor_input["urls"] = list(inp.start_urls)
    if inp.time_filter:
        actor_input["timeframe"] = inp.time_filter
    return actor_input


# --- Adapter registry -------------------------------------------------------


@dataclass(frozen=True)
class RedditActorAdapter:
    """An Actor's input builder and output field map, kept together."""

    build_input: Callable[[RedditScrapeInput], dict]
    field_map: FieldMap


_TRUDAX_ADAPTER = RedditActorAdapter(_build_trudax_input, _TRUDAX_FIELD_MAP)
_FATIHTAHTA_ADAPTER = RedditActorAdapter(_build_fatihtahta_input, _FATIHTAHTA_FIELD_MAP)
# Unknown Actor: the long-standing trudax-style input shape plus the broad,
# best-effort output map. A bespoke Actor should get its own adapter instead.
_DEFAULT_ADAPTER = RedditActorAdapter(_build_trudax_input, _DEFAULT_FIELD_MAP)

ADAPTER_BY_ACTOR: dict[str, RedditActorAdapter] = {
    "trudax~reddit-scraper-lite": _TRUDAX_ADAPTER,
    "trudax~reddit-scraper": _TRUDAX_ADAPTER,
    "fatihtahta~reddit-scraper-search-fast": _FATIHTAHTA_ADAPTER,
}


def adapter_for(actor_id: str) -> RedditActorAdapter:
    """The adapter for an Actor slug, or the default for an unregistered one."""
    # Strip an Apify build tag (`actor:tag`) before lookup.
    base = actor_id.split(":", 1)[0]
    return ADAPTER_BY_ACTOR.get(base, _DEFAULT_ADAPTER)
