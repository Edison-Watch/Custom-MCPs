"""Reddit scraper service - first-party wrapper over an Apify Actor.

``reddit_scrape`` calls the Apify ``run-sync-get-dataset-items`` endpoint, which
starts the Actor, blocks until it finishes, and returns its dataset in one HTTP
response. That keeps the tool a pure synchronous ``@service`` function with no
polling or run-state bookkeeping. Apify caps a synchronous run at 300s; queries
expected to exceed that (keyword search enumeration) use the async pair instead:
``reddit_scrape_start`` kicks off a non-blocking run and returns its id, and
``reddit_scrape_fetch`` polls that run and returns the normalized items once it
has SUCCEEDED. All three share ``_build_actor_input`` + the normalizer, so an
item looks identical whichever path produced it.

Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
      https://docs.apify.com/api/v2/act-runs-post
      https://docs.apify.com/api/v2/actor-run-get
"""

from typing import Any, NoReturn

import httpx
from loguru import logger as log

from common import global_config
from models.reddit import (
    NormalizedRedditItem,
    RedditScrapeFetchInput,
    RedditScrapeFetchResult,
    RedditScrapeInput,
    RedditScrapeResult,
    RedditScrapeStartResult,
)
from services import service
from services.reddit_normalize import normalize_item, normalize_items

# Re-exported so callers keep importing the normalizer from this module even
# though its implementation now lives in services/reddit_normalize.py.
__all__ = [
    "ApifyError",
    "normalize_item",
    "normalize_items",
    "reddit_scrape",
    "reddit_scrape_fetch",
    "reddit_scrape_start",
]

# Default Actor slug in tilde form (username~name). trudax/reddit-scraper-lite is
# pay-per-result (~$0.0038/item) rather than the $45/mo flat-rate sibling.
# Overridable at runtime via APIFY_ACTOR_ID; the normalizer maps whichever Actor
# is configured onto the stable NormalizedRedditItem shape (see below).
_DEFAULT_ACTOR_ID = "trudax~reddit-scraper-lite"
_APIFY_BASE = "https://api.apify.com/v2"
# Apify's hard ceiling for a synchronous run; also what we ask the run to honour.
_RUN_TIMEOUT_S = 300
# Give httpx headroom over the server-side run timeout so the 300s cap surfaces
# as an Apify response, not a client read timeout.
_HTTP_TIMEOUT_S = 330.0
# The async start/poll calls never wait on the Actor, so they use short timeouts:
# start just enqueues a run; each fetch does a run-status GET plus (once ready) a
# dataset GET. Both must stay well under any client's read ceiling.
_START_HTTP_TIMEOUT_S = 30.0
_FETCH_HTTP_TIMEOUT_S = 60.0

# Apify run statuses. SUCCEEDED is the only terminal-success state; the failures
# are terminal too but yield no items; everything else means "still working, poll
# again". https://docs.apify.com/platform/actors/running/runs-and-builds#lifecycle
_SUCCEEDED = "SUCCEEDED"
_TERMINAL_FAILURE = frozenset({"FAILED", "TIMED-OUT", "ABORTED"})


def _actor_id() -> str:
    """The configured Actor slug, or the default when APIFY_ACTOR_ID is unset."""
    return (global_config.APIFY_ACTOR_ID or "").strip() or _DEFAULT_ACTOR_ID


def _apify_base() -> str:
    """API base with any trailing slash stripped so path joins never double up."""
    return _APIFY_BASE.rstrip("/")


