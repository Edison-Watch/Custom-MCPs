"""config_show / config_get expose the effective config, never a secret.

The public view (``Config.to_public_dict``) keeps nested YAML-backed models and
only those UPPERCASE env fields on ``PUBLIC_ENV_FIELDS``. These tests pin the
classification so a new env field cannot ship unclassified.
"""

from unittest.mock import patch

import pytest

from common import global_config
from common.global_config import _SECRET_FIELD_NAMES, PUBLIC_ENV_FIELDS
from models.config import ConfigGetInput, ConfigShowInput
from services import InvalidArgument, config_svc
from services.config_svc import config_get, config_show
from tests.test_template import TestTemplate

_CONFIG_CLS = type(global_config)
_UPPER_FIELDS = {name for name in _CONFIG_CLS.model_fields if name.isupper()}


def _keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


class TestFieldClassification(TestTemplate):
    def test_every_env_field_is_classified_exactly_once(self):
        # Not derived from either list: walks the real model, so a new
        # uppercase field with no decision fails here.
        unclassified = _UPPER_FIELDS - PUBLIC_ENV_FIELDS - _SECRET_FIELD_NAMES
        assert not unclassified, f"classify these env fields: {sorted(unclassified)}"
        both = PUBLIC_ENV_FIELDS & _SECRET_FIELD_NAMES
        assert not both, both

    def test_lists_name_only_real_fields(self):
        assert PUBLIC_ENV_FIELDS <= _UPPER_FIELDS
        assert _SECRET_FIELD_NAMES <= _UPPER_FIELDS

    def test_apify_key_is_secret(self):
        assert "APIFY_API_KEY" in _SECRET_FIELD_NAMES


class TestPublicView(TestTemplate):
    def _with_secrets(self):
        """A Config whose every secret field holds a recognisable value."""
        values = {name: f"sekrit-{name.lower()}" for name in _SECRET_FIELD_NAMES}
        return global_config.model_copy(update=values)

    def test_no_secret_names_or_values(self):
        cfg = self._with_secrets()
        with patch.object(config_svc, "global_config", cfg):
            shown = config_show(ConfigShowInput()).config
        assert not (set(_keys(shown)) & _SECRET_FIELD_NAMES)
        assert "sekrit-" not in repr(shown)

    def test_unlisted_env_field_is_omitted(self):
        # Fail closed: an uppercase field on neither list never shows up.
        cfg = self._with_secrets()
        with (
            patch.object(config_svc, "global_config", cfg),
            patch("common.global_config.PUBLIC_ENV_FIELDS", frozenset()),
        ):
            shown = config_show(ConfigShowInput()).config
        assert not any(k.isupper() for k in shown)
        assert "llm_config" in shown  # nested YAML models survive

    def test_public_env_fields_and_nested_models_present(self):
        shown = config_show(ConfigShowInput()).config
        assert "DEV_ENV" in shown
        assert "FRONTEND_URL" in shown
        assert "llm_config" in shown

    def test_nested_secret_named_key_is_dropped(self):
        dumped = {
            "DEV_ENV": "dev",
            "OPENAI_API_KEY": "leaked",
            "llm_config": {
                "SESSION_SECRET_KEY": "leaked",
                "openai_api_key": "x",
                "k": 1,
            },
        }
        with patch.object(_CONFIG_CLS, "model_dump", return_value=dumped):
            shown = global_config.to_public_dict()
        assert shown == {"DEV_ENV": "dev", "llm_config": {"k": 1}}

    def test_config_get_returns_effective_env_override(self, monkeypatch):
        # The YAML-only view used to answer "dev" here regardless of env.
        monkeypatch.setenv("DEV_ENV", "staging")
        cfg = _CONFIG_CLS()  # ty: ignore[missing-argument]
        assert cfg.DEV_ENV == "staging"
        with patch.object(config_svc, "global_config", cfg):
            assert config_get(ConfigGetInput(key="DEV_ENV")).value == "staging"

    @pytest.mark.parametrize("secret", sorted(_SECRET_FIELD_NAMES))
    def test_config_get_refuses_every_secret(self, secret):
        cfg = self._with_secrets()
        with (
            patch.object(config_svc, "global_config", cfg),
            pytest.raises(InvalidArgument),
        ):
            config_get(ConfigGetInput(key=secret))


class TestUndeclaredExtras(TestTemplate):
    def test_undeclared_env_extra_never_shown(self):
        # extra="allow" + case_sensitive=False turns an undeclared .env key
        # (e.g. LANGFUSE_SECRET_KEY) into a lowercase extra; it must not pass
        # as a nested model.
        cfg = global_config.model_copy(
            update={"langfuse_secret_key": "sk-lf-leak", "made_up_token": "tok-leak"}
        )
        shown = cfg.to_public_dict()
        assert "langfuse_secret_key" not in shown
        assert "made_up_token" not in shown
        assert "leak" not in str(shown)
