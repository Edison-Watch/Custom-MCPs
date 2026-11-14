"""Which tool exceptions the model is allowed to read.

python-sdk 2.x sanitizes tool failures: only a ``ToolError`` keeps its text;
any other exception reaches the client as a bare ``Error executing tool
<name>`` (``UnexpectedToolError``, original kept as ``__cause__``). v1 passed
every exception's text through.

This template's services are written to fail with model-facing messages - a
``ConnectRequiredError`` carries its own recovery script, Gmail domain
errors and the reddit tools' ``ApifyError`` say what to do next, the daily quota explains the
refusal, a bad argument is an ``InvalidArgument`` - and the pure services must
not import MCP types to say so. So the server
(``mcp_server.server._TemplateMCPServer``) re-labels the crash as a
``ToolError`` when its cause is one of those *first-party* failures, and keeps
the SDK's sanitization for everything else.

Origin, not type, decides. A builtin such as ``ValueError`` is not model-facing:
any library raises it (``requests.InvalidURL`` carries the full URL, a pydantic
``ValidationError`` from validating an upstream payload carries
``input_value=``). The wrappers' own deliberate refusals - the scope check and
input-model validation - raise ``ToolError`` directly in ``_tool_factory``.
"""

from types import TracebackType

from starlette.exceptions import HTTPException

# Exceptions defined in these packages are written for the caller to read.
_FIRST_PARTY_PREFIXES = ("services", "models", "api_server", "src", "common")


def _is_first_party(module: str | None) -> bool:
    return (module or "").split(".", 1)[0] in _FIRST_PARTY_PREFIXES


def _raised_in_first_party(exc: BaseException) -> bool:
    """True when the frame that raised ``exc`` belongs to a first-party module.

    ``HTTPException`` is Starlette's type, so its defining module says nothing
    about who raised it; the innermost traceback frame does.
    """
    tb: TracebackType | None = exc.__traceback__
    if tb is None:
        return False
    while tb.tb_next is not None:
        tb = tb.tb_next
    return _is_first_party(tb.tb_frame.f_globals.get("__name__"))


def model_facing_message(exc: BaseException | None) -> str | None:
    """Return the text the model may see for ``exc``, or None to stay sanitized."""
    if exc is None:
        return None
    if isinstance(exc, HTTPException):
        if not _raised_in_first_party(exc):
            return None
        # The daily quota (429) and paywall refusals are HTTP-shaped. Billing
        # raises them with a dict detail ({"code", "message", ...}); hand the
        # model the human-readable message, not the dict's Python repr.
        detail = exc.detail
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            return detail["message"]
        return str(detail)
    if _is_first_party(type(exc).__module__):
        return str(exc)
    return None
