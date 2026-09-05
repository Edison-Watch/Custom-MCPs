"""Scrape Reddit via the Apify-backed reddit_scrape service."""

import sys
from typing import Annotated

import typer
from rich.console import Console

from src.cli.state import is_dry_run
from src.utils.cli_help import examples_epilog
from src.utils.output import render
from src.utils.stdin import resolve_value

console = Console(stderr=True)

EPILOG = examples_epilog(
    'edisonmcps reddit "rust async runtime"',
    'edisonmcps reddit "best keyboard" --subreddit MechanicalKeyboards --sort top',
    "edisonmcps reddit --url https://www.reddit.com/r/python/ --max-items 25",
    'echo "rust async runtime" | edisonmcps reddit --stdin',
    'edisonmcps --format json reddit "claude code"',
)


def main(
    search: Annotated[
        str | None,
        typer.Argument(help="Search term. Use '-' or --stdin to read from stdin."),
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
    include_media_links: Annotated[
        bool,
        typer.Option(
            "--media-links",
            help="Extract engagement (upvotes, comments, ratio) + media URLs; "
            "slower detailed scrape instead of fast RSS mode.",
        ),
    ] = False,
    use_stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the search term from stdin.")
    ] = False,
) -> None:
    """Scrape Reddit posts, comments, communities, or users."""
    search = resolve_value(search, use_stdin=use_stdin)
    if search is not None:
        search = search.strip() or None
    urls = url or []

    # Fail fast (or prompt only on a TTY) when neither target is given, rather
    # than sending an empty query to Apify.
    if not search and not urls:
        if sys.stdin.isatty():
            search = typer.prompt("Enter a search term")
        else:
            console.print("[red]Error:[/red] provide a search term or --url.")
            console.print(
                '  edisonmcps reddit "<query>"  |  '
                "echo <query> | edisonmcps reddit --stdin  |  "
                "edisonmcps reddit --url <reddit-url>"
            )
            raise typer.Exit(code=1)

    if is_dry_run():
        console.print(
            f"[yellow][DRY RUN][/yellow] Would scrape Reddit for {search or urls}"
        )
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
                "start_urls": urls,
                "subreddit": subreddit,
                "sort": sort,
                "max_items": max_items,
                "include_comments": include_comments,
                "include_media_links": include_media_links,
            }
        )
    )

    render(
        {
            "query": search or urls,
            "count": result.count,
            "items": [item.model_dump() for item in result.items],
        },
        title="Reddit Scrape",
    )
