"""YouTube scraper service - first-party wrapper over two Apify Actors.

YouTube's Apify ecosystem splits the work across two Actors, so this service
chains them behind one surface:

- ``streamers/youtube-scraper`` turns a search term (or start URLs) into videos.
- ``streamers/youtube-comments-scraper`` turns video URLs into comments, and is
  only run when the caller asks for comments (``max_comments`` > 0).

Both calls use the Apify ``run-sync-get-dataset-items`` endpoint, which starts
the Actor, blocks until it finishes, and returns its dataset in one HTTP
response - keeping the service a pure synchronous ``@service`` function with no
polling or run-state bookkeeping. Apify caps a synchronous run at 300s *per
Actor*; large ``max_results`` combined with deep ``max_comments`` can approach
that ceiling and should move to async runs instead.

Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
Search Actor:   https://apify.com/streamers/youtube-scraper/input-schema
Comments Actor: https://apify.com/streamers/youtube-comments-scraper/input-schema
"""

import httpx
from loguru import logger as log

from common import global_config
from models.youtube import YoutubeScrapeInput, YoutubeScrapeResult
from services import service

# Actor slugs in tilde form (username~name).
_SEARCH_ACTOR_ID = "streamers~youtube-scraper"
_COMMENTS_ACTOR_ID = "streamers~youtube-comments-scraper"
_APIFY_BASE = "https://api.apify.com/v2"
# Apify's hard ceiling for a synchronous run; also what we ask each run to honour.
_RUN_TIMEOUT_S = 300
# Give httpx headroom over the server-side run timeout so the 300s cap surfaces
# as an Apify response, not a client read timeout.
_HTTP_TIMEOUT_S = 330.0

# Map our friendly comment-sort keys onto the comments Actor's enum.
_COMMENT_SORT_MAP = {"top": "TOP_COMMENTS", "new": "NEWEST_FIRST"}


class ApifyError(RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out."""


def _run_actor(actor_id: str, actor_input: dict, token: str) -> list[dict]:
    """Run an Actor synchronously and return its dataset items.

    Wraps transport, HTTP-status, and response-shape failures in ``ApifyError``.
    """
    url = f"{_APIFY_BASE}/acts/{actor_id}/run-sync-get-dataset-items"
    params = {"timeout": _RUN_TIMEOUT_S, "format": "json"}
    # Bearer header rather than a ?token= query param: Apify recommends it, and
    # it keeps the secret out of URLs that proxies and servers may log.
    headers = {"Authorization": f"Bearer {token}"}

    log.info("youtube_scrape: starting Apify run for actor {}", actor_id)
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, params=params, headers=headers, json=actor_input)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Apify puts a JSON {"error": {...}} body on 4xx/5xx; surface it.
        raise ApifyError(
            f"Apify returned {exc.response.status_code}: {exc.response.text[:500]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ApifyError(f"Could not reach Apify: {type(exc).__name__}: {exc}") from exc

    try:
        items = resp.json()
    except ValueError as exc:
        raise ApifyError(f"Apify returned invalid JSON: {exc}") from exc

    if not isinstance(items, list):
        # A dict here is typically an Apify error object (bad input, run failed).
        raise ApifyError(f"Unexpected Apify response shape: {type(items).__name__}")
    if not all(isinstance(item, dict) for item in items):
        raise ApifyError("Apify returned a dataset item that is not an object")

    log.info("youtube_scrape: actor {} returned {} items", actor_id, len(items))
    return items


def _build_search_input(inp: YoutubeScrapeInput) -> dict:
    """Map the first-party input onto the search Actor's input schema."""
    actor_input: dict = {
        "maxResults": inp.max_results,
        # Keep the run scoped to standard videos; callers target shorts/streams
        # explicitly via start_urls when they need them.
        "maxResultsShorts": 0,
        "maxResultStreams": 0,
        "sortingOrder": inp.sort,
    }
    if inp.search:
        actor_input["searchQueries"] = [inp.search]
    if inp.start_urls:
        actor_input["startUrls"] = [{"url": u} for u in inp.start_urls]
    if inp.date_filter:
        actor_input["dateFilter"] = inp.date_filter
    return actor_input


def _video_urls(videos: list[dict]) -> list[str]:
    """Canonical watch URLs for the scraped videos, de-duplicated in order.

    Prefer building ``watch?v=<id>`` from the video id so playlist/radio query
    params on the raw ``url`` don't confuse the comments Actor; fall back to the
    raw url when no id is present.
    """
    seen: set[str] = set()
    urls: list[str] = []
    for v in videos:
        vid = v.get("id")
        url = f"https://www.youtube.com/watch?v={vid}" if vid else v.get("url")
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


@service(
    name="youtube_scrape",
    description=(
        "Scrape YouTube search results and video comments via a search term or "
        "explicit URLs. Returns the matched videos and, when max_comments is "
        "raised above zero, comments on those videos."
    ),
    input_model=YoutubeScrapeInput,
    output_model=YoutubeScrapeResult,
)
def youtube_scrape(input: YoutubeScrapeInput) -> YoutubeScrapeResult:
    token = global_config.APIFY_API_KEY
    if not token:
        raise ApifyError(
            "APIFY_API_KEY is not configured. Set it in your .env to use the "
            "YouTube scraper."
        )

    videos = _run_actor(_SEARCH_ACTOR_ID, _build_search_input(input), token)

    comments: list[dict] = []
    if input.max_comments > 0:
        urls = _video_urls(videos)
        if urls:
            comments = _run_actor(
                _COMMENTS_ACTOR_ID,
                {
                    "startUrls": [{"url": u} for u in urls],
                    "maxComments": input.max_comments,
                    "sortCommentsBy": _COMMENT_SORT_MAP[input.comment_sort],
                },
                token,
            )

    return YoutubeScrapeResult(
        video_count=len(videos),
        comment_count=len(comments),
        videos=videos,
        comments=comments,
    )
