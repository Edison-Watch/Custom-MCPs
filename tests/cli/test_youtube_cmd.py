"""Tests for the youtube command (fail-fast, stdin, dry-run; no network)."""

import json
from unittest.mock import patch

from typer.testing import CliRunner

from models.youtube import YoutubeScrapeResult
from src.cli.app import _register_builtin_commands, _register_user_commands, app
from tests.test_template import TestTemplate

runner = CliRunner()

_register_builtin_commands()
_register_user_commands()


class TestYoutubeCmd(TestTemplate):
    def test_fails_fast_without_target(self):
        # No search and no --url, non-interactive: exit 1, no network call.
        result = runner.invoke(app, ["youtube"])
        assert result.exit_code == 1
        assert "provide a search term or --url" in result.output.lower()

    def test_whitespace_search_fails_fast(self):
        # A blank search must hit the actionable CLI error, not a traceback.
        with patch("services.youtube_svc.youtube_scrape") as scrape:
            result = runner.invoke(app, ["youtube", "   "])
        assert result.exit_code == 1
        assert "provide a search term or --url" in result.output.lower()
        scrape.assert_not_called()

    def test_dry_run_makes_no_call(self):
        with patch("services.youtube_svc.youtube_scrape") as scrape:
            result = runner.invoke(app, ["--dry-run", "youtube", "rust"])
        assert result.exit_code == 0
        assert "DRY RUN" in result.output
        scrape.assert_not_called()

    def test_search_from_stdin(self):
        with patch(
            "services.youtube_svc.youtube_scrape",
            return_value=YoutubeScrapeResult(
                video_count=0, comment_count=0, videos=[], comments=[]
            ),
        ) as scrape:
            result = runner.invoke(app, ["youtube", "--stdin"], input="rust async\n")
        assert result.exit_code == 0
        assert scrape.call_args.args[0].search == "rust async"

    def test_url_target_needs_no_search(self):
        with patch(
            "services.youtube_svc.youtube_scrape",
            return_value=YoutubeScrapeResult(
                video_count=0, comment_count=0, videos=[], comments=[]
            ),
        ) as scrape:
            result = runner.invoke(
                app,
                ["youtube", "--url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
            )
        assert result.exit_code == 0
        assert scrape.call_args.args[0].start_urls == [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ]

    def test_json_format_renders_result_shape(self):
        result_obj = YoutubeScrapeResult(
            video_count=1,
            comment_count=1,
            videos=[{"id": "vid1", "title": "hello"}],
            comments=[{"comment": "nice", "author": "@a"}],
        )
        with patch("services.youtube_svc.youtube_scrape", return_value=result_obj):
            result = runner.invoke(app, ["--format", "json", "youtube", "cats"])
        assert result.exit_code == 0
        # --format json must emit the machine-readable result payload.
        payload = json.loads(result.output)
        assert payload["video_count"] == 1
        assert payload["comment_count"] == 1
        assert payload["videos"][0]["id"] == "vid1"
        assert payload["comments"][0]["comment"] == "nice"

    def test_invalid_sort_is_rejected_before_any_call(self):
        # A bad enum must fail on validation, never after a paid Apify run starts.
        with patch("services.youtube_svc.youtube_scrape") as scrape:
            result = runner.invoke(app, ["youtube", "cats", "--sort", "banana"])
        assert result.exit_code != 0
        scrape.assert_not_called()

    def test_invalid_comment_sort_is_rejected_before_any_call(self):
        with patch("services.youtube_svc.youtube_scrape") as scrape:
            result = runner.invoke(
                app, ["youtube", "cats", "--comment-sort", "sideways"]
            )
        assert result.exit_code != 0
        scrape.assert_not_called()

    def test_comments_flag_is_passed_through(self):
        with patch(
            "services.youtube_svc.youtube_scrape",
            return_value=YoutubeScrapeResult(
                video_count=0, comment_count=0, videos=[], comments=[]
            ),
        ) as scrape:
            result = runner.invoke(
                app, ["youtube", "cats", "--comments", "25", "--comment-sort", "new"]
            )
        assert result.exit_code == 0
        assert scrape.call_args.args[0].max_comments == 25
        assert scrape.call_args.args[0].comment_sort == "new"
