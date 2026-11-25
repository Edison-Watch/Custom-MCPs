"""Models for the doctor service."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class DoctorInput(BaseModel):
    """Input for the pure ``doctor`` service (checks only, no side effects).

    ``extra="forbid"`` so legacy REST payloads like ``{"fix": true}`` fail
    loudly with a 422 instead of silently running checks-only: the fixer path
    moved to the separate ``doctor_fix`` service (``mutating=True``). Also the
    body of the read-only ``POST /api/v1/stream/doctor`` SSE route, so that
    route rejects ``{"fix": true}`` the same way.
    """

    model_config = ConfigDict(extra="forbid")


class DoctorFixInput(BaseModel):
    """Input for ``doctor_fix`` - no options: it always attempts fixes.

    ``extra="forbid"`` so a payload like ``{"fix": false}`` is rejected with a
    422 instead of being silently ignored while the mutating fixers run.
    """

    model_config = ConfigDict(extra="forbid")


class CheckResultModel(BaseModel):
    name: str
    status: Literal["pass", "fail", "warn"]
    message: str
    detail: str = ""
    fixable: bool = False


class DoctorResult(BaseModel):
    checks: list[CheckResultModel]
    has_failures: bool


class DoctorStreamDone(BaseModel):
    """Payload of the terminal ``done`` event on the doctor SSE stream."""

    has_failures: bool
