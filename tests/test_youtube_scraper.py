"""Tests for the Apify-backed YouTube scraper service (fast tier, no network).

HTTP is stubbed with an httpx.MockTransport so no Apify call is made. Covers the
happy path, input-to-Actor mapping for both the search and comments Actors, the
missing-token guard, and error mapping.
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
from services.youtube_svc import (
    _COMMENTS_ACTOR_ID,
    _SEARCH_ACTOR_ID,
    ApifyError,
    _video_urls,
    youtube_scrape,
)
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


def _is_search(request: httpx.Request) -> bool:
    return _SEARCH_ACTOR_ID in str(request.url)


def _is_comments(request: httpx.Request) -> bool:
    return _COMMENTS_ACTOR_ID in str(request.url)


class TestYoutubeScrape(TestTemplate):
    def test_happy_path_returns_videos(self):
        def handler(request: httpx.Request) -> httpx.Response:
            # Only the search Actor should be called when comments are off.
            assert _is_search(request)
            return httpx.Response(200, json=[{"id": "a"}, {"id": "b"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(YoutubeScrapeInput(search="rust"))

        assert result.video_count == 2
        assert result.comment_count == 0
        assert result.videos[0]["id"] == "a"
        assert result.comments == []

    def test_maps_search_input_onto_actor_schema(self):
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
                )
            )

        assert captured["searchQueries"] == ["keyboards"]
        assert captured["sortingOrder"] == "date"
        assert captured["dateFilter"] == "week"
        assert captured["maxResults"] == 25
        # Standard videos only unless the caller targets shorts/streams by URL.
        assert captured["maxResultsShorts"] == 0
        assert captured["maxResultStreams"] == 0

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

    def test_comments_run_chained_on_video_urls(self):
        search_seen = {"n": 0}
        comment_input: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                search_seen["n"] += 1
                return httpx.Response(200, json=[{"id": "vid123"}])
            assert _is_comments(request)
            comment_input.update(json.loads(request.content))
            return httpx.Response(200, json=[{"comment": "nice"}, {"comment": "wow"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(
                YoutubeScrapeInput(search="rust", max_comments=5, comment_sort="new")
            )

        assert search_seen["n"] == 1
        # Comments Actor is fed a canonical watch URL built from the video id.
        assert comment_input["startUrls"] == [
            {"url": "https://www.youtube.com/watch?v=vid123"}
        ]
        assert comment_input["maxComments"] == 5
        assert comment_input["sortCommentsBy"] == "NEWEST_FIRST"
        assert result.video_count == 1
        assert result.comment_count == 2
        assert result.comments[0]["comment"] == "nice"

    def test_comments_skipped_when_no_videos(self):
        calls = {"search": 0, "comments": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                calls["search"] += 1
                return httpx.Response(200, json=[])  # no videos found
            calls["comments"] += 1
            return httpx.Response(200, json=[{"comment": "x"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(YoutubeScrapeInput(search="rust", max_comments=5))

        # With no videos, the comments Actor must not be called.
        assert calls == {"search": 1, "comments": 0}
        assert result.comment_count == 0

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

    def test_dict_response_is_wrapped(self):
        # An Apify error object comes back as a dict, not a list.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"error": {"message": "bad input"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="response shape"),
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

    def test_comments_are_per_video_not_multiplied(self):
        # maxComments is a per-video cap (verified live: 2 videos x maxComments=2
        # returns 4 comments, 2 each), so the service passes the caller's value
        # through once for the whole batch - never multiplied by the video count.
        comment_input: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                return httpx.Response(200, json=[{"id": "v1"}, {"id": "v2"}])
            comment_input.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            youtube_scrape(YoutubeScrapeInput(search="rust", max_comments=7))

        assert comment_input["maxComments"] == 7
        assert len(comment_input["startUrls"]) == 2

    def test_comments_actor_failure_propagates(self):
        # Search succeeds, comments Actor 5xxs: the error must surface as
        # ApifyError, not a silent empty comments list.
        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                return httpx.Response(200, json=[{"id": "vid1"}])
            return httpx.Response(500, json={"error": {"message": "actor boom"}})

        with (
            _token("test-token"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="500"),
        ):
            youtube_scrape(YoutubeScrapeInput(search="rust", max_comments=3))

    def test_video_urls_builds_canonical_watch_urls(self):
        # Prefer watch?v=<id> over the raw url (which carries playlist/radio
        # params that confuse the comments Actor).
        videos = [{"id": "abc", "url": "https://youtube.com/watch?v=abc&list=RDabc"}]
        assert _video_urls(videos) == ["https://www.youtube.com/watch?v=abc"]

    def test_video_urls_falls_back_to_raw_url_without_id(self):
        videos = [{"url": "https://www.youtube.com/watch?v=noid"}]
        assert _video_urls(videos) == ["https://www.youtube.com/watch?v=noid"]

    def test_video_urls_dedupes_and_preserves_order(self):
        videos = [
            {"id": "a"},
            {"id": "b"},
            {"id": "a"},  # duplicate id -> dropped
            {"url": "https://www.youtube.com/watch?v=b"},  # dup of b's canonical url
        ]
        assert _video_urls(videos) == [
            "https://www.youtube.com/watch?v=a",
            "https://www.youtube.com/watch?v=b",
        ]

    def test_video_urls_skips_entries_without_id_or_url(self):
        assert _video_urls([{"title": "no url here"}, {"id": "x"}]) == [
            "https://www.youtube.com/watch?v=x"
        ]

    def test_service_is_registered(self):
        discover_services()
        names = {e.name for e in get_registry()}
        assert "youtube_scrape" in names
        # read-only scrape: not a mutating service
        entry = next(e for e in get_registry() if e.name == "youtube_scrape")
        assert entry.mutating is False
        assert youtube_svc  # module imported
