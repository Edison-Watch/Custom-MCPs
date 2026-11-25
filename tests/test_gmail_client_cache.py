"""Gmail client cache: fails closed across workers, bounded, rebuilds on reconnect.

``_get_gmail_client`` caches one built client per user. A disconnect only clears
the cache of the process that handled it, so every call must re-check the token
row: a row revoked by another worker (simulated here by writing ``revoked_at``
straight to the DB, bypassing ``_invalidate_gmail_client``) must stop the cached
client being served.
"""

from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

import services.gmail_svc as gmail_svc
from common.token_encryption import PlaintextEncryption
from db.models.google_tokens import GoogleToken
from services.gmail_svc import GmailNotConnectedError, _get_gmail_client
from tests.test_gmail_services import _patch_db, _seed_token
from tests.test_template import TestTemplate


@contextmanager
def _stub_google():
    """Stub token mint + discovery build; each build returns a fresh client."""
    gmail_svc._client_cache.clear()
    with (
        patch(
            "common.token_encryption.require_encryption",
            return_value=PlaintextEncryption(),
        ),
        patch.object(gmail_svc, "_mint_access_token", return_value="AT") as mint,
        patch(
            "googleapiclient.discovery.build", side_effect=lambda *a, **k: MagicMock()
        ),
    ):
        try:
            yield mint
        finally:
            gmail_svc._client_cache.clear()


def _update_row(factory, user_id: str, **fields) -> None:
    s = factory()
    row = s.get(GoogleToken, user_id)
    for k, v in fields.items():
        setattr(row, k, v)
    s.commit()
    s.close()


class TestGmailClientCache(TestTemplate):
    def test_cache_hit_skips_token_mint(self):
        with _patch_db() as factory, _stub_google() as mint:
            _seed_token(factory)
            first = _get_gmail_client("alice")
            assert _get_gmail_client("alice") is first
            assert mint.call_count == 1

    def test_revoked_on_another_worker_fails_closed(self):
        """The cached client must not outlive a revoke this process never saw."""
        with _patch_db() as factory, _stub_google():
            _seed_token(factory)
            _get_gmail_client("alice")
            assert "alice" in gmail_svc._client_cache
            _update_row(factory, "alice", revoked_at=datetime.now(UTC))
            with pytest.raises(GmailNotConnectedError):
                _get_gmail_client("alice")
            assert "alice" not in gmail_svc._client_cache

    def test_reconnect_with_new_token_rebuilds_client(self):
        with _patch_db() as factory, _stub_google() as mint:
            _seed_token(factory)
            old = _get_gmail_client("alice")
            _update_row(factory, "alice", refresh_token_enc=b"RT2")
            new = _get_gmail_client("alice")
            assert new is not old
            assert mint.call_args.args == ("RT2",)

    def test_expired_entry_is_rebuilt(self):
        with _patch_db() as factory, _stub_google() as mint:
            _seed_token(factory)
            old = _get_gmail_client("alice")
            with patch.object(
                gmail_svc.time,
                "time",
                return_value=gmail_svc.time.time() + gmail_svc._CLIENT_TTL_S + 1,
            ):
                assert _get_gmail_client("alice") is not old
            assert mint.call_count == 2

    def test_cache_is_lru_bounded(self):
        with (
            _patch_db() as factory,
            _stub_google(),
            patch.object(gmail_svc, "_CLIENT_CACHE_MAX", 2),
        ):
            for user in ("a", "b", "c"):
                _seed_token(factory, user)
            _get_gmail_client("a")
            _get_gmail_client("b")
            _get_gmail_client("a")  # touch: "b" is now the coldest
            _get_gmail_client("c")
            assert list(gmail_svc._client_cache) == ["a", "c"]
