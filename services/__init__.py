"""Service registry - pure business logic with no transport awareness."""

import importlib
import pkgutil
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class ServiceEntry:
    name: str
    description: str
    input_model: type
    output_model: type
    func: Callable[..., Any]
    mutating: bool = False


class ModelFacingError(Exception):
    """Text written for the model to read and act on; never wraps third-party text.

    The single opt-in that lets the MCP layer show an exception's message to the
    model (``mcp_server/_tool_errors.py``); every other exception reaches the
    client sanitized. Subclass it only when the message is first-party prose -
    recovery guidance, a refusal reason, a correctable argument problem - and
    never interpolate an upstream exception's text or a response body into it:
    log those instead.
    """


class InvalidArgument(ModelFacingError, ValueError):  # noqa: N818 - reads as a verdict, like ValueError
    """A service rejected the caller's arguments; the text is for the caller.

    Subclasses ``ValueError`` so CLI handling is unchanged; REST maps it to 400.
    Unlike a bare ``ValueError``, which any third-party library may raise with
    internals in its text (a full URL, a payload ``input_value=``), it is a
    ``ModelFacingError``, so the MCP layer shows its message to the model.
    Raise this, not ``ValueError``, for a model-correctable argument problem.
    """


class ConnectRequiredError(ModelFacingError):
    """A service call requires the user to first complete an external connect flow.

    Transport-agnostic contract: each integration that links a third-party
    account (Gmail today; any future OAuth-backed service) raises its own
    subclass so transports can offer a recovery affordance without importing
    the feature - the MCP layer converts this into a SEP-1036 URL elicitation
    carrying ``build_auth_url()``. Two obligations on subclasses:

    - ``message`` must itself be a self-recovering script (what tool to call,
      what to do with the URL, then retry), because for hosts with no native
      affordance the exception text is the only channel that reaches them.
    - ``build_auth_url()`` returns the URL where the user completes the flow,
      or None when the flow is unconfigured in this deployment.
    """

    def __init__(self, user_id: str, message: str, *, elicitation_message: str) -> None:
        self.user_id = user_id
        self.elicitation_message = elicitation_message
        super().__init__(message)

    def build_auth_url(self) -> str | None:
        """Return the connect-flow URL for this user, or None if unconfigured."""
        raise NotImplementedError


_registry: list[ServiceEntry] = []
_discovered: bool = False


def service(
    *,
    name: str,
    description: str,
    input_model: type,
    output_model: type,
    mutating: bool = False,
):
    """Decorator that registers a function as a service.

    Set ``mutating=True`` for services with side effects (create/charge/send)
    so the HTTP transport enforces ``Idempotency-Key`` and replays the stored
    response on retries. Leave it ``False`` (the default) for pure/read-only
    services. On MCP, the flag also gates the enhancer crash-fallback
    (``mcp_server/_tool_factory.py``): a mutating service is never silently
    re-executed - the fallback reuses the already-completed ``tool.call()``
    result or propagates the enhancer error. CLI behavior is unchanged.
    """

    def decorator(func):
        _registry.append(
            ServiceEntry(
                name=name,
                description=description,
                input_model=input_model,
                output_model=output_model,
                func=func,
                mutating=mutating,
            )
        )
        return func

    return decorator


def discover_services() -> None:
    """Import every ``services.*`` submodule so @service decorators run.

    Idempotent: safe to call from multiple transports during startup.
    """
    global _discovered
    if _discovered:
        return
    for module_info in pkgutil.iter_modules(__path__):
        importlib.import_module(f"services.{module_info.name}")  # noqa: TID251 - service auto-discovery so @service decorators register on startup
    _discovered = True


def get_registry() -> list[ServiceEntry]:
    """Return all registered services."""
    return list(_registry)
