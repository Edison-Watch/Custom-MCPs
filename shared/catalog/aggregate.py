# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Validate and aggregate the fleet's Edison-marketplace catalog entries.

Each server declares one `servers/<id>/catalog-entry.json` (the connector spec
Edison lists). This script is the fleet-side half of the catalog contract in
`shared/catalog/README.md`:

1. discovers every `servers/*/catalog-entry.json`,
2. validates each against the constraints in `shared/catalog/schema.json`
   (enforced here in stdlib Python so CI needs no extra dependency), and
3. emits the combined `shared/catalog/dist/catalog.json` build artifact.

edison-watch's `scripts/sync_fleet_connectors.py` reads the per-server source
entries directly (no build coupling), so `dist/catalog.json` is gitignored — a
local/consumer convenience, not the sync input. This script's job in CI is
therefore **validation**, not artifact freshness.

Validation and the JSON Schema are two views of one contract; when you change
one, change the other. edison-watch turns each entry into a marketplace row via
`scripts/generate_marketplace_entries.py` (`index_entry` / `server_file`).

Usage:  uv run shared/catalog/aggregate.py [--check]
        --check validates every entry and exits non-zero if any is invalid
        (CI-friendly, no writes); default also (re)builds the dist artifact.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVERS_DIR = REPO_ROOT / "servers"
DIST_FILE = Path(__file__).resolve().parent / "dist" / "catalog.json"

REQUIRED = (
    "id",
    "displayName",
    "description",
    "author",
    "category",
    "tags",
    "url",
    "auth",
    "icon",
)
AUTH_MODES = ("none", "token", "oauth", "edison-jwt")


def _field_problems(entry: dict[str, Any], server_dir: Path) -> list[tuple[bool, str]]:
    """(is_bad, message) pairs for one entry, assuming required keys are present."""
    icon = str(entry["icon"])
    hosted = entry.get("edison_hosted")
    return [
        (
            entry["id"] != server_dir.name,
            f"id '{entry['id']}' must equal dir '{server_dir.name}'",
        ),
        (
            not isinstance(entry["tags"], list) or not entry["tags"],
            "'tags' must be a non-empty list",
        ),
        (
            entry["auth"] not in AUTH_MODES,
            f"auth '{entry['auth']}' not in {AUTH_MODES}",
        ),
        (
            not str(entry["url"]).startswith("https://")
            or not str(entry["url"]).endswith("/mcp"),
            f"url must be https://…/mcp, got '{entry['url']}'",
        ),
        (not icon.endswith(".svg"), f"icon '{icon}' must be an .svg"),
        (
            icon.endswith(".svg") and not (server_dir / icon).is_file(),
            f"icon file '{icon}' not found",
        ),
        (
            entry["auth"] == "token" and "headers" not in entry,
            "auth 'token' requires 'headers'",
        ),
        (
            entry["auth"] == "token" and "template_fields" not in entry,
            "auth 'token' requires 'template_fields'",
        ),
        (
            entry["auth"] == "edison-jwt" and not entry.get("edison_hosted"),
            "auth 'edison-jwt' requires 'edison_hosted': true",
        ),
        (
            hosted is not None and not isinstance(hosted, bool),
            "'edison_hosted' must be a boolean",
        ),
    ]


def _validate(entry: dict[str, Any], server_dir: Path) -> list[str]:
    """Return a list of human-readable problems with one entry (empty = valid)."""
    where = f"{server_dir.name}/catalog-entry.json"
    missing = [
        f"{where}: missing required field '{k}'" for k in REQUIRED if k not in entry
    ]
    if missing:
        return missing  # further checks assume the required keys exist
    return [f"{where}: {msg}" for bad, msg in _field_problems(entry, server_dir) if bad]


def collect() -> tuple[list[dict[str, Any]], list[str]]:
    """Load, validate, and id-sort every server's catalog entry."""
    entries: list[dict[str, Any]] = []
    errors: list[str] = []
    for entry_path in sorted(SERVERS_DIR.glob("*/catalog-entry.json")):
        try:
            entry = json.loads(entry_path.read_text())
        except json.JSONDecodeError as exc:
            errors.append(
                f"{entry_path.parent.name}/catalog-entry.json: invalid JSON ({exc})"
            )
            continue
        errors.extend(_validate(entry, entry_path.parent))
        entries.append(entry)
    entries.sort(key=lambda e: e.get("id", ""))
    return entries, errors


def dump(entries: list[dict[str, Any]]) -> str:
    # No timestamp: the artifact must be deterministic so --check is stable.
    return json.dumps({"entries": entries}, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="validate entries; no writes"
    )
    args = parser.parse_args()

    entries, errors = collect()
    if errors:
        print("Catalog entries are invalid:", file=sys.stderr)
        print("\n".join(f"  {e}" for e in errors), file=sys.stderr)
        return 1

    noun = "entry" if len(entries) == 1 else "entries"
    if args.check:
        print(f"catalog: {len(entries)} {noun} valid")
        return 0

    DIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    DIST_FILE.write_text(dump(entries))
    print(f"wrote {DIST_FILE} ({len(entries)} {noun})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
