"""Models for the Reddit scraper service.

The service wraps an Apify Reddit-scraper Actor behind a small first-party
surface: callers pass a search term (or explicit Reddit URLs) and get back the
Actor's dataset items. Items are heterogeneous (posts, comments, communities,
users depending on the query), so the result carries them as raw dicts rather
than pinning a schema the upstream Actor does not guarantee.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

RedditSort = Literal["relevance", "hot", "top", "new", "rising", "comments"]
RedditTime = Literal["all", "hour", "day", "week", "month", "year"]


class RedditScrapeInput(BaseModel):
    """Query for the Reddit scraper.

    Provide ``search`` (optionally narrowed to a ``subreddit``) or one or more
    ``start_urls``. At least one of the two is required.
    """

    search: str | None = Field(
        default=None,
        description="Search term to look up on Reddit. Omit when using start_urls.",
    )
    subreddit: str | None = Field(
        default=None,
        description="Restrict a search to one community, e.g. 'programming'. "
        "Ignored when search is not set.",
    )
    start_urls: list[str] = Field(
        default_factory=list,
        description="Explicit Reddit post/community/user URLs to scrape directly.",
    )
    sort: RedditSort = Field(default="new", description="Ordering applied to a search.")
    time_filter: RedditTime | None = Field(
        default=None, description="Restrict posts to a recency window (posts only)."
    )
    max_items: int = Field(
        default=10,
        ge=1,
        le=1000,
        description="Maximum number of dataset items to return.",
    )
    include_comments: bool = Field(
        default=False, description="Also scrape comments on matched posts."
    )
    include_nsfw: bool = Field(default=False, description="Include NSFW results.")

    @model_validator(mode="after")
    def _require_a_target(self) -> "RedditScrapeInput":
        if not self.search and not self.start_urls:
            raise ValueError(
                "Provide either 'search' or at least one 'start_urls' entry."
            )
        return self


class RedditScrapeResult(BaseModel):
    """Dataset items returned by the Actor run."""

    count: int = Field(description="Number of items returned.")
    items: list[dict[str, Any]] = Field(
        default_factory=list, description="Raw dataset items from the Apify Actor run."
    )
