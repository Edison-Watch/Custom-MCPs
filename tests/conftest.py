from unittest.mock import patch

import pytest

import api_server.runner as runner


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "order: mark test to run in a specific order")
    config.addinivalue_line(
        "markers", "e2e: mark test as end-to-end (requires live services)"
    )


@pytest.fixture(autouse=True)
def _no_background_idempotency_sweep():
    """Keep the app lifespan's idempotency sweep off the test database.

    Entering ``TestClient(app)`` starts the sweep, which runs a DELETE + COMMIT
    in a worker thread as soon as the app starts. Tests patch ``db.engine`` onto
    ONE in-memory SQLite connection (``StaticPool``), so that commit races the
    request's own transaction on the same connection. The result is flaky
    ``cannot commit - no transaction is active`` / ``StaleDataError`` failures
    and even a corrupted daily-quota counter, seen on slow CI runners.
    Tests that exercise the sweep (``TestScheduledSweep``) patch it themselves;
    their inner patch takes precedence over this one.
    """
    with patch.object(runner, "cleanup_expired_idempotency_keys", return_value=0):
        yield
