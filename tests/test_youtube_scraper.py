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
from tests.test_template import (
    TestTemplate,
    nondeterministic_test,
    slow_test,
)


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

    def test_search_and_start_urls_both_feed_search_actor(self):
        # When both a search term and start_urls are given, both reach the
        # search Actor in one run (searchQueries + startUrls).
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200, json=[])

        with _token("test-token"), _mock_http(handler):
            youtube_scrape(
                YoutubeScrapeInput(
                    search="jazz",
                    start_urls=["https://www.youtube.com/playlist?list=PLabc"],
                )
            )

        assert captured["searchQueries"] == ["jazz"]
        assert captured["startUrls"] == [
            {"url": "https://www.youtube.com/playlist?list=PLabc"}
        ]

    def test_playlist_start_url_videos_flow_into_comments(self):
        # A playlist URL fans out to several videos (verified live: the search
        # Actor returns video items each carrying an id); comments then run on
        # every resolved video URL.
        comment_input: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                return httpx.Response(
                    200, json=[{"id": "v1"}, {"id": "v2"}, {"id": "v3"}]
                )
            comment_input.update(json.loads(request.content))
            return httpx.Response(200, json=[{"comment": "c"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(
                YoutubeScrapeInput(
                    start_urls=["https://www.youtube.com/playlist?list=PLabc"],
                    max_comments=2,
                )
            )

        assert [u["url"] for u in comment_input["startUrls"]] == [
            "https://www.youtube.com/watch?v=v1",
            "https://www.youtube.com/watch?v=v2",
            "https://www.youtube.com/watch?v=v3",
        ]
        assert result.video_count == 3

    def test_partial_comments_do_not_drop_the_batch(self):
        # A dead/comments-off video mid-batch yields nothing (verified live: one
        # good + one bogus URL returns only the good video's comments, no hard
        # error). The service must surface whatever came back, not zero it out.
        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                return httpx.Response(200, json=[{"id": "good"}, {"id": "dead"}])
            # Only the good video produced comments.
            return httpx.Response(
                200, json=[{"comment": "a", "videoId": "good"}, {"comment": "b"}]
            )

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(YoutubeScrapeInput(search="rust", max_comments=5))

        assert result.video_count == 2
        assert result.comment_count == 2  # the dead video's absence is not fatal

    def test_unicode_comment_text_survives_round_trip(self):
        # Comments are full of emoji/CJK; they must round-trip through the
        # Pydantic result and JSON-serialize cleanly.
        emoji = "anyone here in 2059 \U0001f979好的"

        def handler(request: httpx.Request) -> httpx.Response:
            if _is_search(request):
                return httpx.Response(200, json=[{"id": "v1"}])
            return httpx.Response(200, json=[{"comment": emoji, "author": "@x"}])

        with _token("test-token"), _mock_http(handler):
            result = youtube_scrape(YoutubeScrapeInput(search="rust", max_comments=1))

        assert result.comments[0]["comment"] == emoji
        # Survives JSON serialization (what every transport ultimately emits).
        assert emoji in result.model_dump_json()

    def test_service_is_registered(self):
        discover_services()
        names = {e.name for e in get_registry()}
        assert "youtube_scrape" in names
        # read-only scrape: not a mutating service
        entry = next(e for e in get_registry() if e.name == "youtube_scrape")
        assert entry.mutating is False
        assert youtube_svc  # module imported


class TestYoutubeScrapeLive(TestTemplate):
    """Live guard against upstream Actor schema drift.

    Hits both real Apify Actors with a tiny budget, so a field rename in
    either one (which every mocked test would sail past) fails here. Slow and
    nondeterministic, so it is excluded from the fast tier and only runs under
    ``make test_slow`` / ``make test_nondeterministic``. Skips when no token is
    configured (e.g. CI without the secret).
    """

    @slow_test
    @nondeterministic_test
    def test_live_search_and_comments_match_expected_schema(self):
        if not global_config.APIFY_API_KEY:
            pytest.skip("APIFY_API_KEY not configured; skipping live Apify call.")

        result = youtube_scrape(
            YoutubeScrapeInput(search="lofi hip hop", max_results=1, max_comments=2)
        )

        # max_results is a per-search cap: the returned count must not overshoot.
        assert 1 <= result.video_count <= 1
        video = result.videos[0]
        # The fields the comments chaining and downstream consumers depend on.
        assert video.get("id"), f"video missing 'id': {sorted(video)}"
        assert video.get("url"), f"video missing 'url': {sorted(video)}"

        # Comments are best-effort (a video may have them disabled), but any
        # returned comment must still carry the text field we surface.
        assert result.comment_count == len(result.comments)
        for comment in result.comments:
            assert "comment" in comment, f"comment missing 'comment': {sorted(comment)}"
