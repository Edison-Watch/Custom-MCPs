"""Integration tests for API server route registration."""

import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api_server.auth import AuthenticatedUser, get_authenticated_user
from api_server.server import app
from common import global_config, token_encryption
from common.token_encryption import FernetEncryption
from db import engine as db_engine
from db.base import Base
from db.engine import get_db_session
from db.models.thread_curation import ThreadCuration
from tests.test_template import TestTemplate

_engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
Base.metadata.create_all(_engine)
_SessionLocal = sessionmaker(bind=_engine)


@contextmanager
def _override_use_db_session():
    """Yield a session from the in-memory test engine for use_db_session."""
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _parse_sse(body: str) -> list[dict[str, str]]:
    """Parse an SSE body into a list of ``{"event", "data"}`` dicts."""
    events: list[dict[str, str]] = []
    for block in body.replace("\r\n", "\n").split("\n\n"):
        event: dict[str, str] = {}
        for line in block.splitlines():
            if line.startswith("event:"):
                event["event"] = line[len("event:") :].strip()
            elif line.startswith("data:"):
                event["data"] = line[len("data:") :].strip()
        if event:
            events.append(event)
    return events


def _override_auth():
    return AuthenticatedUser(user_id="test-user", email="t@t.com", auth_method="jwt")


def _override_db():
    session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()


