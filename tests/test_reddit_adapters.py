"""Tests for the Reddit per-Actor adapters (input builders + output field maps).

Pure, offline unit tests for ``services/reddit_adapters.py``: output
normalization onto the stable ``NormalizedRedditItem`` shape, and the guards that
keep the adapter registry honest (every field map covers all normalized fields,
and the Python registry stays in lockstep with its TypeScript mirror in
``servers/reddit/src/adapters.ts``). Service-level HTTP behavior and input
mapping live in ``tests/test_reddit_scraper.py``.
"""

from __future__ import annotations

import re
from pathlib import Path

from models.reddit import NormalizedRedditItem
from services.reddit_adapters import ADAPTER_BY_ACTOR, adapter_for
from services.reddit_svc import normalize_item
from tests.test_template import TestTemplate

# A representative trudax reddit-scraper-lite POST item (default RSS mode): no
# engagement counts present. Field names per Apify's documented actor schema.
_LITE_POST = {
    "id": "t3_abc",
    "dataType": "post",
    "title": "Async runtimes in Rust",
    "body": "tokio vs async-std",
    "username": "ferris",
    "communityName": "r/rust",
    "url": "https://www.reddit.com/r/rust/comments/abc/async_runtimes/",
    "createdAt": "2023-06-09T05:23:15.000Z",
    "over18": False,
}

# The same shape from the flat-rate trudax reddit-scraper sibling, which DOES
# return engagement counts. Same field names -> same map, counts flow through.
_FULL_POST = {
    **_LITE_POST,
    "upVotes": 1500,
    "numberOfComments": 42,
    "upVoteRatio": 0.98,
    "numberOfCrossposts": 3,
}

# A representative fatihtahta/reddit-scraper-search-fast POST item (trimmed from
# a real run): Reddit-native snake_case with engagement counts always present.
_FATIHTAHTA_POST = {
    "id": "1widcup",
    "kind": "post",
    "title": "How do you cope with AI in the workplace?",
    "body": "Lately, I feel like I have lost my passion for programming.",
    "author": "Lumpy_Response_3443",
    "subreddit": "antiai",
    "subreddit_name_prefixed": "r/antiai",
    "url": "https://www.reddit.com/r/antiai/comments/1widcup/how_do_you_cope/",
    "canonical_url": "https://www.reddit.com/r/antiai/comments/1widcup/how_do_you_cope/",
    "permalink": "/r/antiai/comments/1widcup/how_do_you_cope/",
    "created_utc": "2026-09-16T23:28:56.000Z",
    "score": 2,
    "num_comments": 5,
    "upvote_ratio": 1.0,
    "over_18": False,
    "num_crossposts": 0,
}


