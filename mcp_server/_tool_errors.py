"""Which tool exceptions the model is allowed to read.

python-sdk 2.x sanitizes tool failures: only a ``ToolError`` keeps its text;
any other exception reaches the client as a bare ``Error executing tool
<name>`` (``UnexpectedToolError``, original kept as ``__cause__``). v1 passed
every exception's text through.

The pure services must not import MCP types, so they opt in with one class
instead: ``services.ModelFacingError``, whose text is written for the model to
read and act on (a ``ConnectRequiredError`` recovery script, an
``InvalidArgument``, an ``ApifyError`` status line). The server
(``mcp_server.server._TemplateMCPServer``) re-labels the crash as a
``ToolError`` when its cause is one, and keeps the SDK's sanitization for
everything else - including first-party exceptions that did not opt in, and any
builtin such as ``ValueError``, which every library raises with internals in
its text (``requests.InvalidURL`` carries the full URL, a pydantic
``ValidationError`` from an upstream payload carries ``input_value=``).

The one other model-facing shape is HTTP: the daily quota (429) and paywall
refusals are ``HTTPException`` raised by ``api_server.billing``. Starlette's
type says nothing about who raised it, so the innermost traceback frame
decides. The wrappers' own refusals - the scope check and input-model
validation - raise ``ToolError`` directly in ``_tool_factory``.
"""

from types import TracebackType

from starlette.exceptions import HTTPException

from services import ModelFacingError

# HTTPExceptions raised from here carry first-party refusal text.
_BILLING_PACKAGE = "api_server.billing"


def _raised_in_billing(exc: BaseException) -> bool:
    """True when the innermost frame that raised ``exc`` is in api_server.billing."""
    tb: TracebackType | None = exc.__traceback__
    if tb is None:
        return False
    while tb.tb_next is not None:
        tb = tb.tb_next
    module = tb.tb_frame.f_globals.get("__name__") or ""
    return module == _BILLING_PACKAGE or module.startswith(_BILLING_PACKAGE + ".")


def model_facing_message(exc: BaseException | None) -> str | None:
    """Return the text the model may see for ``exc``, or None to stay sanitized."""
    if isinstance(exc, ModelFacingError):
        return str(exc)
    if isinstance(exc, HTTPException) and _raised_in_billing(exc):
        # Billing raises with a dict detail ({"code", "message", ...}); hand the
        # model the human-readable message, not the dict's Python repr.
        detail = exc.detail
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            return detail["message"]
        return str(detail)
    return None
