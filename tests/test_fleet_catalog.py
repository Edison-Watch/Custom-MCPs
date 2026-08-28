"""Validation tests for the fleet catalog contract (shared/catalog/aggregate.py).

The aggregator is a dependency-free stdlib script (PEP 723), so these load it by
path and exercise the pure validators directly - no config, no MCP session.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import jsonschema

_REPO_ROOT = Path(__file__).resolve().parent.parent
_CATALOG_DIR = _REPO_ROOT / "shared" / "catalog"
_AGG_PATH = _CATALOG_DIR / "aggregate.py"
_SCHEMA_PATH = _CATALOG_DIR / "schema.json"
_SERVERS_DIR = _REPO_ROOT / "servers"
_NEW_CONNECTOR_PATH = _REPO_ROOT / "scripts" / "new_connector.py"


def _load_by_path(name: str, path: Path) -> Any:
    # These are PEP 723 standalone scripts (dependency-free, not on the package
    # path), so path-loading is the only way to exercise their pure helpers
    # in-process; the paths are fixed first-party repo files, not user paths.
    spec = importlib.util.spec_from_file_location(name, path)  # noqa: TID251
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AGG = _load_by_path("fleet_catalog_aggregate", _AGG_PATH)
_NEW_CONNECTOR = _load_by_path("fleet_new_connector", _NEW_CONNECTOR_PATH)

_BASE_ENTRY: dict[str, Any] = {
    "id": "sample",
    "displayName": "Sample",
    "description": "d",
    "author": "a",
    "category": "c",
    "tags": ["t"],
    "url": "https://sample.example/mcp",
    "auth": "none",
    "icon": "sample.svg",
}

_VALID_TOOL_CFG = {
    "write_operation": False,
    "read_private_data": False,
    "read_untrusted_public_data": True,
    "acl": "PUBLIC",
}


def _bad(tools_configurations: Any) -> bool:
    entry = dict(_BASE_ENTRY, tools_configurations=tools_configurations)
    return _AGG._tools_configurations_bad(entry)


def test_absent_tools_configurations_is_ok():
    assert _AGG._tools_configurations_bad(dict(_BASE_ENTRY)) is False


def test_valid_tools_configurations_passes():
    assert _bad({"reddit_scrape": dict(_VALID_TOOL_CFG)}) is False


def test_missing_flag_rejected():
    assert _bad({"t": {"write_operation": False, "acl": "PUBLIC"}}) is True


def test_unknown_acl_rejected():
    assert _bad({"t": dict(_VALID_TOOL_CFG, acl="NOPE")}) is True


def test_extra_key_rejected():
    assert _bad({"t": dict(_VALID_TOOL_CFG, surprise=1)}) is True


def test_non_boolean_flag_rejected():
    assert _bad({"t": dict(_VALID_TOOL_CFG, write_operation="no")}) is True


def test_non_object_config_rejected():
    assert _bad({"t": "not-an-object"}) is True
    assert _bad(["not-a-dict"]) is True


def test_edison_hosted_without_tools_configurations_rejected():
    entry = dict(_BASE_ENTRY, edison_hosted=True)
    assert _AGG._edison_hosted_unclassified(entry) is True


def test_edison_hosted_with_empty_tools_configurations_rejected():
    entry = dict(_BASE_ENTRY, edison_hosted=True, tools_configurations={})
    assert _AGG._edison_hosted_unclassified(entry) is True


def test_edison_hosted_with_classification_ok():
    entry = dict(
        _BASE_ENTRY,
        edison_hosted=True,
        tools_configurations={"t": dict(_VALID_TOOL_CFG)},
    )
    assert _AGG._edison_hosted_unclassified(entry) is False


def test_non_hosted_without_tools_configurations_ok():
    # OSS/self-host connectors don't install via the marketplace JWT path, so
    # the mandatory-classification gate only applies to edison_hosted entries.
    assert _AGG._edison_hosted_unclassified(dict(_BASE_ENTRY)) is False
    assert (
        _AGG._edison_hosted_unclassified(dict(_BASE_ENTRY, edison_hosted=False))
        is False
    )


def test_scaffold_fails_closed_on_classification_gate():
    """A freshly-scaffolded entry must trip exactly the classification gate.

    The scaffold ships an edison_hosted skeleton with no tools_configurations on
    purpose, so `make catalog_check` stays red until the author classifies. This
    pins that fail-closed contract: the skeleton is edison_hosted and carries no
    classification.
    """
    entry = _NEW_CONNECTOR._scaffold_entry("sample")
    assert entry["edison_hosted"] is True
    assert "tools_configurations" not in entry
    assert _AGG._edison_hosted_unclassified(entry) is True


def test_repository_entries_all_valid():
    """Every real servers/*/catalog-entry.json must pass the aggregator."""
    _entries, errors = _AGG.collect()
    assert errors == [], "\n".join(errors)


def test_repository_entries_validate_against_json_schema():
    """Every real entry must also pass shared/catalog/schema.json itself.

    aggregate.py re-expresses the schema in stdlib Python; this validates the
    *schema view* of the same contract directly, so an entry that satisfies one
    view but not the other can't slip through.
    """
    schema = json.loads(_SCHEMA_PATH.read_text())
    validator_cls = jsonschema.validators.validator_for(schema)
    validator_cls.check_schema(schema)  # the schema itself must be well-formed
    validator = validator_cls(schema)
    paths = sorted(_SERVERS_DIR.glob("*/catalog-entry.json"))
    assert paths, "no catalog entries found"
    for path in paths:
        entry = json.loads(path.read_text())
        errors = sorted(validator.iter_errors(entry), key=lambda e: list(e.path))
        assert not errors, f"{path.parent.name}: " + "; ".join(
            e.message for e in errors
        )


def test_schema_and_validator_allowed_keys_in_lockstep():
    """The two views of the contract must agree on the set of allowed keys.

    aggregate.py's docstring: the Python validation and the JSON Schema are "two
    views of one contract; when you change one, change the other." A key added
    to schema.json's `properties` but not to aggregate's ALLOWED_KEYS (or vice
    versa) is exactly the drift this guards against.
    """
    schema = json.loads(_SCHEMA_PATH.read_text())
    schema_keys = set(schema["properties"])
    assert schema_keys == set(_AGG.ALLOWED_KEYS)
