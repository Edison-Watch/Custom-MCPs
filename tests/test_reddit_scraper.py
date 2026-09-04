"""Tests for the Apify-backed Reddit scraper service (fast tier, no network).

HTTP is stubbed with an httpx.MockTransport so no Apify call is made. Covers the
happy path, input-to-Actor mapping, output normalization + the per-actor mapping
layer, the missing-token guard, and error mapping.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import pytest

from common import global_config
from models.reddit import RedditScrapeFetchInput, RedditScrapeInput
from services import discover_services, get_registry, reddit_svc
from services.reddit_svc import (
    ApifyError,
    normalize_item,
    reddit_scrape,
    reddit_scrape_fetch,
    reddit_scrape_start,
)
from tests.test_template import TestTemplate


@contextmanager
def _mock_http(handler):
    """Patch the service's httpx.Client to use a MockTransport."""
    transport = httpx.MockTransport(handler)
    real_client = httpx.Client  # capture before patching to avoid recursion

    def factory(*_args, **_kwargs):
        return real_client(transport=transport)

    with patch("services.reddit_svc.httpx.Client", factory):
        yield


@contextmanager
def _token(value: str | None):
    with patch.object(global_config, "APIFY_API_KEY", value):
        yield


@contextmanager
def _actor(value: str | None):
    with patch.object(global_config, "APIFY_ACTOR_ID", value):
        yield


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


class TestRedditScrape(TestTemplate):
    def test_happy_path_returns_items(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"title": "a"}, {"title": "b"}])

        with _token("test-token"), _mock_http(handler):
            result = reddit_scrape(RedditScrapeInput(search="rust"))

        assert result.count == 2
        assert result.items[0].title == "a"
        # The untouched Actor item is preserved under `raw`.
        assert result.items[0].raw == {"title": "a"}

    def test_maps_input_onto_actor_schema(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            # Token travels in the Authorization header, never the URL.
            assert request.headers["Authorization"] == "Bearer test-token"
            assert "token" not in request.url.params
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            reddit_scrape(
                RedditScrapeInput(
                    search="keyboards",
                    subreddit="MechanicalKeyboards",
                    sort="top",
                    time_filter="week",
                    max_items=25,
                    include_comments=True,
                )
            )

        assert captured["searches"] == ["keyboards"]
        assert captured["searchCommunityName"] == "MechanicalKeyboards"
        assert captured["sort"] == "top"
        assert captured["time"] == "week"
        assert captured["maxItems"] == 25
        assert captured["skipComments"] is False  # include_comments=True

    def test_start_urls_only_is_valid(self):
        body: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            reddit_scrape(
                RedditScrapeInput(start_urls=["https://www.reddit.com/r/python/"])
            )

        assert body["startUrls"] == [{"url": "https://www.reddit.com/r/python/"}]

    def test_requires_search_or_urls(self):
        with pytest.raises(ValueError, match="Provide either"):
            RedditScrapeInput()

    def test_whitespace_only_search_is_rejected(self):
        with pytest.raises(ValueError, match="Provide either"):
            RedditScrapeInput(search="   ")

    def test_search_is_stripped(self):
        assert RedditScrapeInput(search="  rust  ").search == "rust"

    def test_invalid_json_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"not json", headers={})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="invalid JSON"),
        ):
            reddit_scrape(RedditScrapeInput(search="rust"))

    def test_non_dict_item_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"ok": 1}, "not-an-object"])

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="not an object"),
        ):
            reddit_scrape(RedditScrapeInput(search="rust"))

    def test_missing_token_raises(self):
        with _token(None), pytest.raises(ApifyError, match="APIFY_API_KEY"):
            reddit_scrape(RedditScrapeInput(search="rust"))

    def test_http_error_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "bad token"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="401"),
        ):
            reddit_scrape(RedditScrapeInput(search="rust"))

    def test_non_list_response_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"not": "a list"})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="response shape"),
        ):
            reddit_scrape(RedditScrapeInput(search="rust"))

    def test_service_is_registered(self):
        discover_services()
        names = {e.name for e in get_registry()}
        assert {"reddit_scrape", "reddit_scrape_start", "reddit_scrape_fetch"} <= names
        # read-only scrape: not a mutating service
        entry = next(e for e in get_registry() if e.name == "reddit_scrape")
        assert entry.mutating is False
        assert reddit_svc  # module imported

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

    def test_scrape_normalizes_items_end_to_end(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[_FULL_POST])

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper"),
            _mock_http(handler),
        ):
            result = reddit_scrape(RedditScrapeInput(search="rust"))

        assert result.count == 1
        assert result.items[0].score == 1500
        assert result.items[0].num_comments == 42
        assert result.items[0].raw["upVotes"] == 1500