class ApifyError(RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out."""


def _require_token() -> str:
    """The first-party Apify token, or an ApifyError if it is unconfigured."""
    token = global_config.APIFY_API_KEY
    if not token:
        raise ApifyError(
            "APIFY_API_KEY is not configured. Set it in your .env to use the "
            "Reddit scraper."
        )
    return token


# --- Normalization ---------------------------------------------------------
#
# The actor-agnostic mapping layer lives in services/reddit_normalize.py so
# this module stays focused on the Apify HTTP transport. normalize_item /
# normalize_items are re-exported below for callers that import them from here.


def _normalize_dataset(items: Any, actor_id: str) -> list[NormalizedRedditItem]:
    """Validate a parsed Apify dataset payload, then normalize it.

    Shared by the sync ``reddit_scrape`` and async ``reddit_scrape_fetch`` paths
    so a dataset item is validated and mapped identically however it was
    fetched. A dataset must be a JSON array of objects; anything else is an
    ApifyError rather than malformed data handed back to the caller.
    """
    if not isinstance(items, list):
        raise ApifyError(f"Unexpected Apify response shape: {type(items).__name__}")
    if not all(isinstance(item, dict) for item in items):
        raise ApifyError("Apify returned a dataset item that is not an object")
    return normalize_items(items, actor_id)


def _build_actor_input(inp: RedditScrapeInput) -> dict:
    """Map the first-party input onto the Actor's input schema."""
    actor_input: dict = {
        "maxItems": inp.max_items,
        "maxPostCount": inp.max_items,
        "skipComments": not inp.include_comments,
        "includeNSFW": inp.include_nsfw,
        # The Actor's fast RSS mode omits engagement fields; includeMediaLinks
        # switches it to a detailed scrape that returns upVotes / numberOfComments
        # / upVoteRatio (and media URLs), which the normalizer already maps.
        "includeMediaLinks": inp.include_media_links,
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
    token = _require_token()

    actor_id = _actor_id()
    url = f"{_apify_base()}/acts/{actor_id}/run-sync-get-dataset-items"
    params = {"timeout": _RUN_TIMEOUT_S, "format": "json"}
    # Bearer header rather than a ?token= query param: Apify recommends it, and
    # it keeps the secret out of URLs that proxies and servers may log.
    headers = {"Authorization": f"Bearer {token}"}
    actor_input = _build_actor_input(input)

    log.info("reddit_scrape: starting Apify run for actor {}", actor_id)
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

    normalized = _normalize_dataset(items, actor_id)
    log.info("reddit_scrape: run returned {} items", len(normalized))
    return RedditScrapeResult(count=len(normalized), items=normalized)


# --- Async run + poll -------------------------------------------------------
#
# The synchronous path above blocks one HTTP call on the whole run, which the
# innermost MCP client can cut off (~60s) long before the Actor finishes a slow
# keyword search. The pair below decouples the two: start enqueues a run and
# returns immediately, fetch polls it. Both reuse _build_actor_input, the actor
# resolution, and _normalize_dataset so the contract matches the sync path.


def _raise_apify_http(exc: httpx.HTTPError) -> NoReturn:
    """Map an httpx error onto ApifyError the same way the sync path does."""
    if isinstance(exc, httpx.HTTPStatusError):
        raise ApifyError(
            f"Apify returned {exc.response.status_code}: {exc.response.text[:500]}"
        ) from exc
    raise ApifyError(f"Could not reach Apify: {type(exc).__name__}: {exc}") from exc


def _run_data(resp: httpx.Response) -> dict[str, Any]:
    """Parse an Apify run envelope ``{"data": {...}}`` and return ``data``."""
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ApifyError(f"Apify returned invalid JSON: {exc}") from exc
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ApifyError(f"Unexpected Apify response shape: {type(payload).__name__}")
    return data


def _str_field(value: Any) -> str | None:
    """A run-envelope string field (id/status/dataset id), or None if absent."""
    return value if isinstance(value, str) else None


@service(
    name="reddit_scrape_start",
    description=(
        "Start an asynchronous Reddit scrape and return immediately with a "
        "run id (no blocking). Use for slow keyword searches that outlast a "
        "synchronous call; poll reddit_scrape_fetch with the run_id for results."
    ),
    input_model=RedditScrapeInput,
    output_model=RedditScrapeStartResult,
    # Enqueues a paid Apify run: a REST retry must replay the first run, not
    # start a second, so the API transport enforces an Idempotency-Key.
    mutating=True,
)
def reddit_scrape_start(input: RedditScrapeInput) -> RedditScrapeStartResult:
    token = _require_token()
    actor_id = _actor_id()
    url = f"{_apify_base()}/acts/{actor_id}/runs"
    headers = {"Authorization": f"Bearer {token}"}
    actor_input = _build_actor_input(input)

    log.info("reddit_scrape_start: enqueuing async Apify run for actor {}", actor_id)
    try:
        with httpx.Client(timeout=_START_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, headers=headers, json=actor_input)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        _raise_apify_http(exc)

    data = _run_data(resp)
    run_id = _str_field(data.get("id"))
    dataset_id = _str_field(data.get("defaultDatasetId"))
    status = _str_field(data.get("status"))
    if not run_id or not dataset_id or not status:
        raise ApifyError("Apify run response is missing id/defaultDatasetId/status")

    log.info("reddit_scrape_start: started run {} (status {})", run_id, status)
    return RedditScrapeStartResult(run_id=run_id, dataset_id=dataset_id, status=status)


@service(
    name="reddit_scrape_fetch",
    description=(
        "Poll an asynchronous Reddit scrape started by reddit_scrape_start. "
        "Returns the run status; items are empty while it is still running and "
        "populated once it has SUCCEEDED. Poll again on a non-terminal status."
    ),
    input_model=RedditScrapeFetchInput,
    output_model=RedditScrapeFetchResult,
)
def reddit_scrape_fetch(input: RedditScrapeFetchInput) -> RedditScrapeFetchResult:
    token = _require_token()
    actor_id = _actor_id()
    headers = {"Authorization": f"Bearer {token}"}

    try:
        with httpx.Client(timeout=_FETCH_HTTP_TIMEOUT_S) as client:
            run_resp = client.get(
                f"{_apify_base()}/actor-runs/{input.run_id}", headers=headers
            )
            run_resp.raise_for_status()
            data = _run_data(run_resp)
            status = _str_field(data.get("status"))
            # A run envelope with no status is malformed, not a non-terminal
            # state; reject it the same way the start path validates its fields.
            if not status:
                raise ApifyError("Apify run response is missing status")

            if status == _SUCCEEDED:
                dataset_id = _str_field(data.get("defaultDatasetId"))
                if not dataset_id:
                    raise ApifyError(
                        "Apify run SUCCEEDED but returned no defaultDatasetId"
                    )
                items_resp = client.get(
                    f"{_apify_base()}/datasets/{dataset_id}/items",
                    params={"format": "json", "clean": "true"},
                    headers=headers,
                )
                items_resp.raise_for_status()
                try:
                    items = items_resp.json()
                except ValueError as exc:
                    raise ApifyError(f"Apify returned invalid JSON: {exc}") from exc
                normalized = _normalize_dataset(items, actor_id)
                log.info(
                    "reddit_scrape_fetch: run {} SUCCEEDED with {} items",
                    input.run_id,
                    len(normalized),
                )
                return RedditScrapeFetchResult(
                    status=status, count=len(normalized), items=normalized
                )
    except httpx.HTTPError as exc:
        _raise_apify_http(exc)

    # Non-terminal (READY/RUNNING/*ING) or terminal failure (FAILED/TIMED-OUT/
    # ABORTED): return the status with no items so the caller either keeps
    # polling or stops, keying off the status string. No server-side sleep.
    if status in _TERMINAL_FAILURE:
        log.warning(
            "reddit_scrape_fetch: run {} terminal status {}", input.run_id, status
        )
    else:
        log.info(
            "reddit_scrape_fetch: run {} still {} - poll again", input.run_id, status
        )
    return RedditScrapeFetchResult(status=status, count=0, items=[])
