"""Tests for db.engine's driver-specific connect args."""

from db.engine import CONNECT_TIMEOUT_SECONDS, _connect_args
from tests.test_template import TestTemplate


class TestConnectArgs(TestTemplate):
    def test_postgres_gets_a_bounded_connect_timeout(self):
        expected = {"connect_args": {"connect_timeout": CONNECT_TIMEOUT_SECONDS}}
        assert _connect_args("postgresql://u:p@db/app") == expected
        assert _connect_args("postgresql+psycopg://u:p@db/app") == expected

    def test_sqlite_gets_no_connect_args(self):
        assert _connect_args("sqlite:///:memory:") == {}

    def test_explicit_connect_timeout_in_uri_is_not_overridden(self):
        assert _connect_args("postgresql://u:p@db/app?connect_timeout=30") == {}
