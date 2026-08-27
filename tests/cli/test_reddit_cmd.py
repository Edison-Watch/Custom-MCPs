"""Tests for the reddit command (fail-fast, stdin, dry-run — no network)."""

from unittest.mock import patch

from typer.testing import CliRunner

from models.reddit import RedditScrapeResult
from src.cli.app import _register_builtin_commands, _register_user_commands, app
from tests.test_template import TestTemplate

runner = CliRunner()

_register_builtin_commands()
_register_user_commands()


class TestRedditCmd(TestTemplate):
    def test_fails_fast_without_target(self):
        # No search and no --url, non-interactive: exit 1, no network call.
        result = runner.invoke(app, ["reddit"])
        assert result.exit_code == 1
        assert "provide a search term or --url" in result.output.lower()

    def test_dry_run_makes_no_call(self):
        with patch("services.reddit_svc.reddit_scrape") as scrape:
            result = runner.invoke(app, ["--dry-run", "reddit", "rust"])
        assert result.exit_code == 0
        assert "DRY RUN" in result.output
        scrape.assert_not_called()

    def test_search_from_stdin(self):
        with patch(
            "services.reddit_svc.reddit_scrape",
            return_value=RedditScrapeResult(count=0, items=[]),
        ) as scrape:
            result = runner.invoke(app, ["reddit", "--stdin"], input="rust async\n")
        assert result.exit_code == 0
        assert scrape.call_args.args[0].search == "rust async"

    def test_url_target_needs_no_search(self):
        with patch(
            "services.reddit_svc.reddit_scrape",
            return_value=RedditScrapeResult(count=0, items=[]),
        ) as scrape:
            result = runner.invoke(
                app, ["reddit", "--url", "https://www.reddit.com/r/python/"]
            )
        assert result.exit_code == 0
        assert scrape.call_args.args[0].start_urls == [
            "https://www.reddit.com/r/python/"
        ]
