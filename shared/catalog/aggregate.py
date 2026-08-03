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
entries directly (no build coupling), so `dist/catalog.json` is gitignored - a
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
import re
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
# Mirror of schema.json `properties` (additionalProperties:false) + the id regex.
ALLOWED_KEYS = frozenset(REQUIRED) | {"edison_hosted", "headers", "template_fields"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _url_is_bad(url: str) -> bool:
    """True unless url is https://<non-empty-host>/<...>/mcp with a real host."""
    if not url.startswith("https://") or not url.endswith("/mcp"):
        return True
    host = url[len("https://") :].split("/", 1)[0]
    return not host  # reject 'https:///mcp' (empty host)


def _tags_bad(tags: Any) -> bool:
    """schema: non-empty array of non-empty strings."""
    if not isinstance(tags, list) or not tags:
        return True
    return any(not isinstance(t, str) or not t for t in tags)


def _headers_bad(entry: dict[str, Any]) -> bool:
    """schema: when present, an object mapping string -> string."""
    if "headers" not in entry:
        return False
    headers = entry["headers"]
    if not isinstance(headers, dict):
        return True
    return any(not isinstance(v, str) for v in headers.values())


def _template_fields_bad(entry: dict[str, Any]) -> bool:
    """schema: when present, an object whose optional `env` maps names to
    objects carrying a required string `description` (+ optional `example`)."""
    if "template_fields" not in entry:
        return False
    tf = entry["template_fields"]
    if not isinstance(tf, dict):
        return True
    env = tf.get("env", {})
    if not isinstance(env, dict):
        return True
    for field in env.values():
        if not isinstance(field, dict):
            return True
        if not isinstance(field.get("description"), str) or not field["description"]:
            return True
        if "example" in field and not isinstance(field["example"], str):
            return True
    return False


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
            not isinstance(entry["id"], str) or not ID_RE.match(str(entry["id"])),
            f"id '{entry['id']}' must match {ID_RE.pattern}",
        ),
        (
            _tags_bad(entry["tags"]),
            "'tags' must be a non-empty list of non-empty strings",
        ),
        (_headers_bad(entry), "'headers' must be an object of string values"),
        (
            _template_fields_bad(entry),
            "'template_fields.env' entries need a non-empty string 'description' (+ optional string 'example')",
        ),
        (
            entry["auth"] not in AUTH_MODES,
            f"auth '{entry['auth']}' not in {AUTH_MODES}",
        ),
        (
            _url_is_bad(str(entry["url"])),
            f"url must be https://<host>/…/mcp, got '{entry['url']}'",
        ),
        (not icon.endswith(".svg"), f"icon '{icon}' must be an .svg"),
        (
            icon != Path(icon).name,
            f"icon '{icon}' must be a bare filename (no path separators)",
        ),
        (
            icon != f"{server_dir.name}.svg",
            f"icon '{icon}' must be '{server_dir.name}.svg' (id + .svg)",
        ),
        (
            icon == Path(icon).name and not (server_dir / icon).is_file(),
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
    # additionalProperties:false - reject keys the schema doesn't define.
    unknown = [
        f"{where}: unknown field '{k}' (schema is additionalProperties:false)"
        for k in entry
        if k not in ALLOWED_KEYS
    ]
    return unknown + [f"{where}: {msg}" for bad, msg in _field_problems(entry, server_dir) if bad]


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
        if not isinstance(entry, dict):
            # A top-level array/string/number would crash every `entry[...]`
            # access below; reject it as a whole-entry error and skip it.
            errors.append(
                f"{entry_path.parent.name}/catalog-entry.json: "
                f"top-level value must be a JSON object, got {type(entry).__name__}"
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
