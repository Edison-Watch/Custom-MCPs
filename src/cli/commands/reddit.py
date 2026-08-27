"""Scrape Reddit via the Apify-backed reddit_scrape service."""

from typing import Annotated

import typer

from src.cli.state import is_dry_run, is_verbose
from src.utils.cli_help import examples_epilog
from src.utils.interactive import interactive_fallback
from src.utils.output import render

EPILOG = examples_epilog(
    'edisonmcps reddit "rust async runtime"',
    'edisonmcps reddit "best keyboard" --subreddit MechanicalKeyboards --sort top',
    "edisonmcps reddit --url https://www.reddit.com/r/python/ --max-items 25",
)


@interactive_fallback
def main(
    search: Annotated[
        str | None, typer.Argument(help="Search term to look up on Reddit.")
    ] = None,
    url: Annotated[
        list[str] | None,
        typer.Option("--url", "-u", help="Reddit URL to scrape (repeatable)."),
    ] = None,
    subreddit: Annotated[
        str | None,
        typer.Option("--subreddit", "-r", help="Restrict a search to one community."),
    ] = None,
    sort: Annotated[
        str,
        typer.Option("--sort", help="relevance | hot | top | new | rising | comments."),
    ] = "new",
    max_items: Annotated[
        int, typer.Option("--max-items", "-n", help="Maximum items to return.")
    ] = 10,
    include_comments: Annotated[
        bool, typer.Option("--comments", help="Also scrape comments on matched posts.")
    ] = False,
) -> None:
    """Scrape Reddit posts, comments, communities, or users."""
    if is_dry_run():
        typer.echo(f"[DRY RUN] Would scrape Reddit for {search or url}")
        return

    # Lazy by design: keep model/service imports out of CLI startup so
    # `--help` stays fast.
    from models.reddit import RedditScrapeInput  # noqa: PLC0415
    from services.reddit_svc import reddit_scrape  # noqa: PLC0415

    # model_validate so pydantic validates the free-form --sort string against
    # the RedditSort literal (raising a clear error) rather than the CLI.
    result = reddit_scrape(
        RedditScrapeInput.model_validate(
            {
                "search": search,
                "start_urls": url or [],
                "subreddit": subreddit,
                "sort": sort,
                "max_items": max_items,
                "include_comments": include_comments,
            }
        )
    )

    if is_verbose():
        render(
            {"query": search or url, "count": result.count, "items": result.items},
            title="Reddit Scrape",
        )
    else:
        typer.echo(f"{result.count} item(s)")
        for item in result.items:
            title = item.get("title") or item.get("body") or item.get("url") or item
            typer.echo(f"- {title}")
