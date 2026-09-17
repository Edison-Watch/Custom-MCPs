"""Tests for the Apify-backed Reddit scraper service (fast tier, no network).

HTTP is stubbed with an httpx.MockTransport so no Apify call is made. Covers the
happy path, per-Actor input-to-Actor mapping, the missing-token guard, error
mapping, and the async run + poll pair. Output normalization and the adapter
registry guards live in ``tests/test_reddit_adapters.py``.
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

    def test_maps_input_onto_default_fatihtahta_schema(self):
        # The default Actor is fatihtahta/reddit-scraper-search-fast, whose input
        # schema differs from trudax: queries/maxPosts/subredditName/timeframe/
        # scrapeComments, no proxy block, includeMediaLinks has no equivalent.
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
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

        assert captured["queries"] == ["keyboards"]
        assert captured["subredditName"] == "MechanicalKeyboards"
        assert captured["sort"] == "top"
        assert captured["timeframe"] == "week"
        assert captured["maxPosts"] == 25
        assert captured["scrapeComments"] is True  # include_comments=True
        # trudax-only keys are never sent to this Actor.
        assert "searches" not in captured
        assert "proxy" not in captured
        assert "includeMediaLinks" not in captured

    def test_fatihtahta_maps_start_urls_as_bare_strings(self):
        body: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            reddit_scrape(
                RedditScrapeInput(start_urls=["https://www.reddit.com/r/python/"])
            )

        # fatihtahta takes `urls` as bare strings, not trudax's {"url": ...}.
        assert body["urls"] == ["https://www.reddit.com/r/python/"]

    def test_fatihtahta_rising_sort_maps_to_hot(self):
        # fatihtahta's sort enum omits "rising"; the adapter maps it to the
        # nearest trending sort so the Actor never rejects the input.
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            reddit_scrape(RedditScrapeInput(search="rust", sort="rising"))

        assert captured["sort"] == "hot"

    def test_maps_input_onto_trudax_schema(self):
        # Pinning APIFY_ACTOR_ID at trudax uses its distinct input schema:
        # searches/maxItems/searchCommunityName/time/skipComments + proxy.
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            assert request.headers["Authorization"] == "Bearer test-token"
            assert "token" not in request.url.params
            return httpx.Response(200, json=[])

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper-lite"),
            _mock_http(handler),
        ):
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
        # Defaults off: fast RSS mode, no engagement extraction.
        assert captured["includeMediaLinks"] is False

    def test_include_media_links_maps_to_trudax_input(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper-lite"),
            _mock_http(handler),
        ):
            reddit_scrape(RedditScrapeInput(search="dlp", include_media_links=True))

        # On -> the Actor returns engagement fields the normalizer maps.
        assert captured["includeMediaLinks"] is True

    def test_trudax_maps_start_urls_to_url_objects(self):
        body: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper-lite"),
            _mock_http(handler),
        ):
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

    def test_scrape_start_is_mutating(self):
        # reddit_scrape_start enqueues a paid Apify run, so the API transport
        # must enforce an Idempotency-Key: it is registered as mutating.
        discover_services()
        entry = next(e for e in get_registry() if e.name == "reddit_scrape_start")
        assert entry.mutating is True

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
        # The same actor-input mapping the sync path uses (default fatihtahta).
        assert captured["queries"] == ["rust"]

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

    def test_fetch_missing_status_raises(self):
        # A run envelope with no status is malformed, not a silent non-terminal:
        # it must raise rather than flow on as "UNKNOWN" with empty items.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": {"defaultDatasetId": "DS123"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="missing status"),
        ):
            reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

    def test_fetch_input_rejects_path_injection_run_id(self):
        # run_id is interpolated into the actor-runs path, so an id carrying
        # path/query syntax (or an empty id) is rejected at the model boundary.
        for bad in ("", "../../datasets", "RUN/../x", "RUN?token=x", "a b"):
            with pytest.raises(ValueError):
                RedditScrapeFetchInput(run_id=bad)
        # A well-formed opaque id passes.
        assert RedditScrapeFetchInput(run_id="HG7ML7M8z78Yc-AP_EB").run_id

    def test_fetch_trailing_slash_base_does_not_double_slash(self):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            return httpx.Response(200, json={"data": {"status": "RUNNING"}})

        with (
            _token("test-token"),
            patch.object(reddit_svc, "_APIFY_BASE", "https://api.apify.com/v2/"),
            _mock_http(handler),
        ):
            reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))

        assert seen["path"] == "/v2/actor-runs/RUN123"
        assert "//actor-runs" not in seen["path"]
