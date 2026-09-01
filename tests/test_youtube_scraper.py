"""Tests for the Apify-backed YouTube scraper service (fast tier, no network).

HTTP is stubbed with an httpx.MockTransport so no Apify call is made. Covers the
happy path, input-to-Actor mapping, the missing-token guard, and error mapping.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from unittest.mock import patch

import httpx
import pytest

from common import global_config
from models.youtube import YoutubeScrapeInput
from services import discover_services, get_registry, youtube_svc
from services.youtube_svc import ApifyError, youtube_scrape
from tests.test_template import TestTemplate


@contextmanager
def _mock_http(handler):
    """Patch the service's httpx.Client to use a MockTransport."""
    transport = httpx.MockTransport(handler)
    real_client = httpx.Client  # capture before patching to avoid recursion

    def factory(*_args, **_kwargs):
        return real_client(transport=transport)

    with patch("services.youtube_svc.httpx.Client", factory):
        yield


@contextmanager
def _token(value: str | None):
    with patch.object(global_config, "APIFY_API_KEY", value):
        yield


class TestYoutubeScrape(TestTemplate):
    def test_happy_path_returns_items(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"title": "a"}, {"title": "b"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(YoutubeScrapeInput(search="rust"))

        assert result.count == 2
        assert result.items[0]["title"] == "a"

    def test_maps_input_onto_actor_schema(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            # Token travels in the Authorization header, never the URL.
            assert request.headers["Authorization"] == "Bearer test-token"
            assert "token" not in request.url.params
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            youtube_scrape(
                YoutubeScrapeInput(
                    search="keyboards",
                    sort="date",
                    date_filter="week",
                    max_results=25,
                    max_comments=50,
                    comment_sort="new",
                )
            )

        assert captured["searchKeywords"] == "keyboards"
        assert captured["sortVideosBy"] == "date"
        assert captured["dateFilter"] == "week"
        assert captured["maxResults"] == 25
        assert captured["maxComments"] == 50
        assert captured["commentsSortBy"] == "new"

    def test_start_urls_only_is_valid(self):
        body: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            body.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            youtube_scrape(
                YoutubeScrapeInput(
                    start_urls=["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
                )
            )

        assert body["startUrls"] == [
            {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
        ]

    def test_comments_default_to_zero(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

        # No comment scraping unless the caller opts in.
        assert captured["maxComments"] == 0

    def test_requires_search_or_urls(self):
        with pytest.raises(ValueError, match="Provide either"):
            YoutubeScrapeInput()

    def test_whitespace_only_search_is_rejected(self):
        with pytest.raises(ValueError, match="Provide either"):
            YoutubeScrapeInput(search="   ")

    def test_search_is_stripped(self):
        assert YoutubeScrapeInput(search="  rust  ").search == "rust"

    def test_invalid_json_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"not json", headers={})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="invalid JSON"),
        ):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

    def test_non_dict_item_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"ok": 1}, "not-an-object"])

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="not an object"),
        ):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

    def test_missing_token_raises(self):
        with _token(None), pytest.raises(ApifyError, match="APIFY_API_KEY"):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

    def test_http_error_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "bad token"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="401"),
        ):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

    def test_non_list_response_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"not": "a list"})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="response shape"),
        ):
            youtube_scrape(YoutubeScrapeInput(search="rust"))

    def test_service_is_registered(self):
        discover_services()
        names = {e.name for e in get_registry()}
        assert "youtube_scrape" in names
        # read-only scrape: not a mutating service
        entry = next(e for e in get_registry() if e.name == "youtube_scrape")
        assert entry.mutating is False
        assert youtube_svc  # module imported