class TestRedditScrapeAsync(TestTemplate):
    """The async run + poll pair (reddit_scrape_start / reddit_scrape_fetch)."""

    def test_start_returns_run_handle(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            # Non-blocking run enqueue: POST /v2/acts/{actor}/runs, no run-sync.
            assert request.url.path.endswith("/runs")
            assert request.headers["Authorization"] == "Bearer test-token"
            captured.update(json.loads(request.content))
            return httpx.Response(
                201,
                json={
                    "data": {
                        "id": "RUN123",
                        "defaultDatasetId": "DS123",
                        "status": "READY",
                    }
                },
            )

        with _token("test-token"), _mock_http(handler):
            result = reddit_scrape_start(RedditScrapeInput(search="rust"))

        assert result.run_id == "RUN123"
        assert result.dataset_id == "DS123"
        assert result.status == "READY"
        # The same actor-input mapping the sync path uses.
        assert captured["searches"] == ["rust"]

    def test_start_missing_token_raises(self):
        with _token(None), pytest.raises(ApifyError, match="APIFY_API_KEY"):
            reddit_scrape_start(RedditScrapeInput(search="rust"))

    def test_start_missing_fields_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(201, json={"data": {"id": "RUN123"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="missing id/defaultDatasetId/status"),
        ):
            reddit_scrape_start(RedditScrapeInput(search="rust"))

    def test_fetch_running_returns_empty(self):
        def handler(request: httpx.Request) -> httpx.Response:
            # Only the run-status GET is hit while non-terminal; no dataset pull.
            assert "/actor-runs/RUN123" in request.url.path
            return httpx.Response(200, json={"data": {"status": "RUNNING"}})

        with _token("test-token"), _mock_http(handler):
            result = reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

        assert result.status == "RUNNING"
        assert result.count == 0
        assert result.items == []

    def test_fetch_succeeded_returns_normalized_items(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if "/actor-runs/RUN123" in request.url.path:
                return httpx.Response(
                    200,
                    json={"data": {"status": "SUCCEEDED", "defaultDatasetId": "DS123"}},
                )
            # Dataset item fetch: clean JSON of the run's results.
            assert "/datasets/DS123/items" in request.url.path
            assert request.url.params["clean"] == "true"
            return httpx.Response(200, json=[_FULL_POST])

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper"),
            _mock_http(handler),
        ):
            result = reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

        assert result.status == "SUCCEEDED"
        assert result.count == 1
        # Engagement mapped through the same normalizer as the sync path.
        assert result.items[0].score == 1500
        assert result.items[0].num_comments == 42
        assert result.items[0].raw["upVotes"] == 1500

    def test_fetch_failed_returns_status_no_items(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": {"status": "FAILED"}})

        with _token("test-token"), _mock_http(handler):
            result = reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

        # A terminal failure surfaces as a status the caller stops polling on,
        # not an exception - the run GET itself succeeded.
        assert result.status == "FAILED"
        assert result.count == 0
        assert result.items == []

    def test_fetch_http_error_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": {"message": "run not found"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="404"),
        ):
            reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

    def test_fetch_missing_token_raises(self):
        with _token(None), pytest.raises(ApifyError, match="APIFY_API_KEY"):
            reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))
