"""reddit_scrape_fetch labels each Apify request in its error.

A dataset GET failure must say "dataset fetch", not "run fetch", so the
model-facing message points at the right request.
"""

from __future__ import annotations

import httpx
import pytest

from models.reddit import RedditScrapeFetchInput
from services.reddit_svc import ApifyError, reddit_scrape_fetch
from tests.test_reddit_scraper import _actor, _mock_http, _token
from tests.test_template import TestTemplate


class TestFetchLabels(TestTemplate):
    def test_dataset_fetch_error_is_labelled_dataset_fetch(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if "/actor-runs/RUN123" in request.url.path:
                return httpx.Response(
                    200,
                    json={"data": {"status": "SUCCEEDED", "defaultDatasetId": "DS123"}},
                )
            return httpx.Response(503, text="upstream down")

        with (
            _token("test-token"),
            _actor("trudax~reddit-scraper"),
            _mock_http(handler),
            pytest.raises(ApifyError, match="dataset fetch") as exc_info,
        ):
            reddit_scrape_fetch(RedditScrapeFetchInput(run_id="RUN123"))
        assert "upstream down" not in str(exc_info.value)
