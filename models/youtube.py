"""Models for the YouTube scraper service.

The service wraps two Apify Actors behind one first-party surface: callers pass a
search term (or explicit YouTube URLs) and get back the matched videos, plus
their comments when ``max_comments`` is raised above zero. YouTube's Apify
ecosystem splits search and comments across two Actors, so the result carries
``videos`` and ``comments`` as separate lists of raw dicts rather than pinning a
schema the upstream Actors do not guarantee.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

# YouTube's own search-ordering options, surfaced verbatim to the caller.
YoutubeSort = Literal["relevance", "rating", "date", "views"]
# Publish-time recency windows YouTube exposes on search.
YoutubeDate = Literal["hour", "today", "week", "month", "year"]
# How comments are ordered when they are scraped.
YoutubeCommentSort = Literal["top", "new"]


class YoutubeScrapeInput(BaseModel):
    """Query for the YouTube scraper.

    Provide ``search`` or one or more ``start_urls`` (video, channel, playlist,
    or search-results URLs). At least one of the two is required. Raise
    ``max_comments`` above zero to also scrape comments on the resulting videos.
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
    """Videos and comments returned by the Actor runs."""

    video_count: int = Field(description="Number of videos returned.")
    comment_count: int = Field(description="Number of comments returned.")
    videos: list[dict[str, Any]] = Field(
        default_factory=list, description="Raw video items from the search Actor run."
    )
    comments: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Raw comment items from the comments Actor run (empty unless "
        "max_comments > 0).",
    )
