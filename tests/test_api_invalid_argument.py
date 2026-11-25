"""REST mapping of a service's InvalidArgument: 400, and the claim is released."""

from contextlib import contextmanager
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api_server.auth import AuthenticatedUser, get_authenticated_user
from api_server.server import app
from common.token_encryption import FernetEncryption
from db.base import Base
from tests.test_template import TestTemplate

_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
Base.metadata.create_all(_engine)
_SessionLocal = sessionmaker(bind=_engine)


@contextmanager
def _use_db_session():
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()


class TestInvalidArgumentOverREST(TestTemplate):
    def setup_method(self):
        app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
            user_id="test-user", email="t@t.com", auth_method="jwt"
        )
        self._patchers = [
            patch("api_server.billing.limits.use_db_session", _use_db_session),
            patch("api_server.idempotency.use_db_session", _use_db_session),
            patch(
                "api_server.idempotency.require_encryption",
                return_value=FernetEncryption(Fernet.generate_key().decode()),
            ),
        ]
        for p in self._patchers:
            p.start()
        self.client = TestClient(app)

    def teardown_method(self):
        for p in self._patchers:
            p.stop()
        app.dependency_overrides.clear()

    def test_bad_webhook_url_is_400_and_same_key_retry_is_not_409(self):
        headers = {"Idempotency-Key": "bad-webhook-url-1"}
        body = {"url": "http://example.com/hook"}
        first = self.client.post(
            "/api/v1/services/webhook_subscribe", json=body, headers=headers
        )
        assert first.status_code == 400
        error = first.json()["error"]
        assert error["code"] == "bad_request"
        assert "https" in error["message"]

        retry = self.client.post(
            "/api/v1/services/webhook_subscribe", json=body, headers=headers
        )
        # The claim was released, so the retry ran (and failed) again.
        assert retry.status_code == 400

    def test_unknown_config_key_is_400(self):
        resp = self.client.post(
            "/api/v1/services/config_get", json={"key": "no.such.key"}
        )
        assert resp.status_code == 400
        assert "Key not found" in resp.json()["error"]["message"]
