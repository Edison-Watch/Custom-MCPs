"""Config service - pure business logic."""

from pathlib import Path
from typing import Any

import yaml

from common import global_config
from models.config import (
    ConfigGetInput,
    ConfigGetResult,
    ConfigSetInput,
    ConfigSetResult,
    ConfigShowInput,
    ConfigShowResult,
)
from services import InvalidArgument, service

_ROOT_DIR = Path(__file__).parent.parent


def _coerce_value(value: str) -> bool | int | float | str | None:
    """Attempt to coerce a string value to bool/int/float."""
    if value.lower() in ("true", "yes"):
        return True
    if value.lower() in ("false", "no"):
        return False
    if value.lower() == "null":
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


@service(
    name="config_show",
    description=(
        "Show the project's effective configuration (YAML, defaults and env "
        "overrides; secrets excluded)"
    ),
    input_model=ConfigShowInput,
    output_model=ConfigShowResult,
)
def config_show(input: ConfigShowInput) -> ConfigShowResult:
    # Effective config minus secrets (see Config.to_public_dict): env fields
    # appear only if allowlisted in common.public_config.PUBLIC_ENV_FIELDS.
    # Same view on every transport, including the authenticated HTTP one.
    return ConfigShowResult(config=global_config.to_public_dict())


@service(
    name="config_get",
    description=(
        "Get an effective config value by dot-separated key (secrets excluded)"
    ),
    input_model=ConfigGetInput,
    output_model=ConfigGetResult,
)
def config_get(input: ConfigGetInput) -> ConfigGetResult:
    # Walk the public view so secrets are unreachable: config_get(
    # "OPENAI_API_KEY") / config_get("BACKEND_DB_URI") raise InvalidArgument,
    # exactly like a key that does not exist (so REST answers 400, not 500).
    obj: Any = global_config.to_public_dict()
    for part in input.key.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            raise InvalidArgument(f"Key not found: {input.key}")
    return ConfigGetResult(key=input.key, value=obj)


@service(
    name="config_set",
    description="Set a configuration override",
    input_model=ConfigSetInput,
    output_model=ConfigSetResult,
    mutating=True,
    # Rewrites the host's .global_config.yaml for every user: CLI only.
    operator_only=True,
)
def config_set(input: ConfigSetInput) -> ConfigSetResult:
    override_path = _ROOT_DIR / ".global_config.yaml"

    existing: dict = {}
    if override_path.exists():
        with open(override_path) as f:
            existing = yaml.safe_load(f) or {}

    parts = input.key.split(".")
    current = existing
    for part in parts[:-1]:
        if part not in current or not isinstance(current[part], dict):
            current[part] = {}
        current = current[part]

    coerced = _coerce_value(input.value)
    current[parts[-1]] = coerced

    with open(override_path, "w") as f:
        yaml.safe_dump(existing, f, default_flow_style=False)

    return ConfigSetResult(key=input.key, coerced_value=coerced)
