"""Models for the Reddit scraper service.

The service wraps an Apify Reddit-scraper Actor behind a small first-party
surface: callers pass a search term (or explicit Reddit URLs) and get back the
matched items. Items are heterogeneous (posts, comments, communities, users
depending on the query) and each Actor names its fields differently, so the
service maps every item onto a stable, actor-agnostic ``NormalizedRedditItem``
(snake_case, engagement fields nullable) and keeps the untouched Actor item
under ``raw`` so nothing is lost. See ``services/reddit_svc.py`` for the
per-actor mapping layer that populates this shape.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

RedditSort = Literal["relevance", "hot", "top", "new", "rising", "comments"]
RedditTime = Literal["all", "hour", "day", "week", "month", "year"]
RedditItemType = Literal["post", "comment", "community", "user"]


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
        # Normalize a blank/whitespace-only search to None so it fails the
        # check below instead of being sent to Apify as a useless query.
        if self.search is not None:
            self.search = self.search.strip() or None
        if not self.search and not self.start_urls:
            raise ValueError(
                "Provide either 'search' or at least one 'start_urls' entry."
            )
        return self


class NormalizedRedditItem(BaseModel):
    """A Reddit post/comment/community/user in a stable, actor-agnostic shape.

    Every field is nullable: a given Actor (or item kind) may omit any of them,
    and an absent engagement count stays ``None`` rather than being faked as
    ``0`` so "unknown" stays distinct from "zero". The untouched Actor item is
    preserved under ``raw``.
    """

    id: str | None = Field(default=None, description="Actor item id, if any.")
    type: RedditItemType | None = Field(
        default=None, description="Item kind: post | comment | community | user."
    )
    title: str | None = Field(default=None, description="Post title.")
    body: str | None = Field(default=None, description="Post selftext or comment body.")
    author: str | None = Field(default=None, description="Author username.")
    subreddit: str | None = Field(
        default=None, description="Community name (without the 'r/' prefix if given)."
    )
    url: str | None = Field(default=None, description="Canonical URL for the item.")
    permalink: str | None = Field(
        default=None, description="Reddit permalink path, when derivable."
    )
    created_at: str | None = Field(
        default=None, description="Creation time as an ISO8601 string."
    )
    score: int | None = Field(
        default=None, description="Net upvotes; None when the Actor omits it."
    )
    num_comments: int | None = Field(
        default=None, description="Comment count; None when the Actor omits it."
    )
    upvote_ratio: float | None = Field(
        default=None, description="Upvote ratio 0..1; None when the Actor omits it."
    )
    over_18: bool | None = Field(
        default=None, description="NSFW flag; None when the Actor omits it."
    )
    num_crossposts: int | None = Field(
        default=None, description="Crosspost count; None when the Actor omits it."
    )
    raw: dict[str, Any] = Field(
        default_factory=dict, description="The untouched Actor dataset item."
    )


class RedditScrapeResult(BaseModel):
    """Normalized items returned by the Actor run.

    ``items`` are mapped onto the stable ``NormalizedRedditItem`` shape; each
    carries the original Actor item under ``raw`` so no upstream data is lost.
    """

    count: int = Field(description="Number of items returned.")
    items: list[NormalizedRedditItem] = Field(
        default_factory=list,
        description="Normalized dataset items (raw Actor item preserved per item).",
    )