class TestAPIServer(TestTemplate):
    def setup_method(self):
        app.dependency_overrides[get_authenticated_user] = _override_auth
        app.dependency_overrides[get_db_session] = _override_db
        # Patch use_db_session so ensure_daily_limit uses the test DB
        self._use_db_patcher = patch(
            "api_server.billing.limits.use_db_session",
            _override_use_db_session,
        )
        self._use_db_patcher.start()
        self.client = TestClient(app)

    def teardown_method(self):
        self._use_db_patcher.stop()
        app.dependency_overrides.clear()

    def test_health_endpoint(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] in ("ok", "degraded")
        assert "components" in data
        assert data["components"]["api"]["status"] == "ok"

    def test_greet_service(self):
        resp = self.client.post(
            "/api/v1/services/greet",
            json={"name": "World"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["message"] == "Hello, World!"

    def test_service_requires_auth(self):
        """Without auth override, endpoints should require credentials."""
        # Remove only the auth override; keep the DB override
        app.dependency_overrides.pop(get_authenticated_user, None)
        with patch("api_server.auth.workos_auth.global_config") as mock_config:
            mock_config.WORKOS_CLIENT_ID = None
            client = TestClient(app)
            resp = client.post(
                "/api/v1/services/greet",
                json={"name": "World"},
            )
            assert resp.status_code == 401

    def test_me_endpoint(self):
        resp = self.client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["user_id"] == "test-user"
        assert data["auth_method"] == "jwt"

    def test_service_routes_registered(self):
        """All services should have corresponding API routes."""
        routes = [r.path for r in app.routes if hasattr(r, "path")]
        assert "/api/v1/services/greet" in routes
        assert "/api/v1/services/config_show" in routes

    def test_mutating_service_requires_idempotency_key(self):
        """gmail_send is mutating=True, so its route enforces Idempotency-Key."""
        resp = self.client.post(
            "/api/v1/services/gmail_send",
            json={"draft_id": "draft-123"},
        )
        assert resp.status_code == 422
        assert "Idempotency-Key" in resp.json()["error"]["message"]

    def test_oversized_attachment_returns_413(self):
        """An over-cap gmail_get_attachment surfaces as 413, not a generic 500."""
        mock_svc = MagicMock()
        mock_svc.users().messages().attachments().get().execute.return_value = {
            "data": "QUJD",  # "ABC"
            "size": 10_000,
        }
        with (
            patch(
                "services.gmail_messages_svc._get_gmail_client", return_value=mock_svc
            ),
            patch.object(global_config.gmail, "max_attachment_bytes", 5),
        ):
            resp = self.client.post(
                "/api/v1/services/gmail_get_attachment",
                json={"message_id": "m-1", "attachment_id": "att-1"},
            )
        assert resp.status_code == 413
        assert resp.json()["error"]["code"] == "payload_too_large"

    def test_billing_routes_registered(self):
        """Billing routes should be registered."""
        routes = [r.path for r in app.routes if hasattr(r, "path")]
        assert "/api/v1/billing/checkout/create" in routes
        assert "/api/v1/billing/usage/current" in routes
        assert "/api/v1/billing/subscription/status" in routes

    def test_stream_doctor_route_registered(self):
        routes = [r.path for r in app.routes if hasattr(r, "path")]
        assert "/api/v1/stream/doctor" in routes

    def test_stream_doctor_emits_sse_events(self):
        """The SSE endpoint streams one `check` event per check, then `done`."""
        with self.client.stream(
            "POST", "/api/v1/stream/doctor", json={"fix": False}
        ) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            body = "".join(resp.iter_text())

        events = _parse_sse(body)
        checks = [e for e in events if e.get("event") == "check"]
        dones = [e for e in events if e.get("event") == "done"]

        assert len(checks) >= 1
        assert len(dones) == 1
        # Ordering contract: every check streams before the terminal `done`.
        assert events[-1]["event"] == "done"
        assert all(e["event"] == "check" for e in events[:-1])

        first = json.loads(checks[0]["data"])
        assert "name" in first
        assert first["status"] in ("pass", "fail", "warn")

        done = json.loads(dones[0]["data"])
        assert isinstance(done["has_failures"], bool)

    def test_stream_doctor_requires_execute_scope(self):
        """A read-only key may not open the doctor stream."""
        original = app.dependency_overrides.get(get_authenticated_user)
        try:
            app.dependency_overrides[get_authenticated_user] = lambda: (
                AuthenticatedUser(
                    user_id="scoped-user",
                    auth_method="api_key",
                    scopes=["services:read"],
                )
            )
            client = TestClient(app)
            resp = client.post("/api/v1/stream/doctor", json={"fix": False})
            assert resp.status_code == 403
        finally:
            if original is not None:
                app.dependency_overrides[get_authenticated_user] = original
            else:
                app.dependency_overrides.pop(get_authenticated_user, None)

    def test_403_on_insufficient_scopes(self):
        """A key with read-only scopes should be rejected from service execution."""
        # Override auth to return a user with limited scopes
        original = app.dependency_overrides.get(get_authenticated_user)
        try:
            app.dependency_overrides[get_authenticated_user] = lambda: (
                AuthenticatedUser(
                    user_id="scoped-user",
                    auth_method="api_key",
                    scopes=["services:read"],
                )
            )
            client = TestClient(app)
            resp = client.post("/api/v1/services/greet", json={"name": "World"})
            assert resp.status_code == 403
        finally:
            # Restore original override to prevent leaking into other tests
            if original is not None:
                app.dependency_overrides[get_authenticated_user] = original
            else:
                app.dependency_overrides.pop(get_authenticated_user, None)


class TestInboxSaveCurationIdempotency(TestTemplate):
    """The auto-generated route for inbox_save_curation (mutating=True) actually
    enforces Idempotency-Key end-to-end: missing key -> 422, replay -> cached
    body with no double-write, same key + different payload -> 422.

    This exercises the real route factory + execute_idempotent + the ledger
    write path, not a synthetic stand-in route.
    """

    ROUTE = "/api/v1/services/inbox_save_curation"

    def setup_method(self):
        self.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, expire_on_commit=False)

        @contextmanager
        def _ctx():
            session = self.SessionLocal()
            try:
                yield session
            finally:
                session.close()

        def _db_dep():
            session = self.SessionLocal()
            try:
                yield session
            finally:
                session.close()

        app.dependency_overrides[get_authenticated_user] = _override_auth
        app.dependency_overrides[get_db_session] = _db_dep

        # Route every db.engine.use_db_session caller (idempotency claim/replay,
        # billing quota, and the curation ledger) at this fresh test DB. Both
        # globals must be set: _init_engine() only short-circuits when _engine
        # is non-None, otherwise it rebuilds from BACKEND_DB_URI and clobbers
        # _SessionLocal.
        self._orig_engine = db_engine._engine
        self._orig_session_local = db_engine._SessionLocal
        db_engine._engine = self.engine
        db_engine._SessionLocal = self.SessionLocal

        self._patchers = [
            patch("api_server.idempotency.use_db_session", _ctx),
            patch("api_server.billing.limits.use_db_session", _ctx),
            # Disable opportunistic idempotency-key cleanup so it can't race.
            patch("api_server.idempotency.random.random", return_value=1.0),
            # inbox_save_curation reads each thread's current historyId to stamp
            # the row; mock the Gmail client + batch fetch (no network).
            patch("services.inbox_curation_svc._get_gmail_client"),
            patch(
                "services.inbox_curation_svc._batch_get_threads",
                return_value={"t1": {"id": "t1", "historyId": "100"}},
            ),
            # Real encryption backend for summary/reasoning at rest.
            patch.object(
                token_encryption,
                "require_encryption",
                return_value=FernetEncryption(Fernet.generate_key().decode()),
            ),
        ]
        for p in self._patchers:
            p.start()
        self.client = TestClient(app)

    def teardown_method(self):
        for p in self._patchers:
            p.stop()
        db_engine._engine = self._orig_engine
        db_engine._SessionLocal = self._orig_session_local
        app.dependency_overrides.clear()

    def _payload(self, importance: float = 0.9) -> dict:
        return {
            "judgments": [
                {
                    "thread_id": "t1",
                    "bucket": "needs_reply",
                    "importance": importance,
                    "summary": "deck due",
                }
            ]
        }

    def _ledger_rows(self, thread_id: str = "t1") -> int:
        with self.SessionLocal() as s:
            return (
                s.query(ThreadCuration)
                .filter(ThreadCuration.thread_id == thread_id)
                .count()
            )

    def test_missing_idempotency_key_422(self):
        resp = self.client.post(self.ROUTE, json=self._payload())
        assert resp.status_code == 422
        assert "Idempotency-Key" in resp.json()["error"]["message"]

    def test_replay_same_key_does_not_double_write(self):
        headers = {"Idempotency-Key": "k1"}
        first = self.client.post(self.ROUTE, json=self._payload(), headers=headers)
        assert first.status_code == 200, first.text
        assert first.json()["saved"] == 1
        # Replay: same key + same payload -> cached body, no second write.
        second = self.client.post(self.ROUTE, json=self._payload(), headers=headers)
        assert second.status_code == 200
        assert second.json() == first.json()
        assert self._ledger_rows("t1") == 1

    def test_same_key_different_payload_conflicts(self):
        headers = {"Idempotency-Key": "k2"}
        first = self.client.post(self.ROUTE, json=self._payload(0.9), headers=headers)
        assert first.status_code == 200, first.text
        conflict = self.client.post(
            self.ROUTE, json=self._payload(0.1), headers=headers
        )
        assert conflict.status_code == 422
