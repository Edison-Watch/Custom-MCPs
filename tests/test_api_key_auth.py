"""Tests for API key create / validate / revoke / expire flow."""

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from api_server.auth.api_key_auth import (
    create_api_key,
    revoke_api_key,
    validate_api_key,
)
from db.base import Base
from tests.test_template import TestTemplate

_REPO_ROOT = Path(__file__).resolve().parent.parent
# API keys go in X-API-KEY; the Bearer slot is for JWT / OAuth tokens only, so a
# `Bearer sk_...` example in user-facing docs 401s for anyone who copies it.
_BEARER_API_KEY = re.compile(r"Bearer\s+sk[_-]")
_DOC_GLOBS = (
    "docs/content/**/*.md*",
    "landing-page/src/**/*.ts",
    ".agents/skills/**/*.md",
    "**/README.md",
)
_SKIP_DIRS = {"node_modules", ".venv", "site-packages"}


def _make_session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


class TestAPIKeyAuth(TestTemplate):
    def test_create_and_validate(self):
        session = _make_session()
        raw_key, row = create_api_key(session, user_id="user-1", name="test-key")
        assert raw_key.startswith("sk_")
        assert row.key_prefix == raw_key[:11]

        validated = validate_api_key(session, raw_key)
        assert validated is not None
        assert validated.user_id == "user-1"

    def test_create_with_scopes(self):
        session = _make_session()
        scopes = ["services:read", "services:execute"]
        raw_key, row = create_api_key(
            session, user_id="scoped-user", name="scoped-key", scopes=scopes
        )
        assert row.scopes == scopes

        validated = validate_api_key(session, raw_key)
        assert validated is not None
        assert validated.scopes == scopes

    def test_create_without_scopes_is_none(self):
        session = _make_session()
        raw_key, row = create_api_key(session, user_id="legacy-user")
        assert row.scopes is None

    def test_invalid_key_returns_none(self):
        session = _make_session()
        assert validate_api_key(session, "sk_bogus") is None

    def test_revoked_key_rejected(self):
        session = _make_session()
        raw_key, row = create_api_key(session, user_id="user-2")
        revoke_api_key(session, key_id=row.id, user_id="user-2")
        assert validate_api_key(session, raw_key) is None

    def test_expired_key_rejected(self):
        session = _make_session()
        raw_key, row = create_api_key(
            session,
            user_id="user-3",
            expires_in_days=0,
        )
        # Force expiry into the past
        row.expires_at = datetime.now(UTC) - timedelta(hours=1)
        session.commit()

        assert validate_api_key(session, raw_key) is None

    def test_revoke_wrong_user_returns_false(self):
        session = _make_session()
        _raw_key, row = create_api_key(session, user_id="user-4")
        assert revoke_api_key(session, key_id=row.id, user_id="wrong-user") is False


class TestAPIKeyDocs(TestTemplate):
    def test_docs_never_send_api_key_as_bearer(self):
        offenders = [
            f"{path.relative_to(_REPO_ROOT)}:{lineno}"
            for pattern in _DOC_GLOBS
            for path in _REPO_ROOT.glob(pattern)
            if _SKIP_DIRS.isdisjoint(path.parts)
            for lineno, line in enumerate(path.read_text().splitlines(), 1)
            if _BEARER_API_KEY.search(line)
        ]
        assert not offenders, f"Use `X-API-KEY: sk_...`, not Bearer: {offenders}"
