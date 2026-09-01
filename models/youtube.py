"""Models for the YouTube scraper service.

The service wraps an Apify YouTube-scraper Actor behind a small first-party
surface: callers pass a search term (or explicit YouTube URLs) and get back the
Actor's dataset items - videos from search results, plus their comments when
``max_comments`` is raised above zero. Items are heterogeneous (videos and
comments, shaped by the query), so the result carries them as raw dicts rather
than pinning a schema the upstream Actor does not guarantee.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

# YouTube's own search ordering options, surfaced verbatim to the caller.
YoutubeSort = Literal["relevance", "date", "views", "rating"]
# Publish-time recency windows YouTube exposes on search.
YoutubeDate = Literal["hour", "today", "week", "month", "year"]
# How comments are ordered when they are scraped.
YoutubeCommentSort = Literal["top", "new"]


class YoutubeScrapeInput(BaseModel):
    """Query for the YouTube scraper.

    Provide ``search`` or one or more ``start_urls`` (video, channel, playlist,
    or search-results URLs). At least one of the two is required. Raise
    ``max_comments`` above zero to also scrape each video's comments.
    """

    search: str | None = Field(
        default=None,
        description="Search term to look up on YouTube. Omit when using start_urls.",
    )
    start_urls: list[str] = Field(
        default_factory=list,
        description="Explicit YouTube video/channel/playlist/search URLs to scrape.",
    )
    sort: YoutubeSort = Field(
        default="relevance", description="Ordering applied to a search."
    )
    date_filter: YoutubeDate | None = Field(
        default=None, description="Restrict search results to a recency window."
    )
    max_results: int = Field(
        default=10,
        ge=1,
        le=1000,
        description="Maximum number of videos to return.",
    )
    max_comments: int = Field(
        default=0,
        ge=0,
        le=1000,
        description="Comments to scrape per video. 0 skips comment scraping.",
    )
    comment_sort: YoutubeCommentSort = Field(
        default="top", description="Ordering for scraped comments."
    )

    @model_validator(mode="after")
    def _require_a_target(self) -> "YoutubeScrapeInput":
        # Normalize a blank/whitespace-only search to None so it fails the check
        # below instead of being sent to Apify as a useless query.
        if self.search is not None:
            self.search = self.search.strip() or None
        if not self.search and not self.start_urls:
            raise ValueError(
                "Provide either 'search' or at least one 'start_urls' entry."
            )
        return self


class YoutubeScrapeResult(BaseModel):
    """Dataset items returned by the Actor run."""

    count: int = Field(description="Number of items returned.")
    items: list[dict[str, Any]] = Field(
        default_factory=list, description="Raw dataset items from the Apify Actor run."
    )
