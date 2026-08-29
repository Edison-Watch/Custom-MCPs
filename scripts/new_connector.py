# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Scaffold a new fleet MCP connector under `servers/<id>/`.

A fleet connector is one HTTP-wrapper MCP server advertised to the Edison
marketplace. Its source of truth is `servers/<id>/catalog-entry.json` (+ a
co-located `<id>.svg` icon); edison-watch's sync mirrors it downstream. See
`shared/catalog/README.md` for the full contract.

This writes a schema-valid *skeleton* on purpose left **one step short**: the
scaffold ships no `tools_configurations`, so `make catalog_check` fails until
you classify the server's tools. That is the intended fail-closed state - a
marketplace install skips autoconfig, so an unclassified tool mounts at the
protective SECRET + full-trifecta default and blocks. Fill in the classification
by hand or run the `add-fleet-connector` skill.

Usage:  uv run scripts/new_connector.py <id>
        make new-connector id=<id>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVERS_DIR = REPO_ROOT / "servers"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# A neutral placeholder icon: schema requires `<id>.svg` to exist and be a real
# file, so we ship a valid 24x24 SVG the author replaces with the real brand
# mark (simple-icons where available; see .claude/rules/agent-icons.md style).
_PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    '<rect width="24" height="24" rx="4" fill="#8b8b8b"/>'
    '<text x="12" y="16" font-family="sans-serif" font-size="12" '
    'text-anchor="middle" fill="#fff">?</text></svg>\n'
)


def _scaffold_entry(connector_id: str) -> dict[str, object]:
    """A schema-valid skeleton minus `tools_configurations` (fail-closed).

    Defaults to the first-party fleet target (edison_hosted + edison-jwt), which
    both live servers use. Flip to an OSS/self-host shape (edison_hosted:false,
    auth token/oauth/none) if this connector is not Edison-operated.
    """
    return {
        "id": connector_id,
        "displayName": "TODO Display Name",
        "description": "TODO one-line description of what this connector does.",
        "author": "SealGate",
        "edison_hosted": True,
        "category": "TODO",
        "tags": ["TODO"],
        "url": f"https://{connector_id}.sealgate.ai/mcp",
        "auth": "edison-jwt",
        "icon": f"{connector_id}.svg",
    }


def create(connector_id: str) -> Path:
    """Create `servers/<id>/` with a skeleton entry + placeholder icon."""
    if not ID_RE.fullmatch(connector_id):
        raise SystemExit(
            f"invalid id '{connector_id}': must match {ID_RE.pattern} "
            "(lowercase letters, digits, hyphens; must equal the dir name)"
        )
    server_dir = SERVERS_DIR / connector_id
    if server_dir.exists():
        raise SystemExit(f"'{server_dir.relative_to(REPO_ROOT)}' already exists")

    server_dir.mkdir(parents=True)
    entry_path = server_dir / "catalog-entry.json"
    entry_path.write_text(
        json.dumps(_scaffold_entry(connector_id), indent=2, ensure_ascii=False) + "\n"
    )
    (server_dir / f"{connector_id}.svg").write_text(_PLACEHOLDER_SVG)
    return server_dir


def main(argv: list[str]) -> int:
    if len(argv) != 1 or not argv[0]:
        print(
            "usage: new_connector.py <id>   (or: make new-connector id=<id>)",
            file=sys.stderr,
        )
        return 2
    connector_id = argv[0]
    server_dir = create(connector_id)
    rel = server_dir.relative_to(REPO_ROOT)
    print(f"Scaffolded {rel}/")
    print(f"  - {rel}/catalog-entry.json   (fill in the TODOs)")
    print(f"  - {rel}/{connector_id}.svg   (replace the placeholder icon)")
    print()
    print("Next: classify each tool the server exposes, then `make catalog_check`.")
    print("  `catalog_check` will FAIL until you add a non-empty tools_configurations")
    print("  (edison_hosted installs skip autoconfig - an unclassified tool blocks).")
    print("  The `add-fleet-connector` skill walks through classification.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
