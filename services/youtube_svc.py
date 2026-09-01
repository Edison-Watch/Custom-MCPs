"""YouTube scraper service - first-party wrapper over an Apify Actor.

Calls the Apify ``run-sync-get-dataset-items`` endpoint, which starts the Actor,
blocks until it finishes, and returns its dataset in one HTTP response. That
keeps the service a pure synchronous ``@service`` function with no polling or
run-state bookkeeping. Apify caps a synchronous run at 300s; queries expected to
exceed that (large ``max_results`` combined with deep ``max_comments``) should
move to an async run + dataset fetch instead.

Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
Actor input schema: https://apify.com/streamers/youtube-scraper/input-schema
"""

import httpx
from loguru import logger as log

from common import global_config
from models.youtube import YoutubeScrapeInput, YoutubeScrapeResult
from services import service

# Actor slug in tilde form (username~name). streamers/youtube-scraper handles
# search results, channels, playlists, and per-video comments in one run.
_ACTOR_ID = "streamers~youtube-scraper"
_APIFY_BASE = "https://api.apify.com/v2"
# Apify's hard ceiling for a synchronous run; also what we ask the run to honour.
_RUN_TIMEOUT_S = 300
# Give httpx headroom over the server-side run timeout so the 300s cap surfaces
# as an Apify response, not a client read timeout.
_HTTP_TIMEOUT_S = 330.0

# Map our friendly sort keys onto the Actor's search-ordering enum.
_SORT_MAP = {
    "relevance": "relevance",
    "date": "date",
    "views": "views",
    "rating": "rating",
}
# The Actor takes comment ordering as "top" | "new"; our model already matches.


class ApifyError(RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out."""


def _build_actor_input(inp: YoutubeScrapeInput) -> dict:
    """Map the first-party input onto the Actor's input schema."""
    actor_input: dict = {
        "maxResults": inp.max_results,
        # Keep the run scoped to standard videos; callers target shorts/streams
        # explicitly via start_urls when they need them.
        "maxResultsShorts": 0,
        "maxResultStreams": 0,
        "maxComments": inp.max_comments,
        "commentsSortBy": inp.comment_sort,
        "sortVideosBy": _SORT_MAP[inp.sort],
        "proxy": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
    }
    if inp.search:
        actor_input["searchKeywords"] = inp.search
    if inp.start_urls:
        actor_input["startUrls"] = [{"url": u} for u in inp.start_urls]
    if inp.date_filter:
        actor_input["dateFilter"] = inp.date_filter
    return actor_input


@service(
    name="youtube_scrape",
    description=(
        "Scrape YouTube search results and video comments via a search term or "
        "explicit URLs. Returns the matched videos and, when max_comments is "
        "raised above zero, their comments."
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

    url = f"{_APIFY_BASE}/acts/{_ACTOR_ID}/run-sync-get-dataset-items"
    params = {"timeout": _RUN_TIMEOUT_S, "format": "json"}
    # Bearer header rather than a ?token= query param: Apify recommends it, and
    # it keeps the secret out of URLs that proxies and servers may log.
    headers = {"Authorization": f"Bearer {token}"}
    actor_input = _build_actor_input(input)

    log.info("youtube_scrape: starting Apify run for actor {}", _ACTOR_ID)
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
        raise ApifyError(f"Unexpected Apify response shape: {type(items).__name__}")
    if not all(isinstance(item, dict) for item in items):
        raise ApifyError("Apify returned a dataset item that is not an object")

    log.info("youtube_scrape: run returned {} items", len(items))
    return YoutubeScrapeResult(count=len(items), items=items)
