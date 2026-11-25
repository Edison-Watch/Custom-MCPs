"""Idempotency cache at rest: encrypted response bodies + the scheduled TTL sweep."""

import asyncio
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from pydantic import BaseModel

from api_server import runner
from api_server.idempotency import execute_idempotent
from common.token_encryption import FernetEncryption
from db.models.idempotency_keys import IdempotencyRecord
from tests.test_idempotency import _hash, _IdempotentDB, _request
from tests.test_template import TestTemplate


class _Secret(BaseModel):
    secret: str


class TestResponseEncryptionAtRest(_IdempotentDB):
    """Cached bodies hold one-time secrets / PII, so they must not be plaintext."""

    _SECRET = "whsec_one_time_hmac_secret_value"

    def _run_secret(self, key, counter):
        def _compute():
            counter["n"] += 1
            return _Secret(secret=self._SECRET)

        return execute_idempotent(
            request=_request(key),
            user_id="u1",
            route="webhook_subscribe",
            request_payload={"url": "https://example.com/hook"},
            compute=_compute,
        )

    def test_cached_row_is_not_plaintext(self):
        self._run_secret("k1", {"n": 0})
        with self.engine.connect() as conn:
            raw = conn.exec_driver_sql(
                "SELECT response_body FROM idempotency_keys"
            ).scalar_one()
        assert self._SECRET not in str(raw)
        assert "enc_v1" in str(raw)

    def test_replay_returns_secret_intact(self):
        counter = {"n": 0}
        first = self._run_secret("k1", counter)
        replay = self._run_secret("k1", counter)
        assert counter["n"] == 1
        assert first.secret == self._SECRET
        assert f'"secret":"{self._SECRET}"'.encode() in replay.body

    def test_legacy_plaintext_row_replays_as_is(self):
        # Rows cached before encryption shipped must replay, never re-execute.
        with self.SessionLocal() as session:
            session.add(
                IdempotencyRecord(
                    user_id="u1",
                    route="demo",
                    idempotency_key="legacy",
                    request_hash=_hash({"a": 1}),
                    status_code=200,
                    response_body={"value": 7},
                    completed_at=datetime.now(UTC),
                )
            )
            session.commit()
        counter = {"n": 0}
        replay = self._run("legacy", {"a": 1}, counter)
        assert counter["n"] == 0
        assert b'"value":7' in replay.body

    def test_undecryptable_row_is_409_not_reexecuted(self):
        self._run_secret("k1", {"n": 0})
        other = FernetEncryption(Fernet.generate_key().decode())
        counter = {"n": 0}
        with (
            patch("api_server.idempotency.require_encryption", return_value=other),
            pytest.raises(HTTPException) as exc,
        ):
            self._run_secret("k1", counter)
        assert exc.value.status_code == 409
        assert counter["n"] == 0


class TestScheduledSweep(TestTemplate):
    """The TTL sweep runs from the app lifespan, not from request traffic."""

    def _enter(self, db_uri):
        async def _go():
            async with runner.idempotency_sweep_lifespan(None):
                for _ in range(50):
                    await asyncio.sleep(0.01)
                    if sweep.call_count:
                        break

        with (
            patch.object(runner.global_config, "BACKEND_DB_URI", db_uri),
            patch.object(
                runner, "cleanup_expired_idempotency_keys", return_value=0
            ) as sweep,
        ):
            asyncio.run(_go())
        return sweep

    def test_sweeps_at_startup_when_db_configured(self):
        assert self._enter("sqlite:///:memory:").call_count == 1

    def test_dormant_without_db(self):
        assert self._enter(None).call_count == 0
