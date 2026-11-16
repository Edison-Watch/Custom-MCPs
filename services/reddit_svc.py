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
from services import ModelFacingError, service
from services.reddit_adapters import adapter_for
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

# Default Actor slug in tilde form (username~name). fatihtahta/reddit-scraper-
# search-fast ran ~2.5x cheaper per run than trudax/reddit-scraper-lite in
# production ($0.042 vs $0.105) and never TIMED-OUT (lite timed out on ~16% of
# runs, each still billed). Overridable at runtime via APIFY_ACTOR_ID; each
# supported Actor has an adapter (input builder + field map) that maps it onto
# the stable NormalizedRedditItem shape, so trudax stays an instant rollback.
_DEFAULT_ACTOR_ID = "fatihtahta~reddit-scraper-search-fast"
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


class ApifyError(ModelFacingError, RuntimeError):
    """Raised when the Apify API is unreachable, unauthorized, or errors out.

    Model-facing, so its text must stay first-party: the operation, the HTTP
    status and a short reason of our own. The upstream body and httpx's
    exception text (which carries the request URL) go to the log only.
    """


# Our own short reason per upstream status, so no server-supplied text (the
# body, or a custom reason phrase) is ever echoed into a model-facing message.
_STATUS_REASONS: dict[int, str] = {
    400: "Apify rejected the request input",
    401: "check APIFY_API_KEY",
    402: "the Apify account is out of credit",
    403: "check APIFY_API_KEY and the actor's permissions",
    404: "not found; check APIFY_ACTOR_ID (and the run id, when fetching a run)",
    429: "rate limited by Apify; retry later",
}


def _status_reason(status: int) -> str:
    if status >= 500:
        return "Apify server error; retry later"
    return _STATUS_REASONS.get(status, "unexpected response")


def _raise_apify_http(exc: httpx.HTTPError, operation: str) -> NoReturn:
    """Map an httpx error onto a first-party ApifyError; details go to the log."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        log.warning(
            "Apify {} failed: HTTP {}: {}", operation, status, exc.response.text[:500]
        )
        raise ApifyError(
            f"Apify {operation} failed: HTTP {status} ({_status_reason(status)})"
        ) from exc
    log.warning("Apify {}: could not reach Apify: {!r}", operation, exc)
    raise ApifyError(
        f"Apify {operation} failed: could not reach Apify "
        f"({type(exc).__name__}); retry later"
    ) from exc


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


# --- Per-Actor input building ----------------------------------------------
#
# Each supported Actor takes a different input schema. The mapping lives in the
# per-Actor adapter (services/reddit_adapters.py) alongside that Actor's output
# field map, so the input we send and the output we normalize resolve from one
# source of truth. Build the request via ``adapter_for(actor_id).build_input``.


def _build_actor_input(inp: RedditScrapeInput, actor_id: str) -> dict:
    """Map the first-party input onto the configured Actor's input schema."""
    return adapter_for(actor_id).build_input(inp)


@service(
    name="reddit_scrape",
    description=(
        "Scrape Reddit posts, comments, communities, or users via a search term "
        "or explicit URLs. Returns the matched items."
    ),
    input_model=RedditScrapeInput,
    output_model=RedditScrapeResult,
    # Runs a paid Apify Actor (same as reddit_scrape_start, just blocking): a
    # REST retry must replay the first run's items, not start and bill a second.
    mutating=True,
)
def reddit_scrape(input: RedditScrapeInput) -> RedditScrapeResult:
    token = _require_token()

    actor_id = _actor_id()
    url = f"{_apify_base()}/acts/{actor_id}/run-sync-get-dataset-items"
    params = {"timeout": _RUN_TIMEOUT_S, "format": "json"}
    # Bearer header rather than a ?token= query param: Apify recommends it, and
    # it keeps the secret out of URLs that proxies and servers may log.
    headers = {"Authorization": f"Bearer {token}"}
    actor_input = _build_actor_input(input, actor_id)

    log.info("reddit_scrape: starting Apify run for actor {}", actor_id)
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, params=params, headers=headers, json=actor_input)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        _raise_apify_http(exc, "run")

    items = _json(resp, "run")

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


def _json(resp: httpx.Response, operation: str) -> Any:
    """Parse an Apify JSON body; the decoder's text goes to the log only."""
    try:
        return resp.json()
    except ValueError as exc:
        log.warning("Apify {}: invalid JSON response: {}", operation, exc)
        raise ApifyError(f"Apify {operation} failed: invalid JSON response") from exc


def _run_data(resp: httpx.Response, operation: str) -> dict[str, Any]:
    """Parse an Apify run envelope ``{"data": {...}}`` and return ``data``."""
    payload = _json(resp, operation)
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
    actor_input = _build_actor_input(input, actor_id)

    log.info("reddit_scrape_start: enqueuing async Apify run for actor {}", actor_id)
    try:
        with httpx.Client(timeout=_START_HTTP_TIMEOUT_S) as client:
            resp = client.post(url, headers=headers, json=actor_input)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        _raise_apify_http(exc, "run start")

    data = _run_data(resp, "run start")
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
            data = _run_data(run_resp, "run status")
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
                try:
                    items_resp.raise_for_status()
                except httpx.HTTPError as exc:
                    _raise_apify_http(exc, "dataset fetch")
                items = _json(items_resp, "dataset fetch")
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
        _raise_apify_http(exc, "run fetch")

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