class TestRedditNormalize(TestTemplate):
    """Output normalization across each Actor's field map."""

    def test_lite_post_normalizes_engagement_to_none(self):
        # reddit-scraper-lite omits engagement counts -> nullable fields stay
        # None (never faked as 0), while identity fields still map through.
        item = normalize_item(_LITE_POST, "trudax~reddit-scraper-lite")
        assert item.type == "post"
        assert item.title == "Async runtimes in Rust"
        assert item.author == "ferris"
        assert item.subreddit == "rust"  # "r/" prefix stripped
        assert item.created_at == "2023-06-09T05:23:15.000Z"
        assert item.over_18 is False
        assert item.score is None
        assert item.num_comments is None
        assert item.upvote_ratio is None
        assert item.permalink == "/r/rust/comments/abc/async_runtimes/"

    def test_full_actor_engagement_flows_through_same_map(self):
        # Pointing APIFY_ACTOR_ID at the flat-rate sibling makes counts flow
        # with no code change - same trudax field map.
        item = normalize_item(_FULL_POST, "trudax~reddit-scraper")
        assert item.score == 1500
        assert item.num_comments == 42
        assert item.upvote_ratio == 0.98
        assert item.num_crossposts == 3

    def test_fatihtahta_post_normalizes_with_engagement(self):
        # The default Actor's Reddit-native fields map onto the same stable shape
        # as trudax, engagement counts included (parity with the live output).
        item = normalize_item(_FATIHTAHTA_POST, "fatihtahta~reddit-scraper-search-fast")
        assert item.id == "1widcup"
        assert item.type == "post"  # from `kind`
        assert item.title == "How do you cope with AI in the workplace?"
        assert item.author == "Lumpy_Response_3443"
        assert item.subreddit == "antiai"
        assert item.permalink == "/r/antiai/comments/1widcup/how_do_you_cope/"
        assert item.created_at == "2026-09-16T23:28:56.000Z"
        assert item.score == 2
        assert item.num_comments == 5
        assert item.upvote_ratio == 1.0
        assert item.over_18 is False
        assert item.num_crossposts == 0

    def test_default_map_reads_reddit_api_snake_case(self):
        # An unregistered Actor falls back to broad candidate keys, including
        # Reddit's own snake_case JSON API (epoch created_utc -> ISO8601).
        raw = {
            "kind": "t3",
            "title": "hi",
            "author": "spez",
            "subreddit": "announcements",
            "score": 9,
            "num_comments": 4,
            "upvote_ratio": 0.9,
            "created_utc": 1686288195,
        }
        item = normalize_item(raw, "someone~custom-reddit-actor")
        assert item.type == "post"
        assert item.author == "spez"
        assert item.score == 9
        assert item.num_comments == 4
        assert item.created_at is not None
        assert item.created_at.startswith("2023-06-09T")

    def test_non_finite_numbers_normalize_to_none(self):
        # NaN/Infinity have no int/float form we can hand back; they normalize
        # to None (matching the TS normalizer) instead of aborting the map.
        raw = {
            "kind": "t3",
            "score": float("nan"),
            "num_comments": float("inf"),
            "upvote_ratio": float("nan"),
        }
        item = normalize_item(raw, "someone~custom-reddit-actor")
        assert item.score is None
        assert item.num_comments is None
        assert item.upvote_ratio is None

    def test_numeric_created_utc_uses_canonical_z_suffix(self):
        # A numeric epoch becomes an ISO8601 string with a `Z` suffix (not
        # `+00:00`) so Python matches the Worker's Date.toISOString() exactly.
        raw = {"kind": "t3", "created_utc": 1686288195}
        item = normalize_item(raw, "someone~custom-reddit-actor")
        assert item.created_at == "2023-06-09T05:23:15.000Z"


# The normalized fields every Actor field map must cover (all of
# NormalizedRedditItem except the untouched `raw` passthrough).
_NORMALIZED_FIELDS = set(NormalizedRedditItem.model_fields) - {"raw"}

# The TypeScript mirror of ADAPTER_BY_ACTOR. Kept as a path so the parity test
# reads the live registry rather than a hand-copied list.
_ADAPTERS_TS = (
    Path(__file__).resolve().parents[1] / "servers" / "reddit" / "src" / "adapters.ts"
)


def _ts_adapter_slugs() -> set[str]:
    """The Actor slugs registered in the TypeScript ADAPTER_BY_ACTOR object."""
    text = _ADAPTERS_TS.read_text(encoding="utf-8")
    match = re.search(r"ADAPTER_BY_ACTOR[^=]*=\s*\{(.*?)\n\}", text, re.DOTALL)
    assert match, "could not locate ADAPTER_BY_ACTOR in adapters.ts"
    # Registry keys are quoted "username~name" slugs.
    return set(re.findall(r'"([^"]+~[^"]+)"\s*:', match.group(1)))


class TestRedditActorAdapters(TestTemplate):
    """The adapter registry is the single source of truth per Actor - guard it."""

    def test_every_adapter_field_map_covers_all_normalized_fields(self):
        # A half-written adapter (field map missing a normalized field) would
        # silently normalize that field to None. Fail loudly instead. Cover the
        # default fallback adapter too (it isn't in ADAPTER_BY_ACTOR): an
        # unregistered Actor resolves to it, so a dropped key there would silently
        # null that field for every such Actor.
        default = adapter_for("someone~unregistered-actor")
        registered = list(ADAPTER_BY_ACTOR.items())
        for slug, adapter in [*registered, ("<default>", default)]:
            assert set(adapter.field_map) == _NORMALIZED_FIELDS, (
                f"{slug} field map keys do not match NormalizedRedditItem"
            )

    def test_registry_matches_typescript_mirror(self):
        # servers/reddit (the deployed Worker) and this Python service wrap the
        # same Actors; the two ADAPTER_BY_ACTOR registries must stay in lockstep,
        # or one transport gains/loses an Actor the other lacks. This catches
        # drift in either direction.
        assert set(ADAPTER_BY_ACTOR) == _ts_adapter_slugs()
