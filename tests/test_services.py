"""Tests for service layer - pure business logic, no transport."""

import pytest
from pydantic import ValidationError

from models.config import ConfigGetInput, ConfigShowInput
from models.doctor import DoctorFixInput, DoctorInput
from models.greet import GreetInput
from services.config_svc import config_get, config_show
from services.doctor_svc import doctor
from services.greet import greet
from tests.test_template import TestTemplate


class TestGreetService(TestTemplate):
    def test_greet_basic(self):
        result = greet(GreetInput(name="Alice"))
        assert result.message == "Hello, Alice!"

    def test_greet_shout(self):
        result = greet(GreetInput(name="Alice", shout=True))
        assert result.message == "HELLO, ALICE!"

    def test_greet_times(self):
        result = greet(GreetInput(name="Bob", times=3))
        assert result.message == "Hello, Bob!"
        assert result.times == 3


class TestConfigService(TestTemplate):
    def test_config_show(self):
        result = config_show(ConfigShowInput())
        assert isinstance(result.config, dict)
        assert len(result.config) > 0

    def test_config_get(self):
        result = config_get(ConfigGetInput(key="llm_config.cache_enabled"))
        assert result.key == "llm_config.cache_enabled"
        # Only the type: the value depends on local YAML overlays
        # (e.g. a gitignored .global_config.yaml written by config_set).
        assert isinstance(result.value, bool)

    def test_config_get_nonexistent(self):
        with pytest.raises(KeyError):
            config_get(ConfigGetInput(key="nonexistent.key"))

    def test_config_get_rejects_env_secrets(self):
        # A secret key is unreachable through config_get - it raises KeyError
        # rather than returning the value.
        for secret_field in (
            "OPENAI_API_KEY",
            "BACKEND_DB_URI",
            "GOOGLE_TOKEN_ENC_KEY",
        ):
            with pytest.raises(KeyError):
                config_get(ConfigGetInput(key=secret_field))


class TestDoctorService(TestTemplate):
    def test_doctor_runs(self):
        result = doctor(DoctorInput())
        assert len(result.checks) > 0
        assert isinstance(result.has_failures, bool)

    def test_doctor_check_names(self):
        result = doctor(DoctorInput())
        names = [c.name for c in result.checks]
        assert "Python version" in names
        assert "uv installed" in names

    def test_iter_doctor_is_read_only(self):
        # The SSE stream's generator yields one pass and never runs fixers.
        from unittest.mock import patch  # noqa: PLC0415

        from services import doctor_svc  # noqa: PLC0415

        with patch.object(doctor_svc, "_apply_fixers") as fixers:
            results = list(doctor_svc.iter_doctor(DoctorInput()))
        fixers.assert_not_called()
        assert len(results) == len(doctor_svc._ALL_CHECKS)

    def test_doctor_inputs_reject_unknown_fields(self):
        # {"fix": false} must not be silently dropped while doctor_fix's
        # mutating fixers run, nor turn checks-only doctor into a fix.
        with pytest.raises(ValidationError):
            DoctorFixInput.model_validate({"fix": False})
        with pytest.raises(ValidationError):
            DoctorInput.model_validate({"fix": True})
