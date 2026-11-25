"""Operator-only services (host config / environment fixers) are CLI-only."""

from unittest.mock import patch

import yaml
from fastapi.testclient import TestClient
from pydantic import BaseModel
from typer.testing import CliRunner

import services as services_pkg
from api_server.auth import AuthenticatedUser, get_authenticated_user
from api_server.server import app
from mcp_server.server import _exposed_over_mcp, llm_tool_surface, mcp
from services import ServiceEntry, discover_services, get_registry, service
from src.cli.app import _register_builtin_commands, _register_user_commands
from src.cli.app import app as cli_app
from tests.test_template import TestTemplate

_OPERATOR_ONLY = ("config_set", "doctor_fix")

_register_builtin_commands()
_register_user_commands()


class _In(BaseModel):
    pass


class TestOperatorOnlyFlag(TestTemplate):
    def test_defaults_false_and_decorator_sets_it(self):
        discover_services()
        before = len(services_pkg._registry)
        try:
            # Decorator applied as a call so no throwaway function is named.
            service(
                name="_op_probe", description="d", input_model=_In, output_model=_In
            )(lambda inp: inp)
            service(
                name="_op_probe_on",
                description="d",
                input_model=_In,
                output_model=_In,
                operator_only=True,
            )(lambda inp: inp)

            by_name = {e.name: e for e in get_registry()}
            assert by_name["_op_probe"].operator_only is False
            assert by_name["_op_probe_on"].operator_only is True
        finally:
            # Keep the global registry clean for transports that iterate it.
            del services_pkg._registry[before:]

    def test_flags_pinned(self):
        discover_services()
        flagged = {e.name for e in get_registry() if e.operator_only}
        assert flagged == set(_OPERATOR_ONLY)

    def test_flag_alone_keeps_a_service_off_mcp(self):
        # Not in the MCP name list: only the flag excludes it.
        entry = ServiceEntry(
            name="_op_unlisted",
            description="d",
            input_model=_In,
            output_model=_In,
            func=lambda inp: inp,
            operator_only=True,
        )
        assert not _exposed_over_mcp(entry)


class TestOperatorOnlyTransports(TestTemplate):
    def setup_method(self):
        app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser(
            user_id="test-user", email="t@t.com", auth_method="jwt"
        )
        self.client = TestClient(app)

    def teardown_method(self):
        app.dependency_overrides.clear()

    def test_rest_has_no_route(self):
        paths = {getattr(r, "path", None) for r in app.routes}
        for name in _OPERATOR_ONLY:
            assert f"/api/v1/services/{name}" not in paths
            resp = self.client.post(
                f"/api/v1/services/{name}",
                json={"key": "a.b", "value": "1"},
                headers={"Idempotency-Key": "k"},
            )
            assert resp.status_code == 404, name

    def test_mcp_has_no_tool(self):
        tools = mcp._tool_manager._tools
        surface = {e.name for e in llm_tool_surface()}
        for name in _OPERATOR_ONLY:
            assert name not in tools
            assert name not in surface

    def test_cli_config_set_still_works(self, tmp_path):
        with patch("services.config_svc._ROOT_DIR", tmp_path):
            result = CliRunner().invoke(
                cli_app, ["config", "set", "logging.verbose", "true"]
            )
        assert result.exit_code == 0, result.output
        written = yaml.safe_load((tmp_path / ".global_config.yaml").read_text())
        assert written == {"logging": {"verbose": True}}
