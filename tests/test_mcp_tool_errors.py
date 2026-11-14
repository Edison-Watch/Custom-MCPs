"""SDK 2.x behavior shims: error-text pass-through and the elicitation gate."""

import asyncio
from types import SimpleNamespace
from typing import Annotated

import pytest
from fastapi import HTTPException
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError
from pydantic import AfterValidator, BaseModel

from api_server.auth import AuthenticatedUser
from mcp_server._tool_errors import model_facing_message
from mcp_server._tool_factory import make_tool
from mcp_server.enhancers.base import client_can_elicit
from mcp_server.server import _TemplateMCPServer
from models.gmail import GmailDraft
from services import InvalidArgument, ServiceEntry
from services.gmail_svc import GmailNotConnectedError
from services.reddit_svc import ApifyError
from src.utils.current_user import reset_current_user, set_current_user
from tests.test_template import TestTemplate

# Stands in for a foreign crash (SQLAlchemy, HTTP client, ...): an exception
# class whose defining module is outside the first-party packages.
_ThirdPartyError = type(
    "OperationalError", (Exception,), {"__module__": "sqlalchemy.exc"}
)


def _raised_from(module: str, exc: BaseException | None, code: str = "raise exc"):
    """Raise ``exc`` (or run ``code``) in a frame whose module is ``module``.

    Origin checks read the innermost traceback frame's ``__name__``, so this is
    how a test stands in for "raised inside api_server.billing.limits" or
    "raised inside some third-party library".
    """
    try:
        exec(code, {"__name__": module, "exc": exc})
    except BaseException as raised:  # noqa: BLE001
        # Test helper: capture whatever the snippet raised, with its traceback.
        return raised
    raise AssertionError("snippet did not raise")


def _fake_session(*, can_send: bool, declared: bool) -> SimpleNamespace:
    return SimpleNamespace(
        can_send_request=can_send,
        check_client_capability=lambda _capability: declared,
    )


class TestModelFacingMessage(TestTemplate):
    def test_first_party_errors_keep_their_text(self):
        assert model_facing_message(InvalidArgument("bad arg")) == "bad arg"
        gmail = model_facing_message(GmailNotConnectedError("u1"))
        assert gmail is not None and gmail.startswith("No Gmail account")
        quota = _raised_from(
            "api_server.billing.limits", HTTPException(status_code=429, detail="quota")
        )
        assert model_facing_message(quota) == "quota"

    def test_builtins_are_no_longer_model_facing_by_type(self):
        # Any library raises these; their text can carry internals.
        assert model_facing_message(ValueError("bad arg")) is None
        assert model_facing_message(PermissionError("scope")) is None

    def test_third_party_http_exception_stays_sanitized(self):
        exc = _raised_from(
            "somelib.client", HTTPException(status_code=500, detail="dsn=secret")
        )
        assert model_facing_message(exc) is None
        # No traceback at all: origin unknown, so sanitized.
        assert model_facing_message(HTTPException(status_code=429)) is None

    def test_quota_dict_detail_yields_its_message(self):
        # The real billing refusal shape (api_server/billing/limits.py).
        exc = _raised_from(
            "api_server.billing.limits",
            HTTPException(
                status_code=429,
                detail={
                    "code": "quota_exceeded",
                    "message": "Daily request limit (10) exceeded for free tier.",
                    "quota_reset_at": "2026-11-15T00:00:00+00:00",
                },
            ),
        )
        assert (
            model_facing_message(exc)
            == "Daily request limit (10) exceeded for free tier."
        )

    def test_apify_errors_keep_their_text(self):
        # reddit_* tools fail with ApifyError whose text tells the model what
        # went wrong upstream (unconfigured key, timeout, bad response shape).
        assert (
            model_facing_message(ApifyError("Could not reach Apify: timeout"))
            == "Could not reach Apify: timeout"
        )

    def test_third_party_crashes_stay_sanitized(self):
        assert model_facing_message(_ThirdPartyError("dsn=secret")) is None
        assert model_facing_message(RuntimeError("internal")) is None
        assert model_facing_message(None) is None


