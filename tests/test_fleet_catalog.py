"""Validation tests for the fleet catalog contract (shared/catalog/aggregate.py).

The aggregator is a dependency-free stdlib script (PEP 723), so these load it by
path and exercise the pure validators directly - no config, no MCP session.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
_AGG_PATH = _REPO_ROOT / "shared" / "catalog" / "aggregate.py"


def _load_aggregate() -> Any:
    # aggregate.py is a PEP 723 standalone script (dependency-free, not on the
    # package path), so path-loading is the only way to exercise its pure
    # validators in-process; _AGG_PATH is a fixed first-party repo file, not an
    # arbitrary/user path.
    spec = importlib.util.spec_from_file_location(  # noqa: TID251
        "fleet_catalog_aggregate", _AGG_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AGG = _load_aggregate()

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


def test_repository_entries_all_valid():
    """Every real servers/*/catalog-entry.json must pass the aggregator."""
    _entries, errors = _AGG.collect()
    assert errors == [], "\n".join(errors)
