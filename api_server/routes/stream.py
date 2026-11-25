"""Server-Sent Events (SSE) streaming routes.

These endpoints deliberately live *outside* the auto-generated
``services.py`` registry. That registry mirrors the "one input model in, one
output model out" service contract identically across CLI/MCP/API - a streamed
response breaks that contract, so streaming variants are hand-written here and
only added for services that genuinely benefit from incremental output.

``POST /api/v1/stream/doctor`` is the first such endpoint: ``doctor`` runs a
sequence of discrete checks, several of which shell out (``uv sync --dry-run``
blocks up to 30s), so streaming each result as it lands turns a ~30s silent
wait into a live, CI-style checklist. The pure ``doctor`` service stays unary
and unchanged; this route consumes the ``iter_doctor`` generator instead.
The stream is read-only: its body is ``DoctorInput`` (``extra="forbid"``), so
``{"fix": true}`` is a 422. Fixers run only via the operator-only
``doctor_fix`` service, which has no HTTP route (``edisonmcps doctor --fix``).
"""

from collections.abc import Iterator

from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from api_server.auth import AuthenticatedUser
from api_server.auth.scopes import SERVICES_EXECUTE, require_scopes
from api_server.billing.limits import ensure_daily_limit
from models.doctor import DoctorInput, DoctorStreamDone
from services.doctor_svc import iter_doctor

router = APIRouter(prefix="/api/v1/stream", tags=["streaming"])


def _doctor_events(body: DoctorInput) -> Iterator[ServerSentEvent]:
    """Yield a ``check`` event per completed check, then a terminal ``done`` event."""
    has_failures = False
    for result in iter_doctor(body):
        has_failures = has_failures or result.status == "fail"
        yield ServerSentEvent(event="check", data=result.model_dump_json())

    yield ServerSentEvent(
        event="done",
        data=DoctorStreamDone(has_failures=has_failures).model_dump_json(),
    )


@router.post("/doctor", summary="Stream project health checks as they complete")
def stream_doctor(
    body: DoctorInput,
    user: AuthenticatedUser = Depends(require_scopes(SERVICES_EXECUTE)),
) -> EventSourceResponse:
    """Run the doctor checks, emitting each result over SSE as it finishes.

    Mirrors the auth + quota gating of ``POST /api/v1/services/doctor``: one
    daily-limit slot is claimed per stream. ``sse-starlette`` iterates the
    sync generator in a threadpool, so the blocking subprocess checks never
    stall the event loop.
    """
    ensure_daily_limit(user.user_id)
    return EventSourceResponse(_doctor_events(body))