class TestTemplateServerErrorRelabel(TestTemplate):
    def _server_with(self, exc: Exception) -> _TemplateMCPServer:
        server = _TemplateMCPServer("errors-test")

        @server.tool(name="boom")
        def boom() -> str:
            raise exc

        return server

    def test_first_party_failure_reaches_model(self):
        server = self._server_with(InvalidArgument("Webhook url must use https"))
        with pytest.raises(ToolError) as excinfo:
            asyncio.run(server.call_tool("boom", {}))
        assert not isinstance(excinfo.value, UnexpectedToolError)
        assert "Webhook url must use https" in str(excinfo.value)

    def _assert_sanitized(self, fn, secret: str) -> None:
        server = _TemplateMCPServer("errors-test")
        server.tool(name="boom")(fn)
        with pytest.raises(UnexpectedToolError) as excinfo:
            asyncio.run(server.call_tool("boom", {}))
        assert secret not in str(excinfo.value)

    def test_requests_invalid_url_is_sanitized(self):
        requests = pytest.importorskip("requests")

        def boom() -> str:
            raise requests.exceptions.InvalidURL("https://x?token=s3cr3t")

        self._assert_sanitized(boom, "s3cr3t")

    def test_value_error_from_third_party_frame_is_sanitized(self):
        def boom() -> str:
            raise _raised_from("somelib.parse", None, code='int("s3cr3t")')

        self._assert_sanitized(boom, "s3cr3t")

    def test_upstream_model_validate_failure_is_sanitized(self):
        # A service validating a Gmail payload: the pydantic error would echo
        # the upstream body back via ``input_value=``.
        def boom() -> str:
            GmailDraft.model_validate({"id": 1, "body": "private-mail-text"})
            return "unreachable"

        self._assert_sanitized(boom, "private-mail-text")

    def test_apify_failure_reaches_model(self):
        server = self._server_with(ApifyError("APIFY_API_KEY is not configured"))
        with pytest.raises(ToolError) as excinfo:
            asyncio.run(server.call_tool("boom", {}))
        assert not isinstance(excinfo.value, UnexpectedToolError)
        assert "APIFY_API_KEY is not configured" in str(excinfo.value)

    def test_third_party_failure_is_sanitized(self):
        server = self._server_with(_ThirdPartyError("dsn=secret"))
        with pytest.raises(UnexpectedToolError) as excinfo:
            asyncio.run(server.call_tool("boom", {}))
        assert "secret" not in str(excinfo.value)


class TestClientCanElicit(TestTemplate):
    def test_requires_declared_capability_and_back_channel(self):
        assert client_can_elicit(_fake_session(can_send=True, declared=True))

    def test_no_back_channel_means_no_elicitation(self):
        # Every 2026-07-28 request and stateless legacy HTTP.
        assert not client_can_elicit(_fake_session(can_send=False, declared=True))

    def test_undeclared_capability_means_no_elicitation(self):
        assert not client_can_elicit(_fake_session(can_send=True, declared=False))

    def test_no_session(self):
        assert not client_can_elicit(None)
        assert not client_can_elicit(SimpleNamespace(can_send_request=False))


def _require_even(v: int) -> int:
    if v % 2:
        raise ValueError("n must be even")
    return v


class _EvenInput(BaseModel):
    # A model-level rule the JSON schema can't express, so the SDK's own
    # argument validation passes and the input model is what rejects it.
    n: Annotated[int, AfterValidator(_require_even)]


class _EvenOutput(BaseModel):
    n: int


class TestFactoryRefusalsReachModel(TestTemplate):
    """The wrappers' own refusals are ToolErrors, so the model can act on them."""

    def _server(self) -> _TemplateMCPServer:
        server = _TemplateMCPServer("factory-errors-test")
        make_tool(
            server,
            ServiceEntry(
                name="even",
                description="d",
                input_model=_EvenInput,
                output_model=_EvenOutput,
                func=lambda inp: _EvenOutput(n=inp.n),
            ),
        )
        return server

    def test_input_model_validation_reaches_model(self):
        with pytest.raises(ToolError) as excinfo:
            asyncio.run(self._server().call_tool("even", {"n": 3}))
        assert not isinstance(excinfo.value, UnexpectedToolError)
        assert "n must be even" in str(excinfo.value)

    def test_scope_refusal_reaches_model(self):
        user = AuthenticatedUser(
            user_id="ro", auth_method="api_key", scopes=["services:read"]
        )
        token = set_current_user(user)
        try:
            with pytest.raises(ToolError) as excinfo:
                asyncio.run(self._server().call_tool("even", {"n": 2}))
        finally:
            reset_current_user(token)
        assert not isinstance(excinfo.value, UnexpectedToolError)
        assert "services:execute" in str(excinfo.value)
