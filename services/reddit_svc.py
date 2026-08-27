"""Reddit scraper service - first-party wrapper over an Apify Actor.

Calls the Apify ``run-sync-get-dataset-items`` endpoint, which starts the Actor,
blocks until it finishes, and returns its dataset in one HTTP response. That
keeps the service a pure synchronous ``@service`` function with no polling or
run-state bookkeeping. Apify caps a synchronous run at 300s; queries expected to
exceed that should move to an async run + dataset fetch instead.

Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
"""

import httpx
from loguru import logger as log

from common import global_config
from models.reddit import RedditScrapeInput, RedditScrapeResult
from services import service

# Actor slug in tilde form (username~name). trudax/reddit-scraper-lite is
# pay-per-result (~$0.0038/item) rather than the $45/mo flat-rate sibling.
_ACTOR_ID = "trudax~reddit-scraper-lite"
_APIFY_BASE = "https://api.apify.com/v2"
# Apify's hard ceiling for a synchronous run; also what we ask the run to honour.
_RUN_TIMEOUT_S = 300
# Give httpx headroom over the server-side run timeout so the 300s cap surfaces
# as an Apify response, not a client read timeout.
_HTTP_TIMEOUT_S = 330.0


class ApifyError(RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out."""


def _build_actor_input(inp: RedditScrapeInput) -> dict:
    """Map the first-party input onto the Actor's input schema."""
    actor_input: dict = {
        "maxItems": inp.max_items,
        "maxPostCount": inp.max_items,
        "skipComments": not inp.include_comments,
        "includeNSFW": inp.include_nsfw,
        "sort": inp.sort,
        "proxy": {"useApifyProxy": True, "apifyProxyGroups": ["RESIDENTIAL"]},
    }
    if inp.search:
        actor_input["searches"] = [inp.search]
    if inp.subreddit:
        actor_input["searchCommunityName"] = inp.subreddit
    if inp.start_urls:
        actor_input["startUrls"] = [{"url": u} for u in inp.start_urls]
    if inp.time_filter:
        actor_input["time"] = inp.time_filter
    return actor_input


@service(
    name="reddit_scrape",
    description=(
        "Scrape Reddit posts, comments, communities, or users via a search term "
        "or explicit URLs. Returns the matched items."
    ),
    input_model=RedditScrapeInput,
    output_model=RedditScrapeResult,
)
def reddit_scrape(input: RedditScrapeInput) -> RedditScrapeResult:
    token = global_config.APIFY_API_KEY
    if not token:
        raise ApifyError(
            "APIFY_API_KEY is not configured. Set it in your .env to use the "
            "Reddit scraper."
        )

    url = f"{_APIFY_BASE}/acts/{_ACTOR_ID}/run-sync-get-dataset-items"
    params = {"token": token, "timeout": _RUN_TIMEOUT_S, "format": "json"}
    actor_input = _build_actor_input(input)

    log.info("reddit_scrape: starting Apify run for actor {}", _ACTOR_ID)
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, params=params, json=actor_input)
        resp.raise_for_status()
        items = resp.json()
    except httpx.HTTPStatusError as exc:
        # Apify puts a JSON {"error": {...}} body on 4xx/5xx; surface it.
        raise ApifyError(
            f"Apify returned {exc.response.status_code}: {exc.response.text[:500]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ApifyError(f"Could not reach Apify: {type(exc).__name__}: {exc}") from exc

    if not isinstance(items, list):
        raise ApifyError(f"Unexpected Apify response shape: {type(items).__name__}")

    log.info("reddit_scrape: run returned {} items", len(items))
    return RedditScrapeResult(count=len(items), items=items)
