"""Scrape YouTube via the Apify-backed youtube_scrape service."""

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
    'edisonmcps youtube "rust async runtime"',
    'edisonmcps youtube "claude code" --sort date --max-results 25',
    'edisonmcps youtube "mechanical keyboards" --comments 50 --comment-sort new',
    "edisonmcps youtube --url https://www.youtube.com/watch?v=dQw4w9WgXcQ --comments 100",
    'echo "rust async runtime" | edisonmcps youtube --stdin',
    'edisonmcps --format json youtube "claude code"',
)


def main(
    search: Annotated[
        str | None,
        typer.Argument(help="Search term. Use '-' or --stdin to read from stdin."),
    ] = None,
    url: Annotated[
        list[str] | None,
        typer.Option("--url", "-u", help="YouTube URL to scrape (repeatable)."),
    ] = None,
    sort: Annotated[
        str,
        typer.Option("--sort", help="relevance | date | views | rating."),
    ] = "relevance",
    max_results: Annotated[
        int, typer.Option("--max-results", "-n", help="Maximum videos to return.")
    ] = 10,
    comments: Annotated[
        int,
        typer.Option(
            "--comments", help="Comments to scrape per video (0 skips comments)."
        ),
    ] = 0,
    comment_sort: Annotated[
        str, typer.Option("--comment-sort", help="top | new.")
    ] = "top",
    use_stdin: Annotated[
        bool, typer.Option("--stdin", help="Read the search term from stdin.")
    ] = False,
) -> None:
    """Scrape YouTube search results and video comments."""
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
                '  edisonmcps youtube "<query>"  |  '
                "echo <query> | edisonmcps youtube --stdin  |  "
                "edisonmcps youtube --url <youtube-url>"
            )
            raise typer.Exit(code=1)

    if is_dry_run():
        console.print(
            f"[yellow][DRY RUN][/yellow] Would scrape YouTube for {search or urls}"
        )
        return

    # Lazy by design: keep model/service imports out of CLI startup so
    # `--help` stays fast.
    from models.youtube import YoutubeScrapeInput  # noqa: PLC0415
    from services.youtube_svc import youtube_scrape  # noqa: PLC0415

    # model_validate so pydantic validates the free-form --sort/--comment-sort
    # strings against their literals (raising a clear error) rather than the CLI.
    result = youtube_scrape(
        YoutubeScrapeInput.model_validate(
            {
                "search": search,
                "start_urls": urls,
                "sort": sort,
                "max_results": max_results,
                "max_comments": comments,
                "comment_sort": comment_sort,
            }
        )
    )

    render(
        {"query": search or urls, "count": result.count, "items": result.items},
        title="YouTube Scrape",
    )
