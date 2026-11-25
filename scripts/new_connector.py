# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Scaffold a new fleet MCP connector under `servers/<id>/`.

A fleet connector is one MCP server advertised to the Edison marketplace. Its
source of truth is `servers/<id>/catalog-entry.json` (+ a co-located `<id>.svg`
icon); edison-watch's sync mirrors it downstream. See `shared/catalog/README.md`
for the full contract. Two transports:

- **http** (default): a remote streamable-HTTP server Edison hosts. Scaffolds an
  edison_hosted + edison-jwt skeleton. Walk through it with `add-fleet-connector`.
- **stdio** (`--stdio`): a local process the SealGate daemon spawns on the user's
  machine (e.g. an `npx` package wrapping a local CLI). Scaffolds a
  command/args skeleton. Walk through it with `add-stdio-connector`.

This writes a schema-valid *skeleton* on purpose left **one step short**: the
scaffold ships no `tools_configurations`, so `make catalog_check` fails until
you classify the server's tools. That is the intended fail-closed state - a
marketplace install skips autoconfig, so an unclassified tool mounts at the
protective SECRET + full-trifecta default and blocks.

Usage:  uv run scripts/new_connector.py <id> [--stdio]
        make new-connector id=<id>
        make new-stdio-connector id=<id>
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


def _scaffold_stdio_entry(connector_id: str) -> dict[str, object]:
    """A schema-valid stdio skeleton minus `tools_configurations` (fail-closed).

    stdio servers run on the user's machine (the SealGate daemon spawns them), so
    they are never edison_hosted and carry `command` + `args` instead of a `url`.
    The default shape launches a published npm package via npx; change `command`
    /`args` for a different runtime (e.g. `uvx <pkg>`).
    """
    return {
        "id": connector_id,
        "displayName": "TODO Display Name",
        "description": "TODO one-line description of what this connector does.",
        "author": "SealGate",
        "category": "TODO",
        "tags": ["TODO"],
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", f"@sealgate/{connector_id}-mcp"],
        "auth": "none",
        "icon": f"{connector_id}.svg",
    }


def create(connector_id: str, *, stdio: bool = False) -> Path:
    """Create `servers/<id>/` with a skeleton entry + placeholder icon."""
    if not ID_RE.fullmatch(connector_id):
        raise SystemExit(
            f"invalid id '{connector_id}': must match {ID_RE.pattern} "
            "(lowercase letters, digits, hyphens; must equal the dir name)"
        )
    server_dir = SERVERS_DIR / connector_id
    if server_dir.exists():
        raise SystemExit(f"'{server_dir.relative_to(REPO_ROOT)}' already exists")

    entry = (
        _scaffold_stdio_entry(connector_id) if stdio else _scaffold_entry(connector_id)
    )
    server_dir.mkdir(parents=True)
    entry_path = server_dir / "catalog-entry.json"
    entry_path.write_text(json.dumps(entry, indent=2, ensure_ascii=False) + "\n")
    (server_dir / f"{connector_id}.svg").write_text(_PLACEHOLDER_SVG)
    return server_dir


def main(argv: list[str]) -> int:
    stdio = "--stdio" in argv
    positional = [a for a in argv if a != "--stdio"]
    if len(positional) != 1 or not positional[0]:
        print(
            "usage: new_connector.py <id> [--stdio]   "
            "(or: make new-connector id=<id> / make new-stdio-connector id=<id>)",
            file=sys.stderr,
        )
        return 2
    connector_id = positional[0]
    server_dir = create(connector_id, stdio=stdio)
    rel = server_dir.relative_to(REPO_ROOT)
    skill = "add-stdio-connector" if stdio else "add-fleet-connector"
    print(f"Scaffolded {rel}/ ({'stdio' if stdio else 'http'})")
    print(f"  - {rel}/catalog-entry.json   (fill in the TODOs)")
    print(f"  - {rel}/{connector_id}.svg   (replace the placeholder icon)")
    print()
    print("Next: classify each tool the server exposes, then `make catalog_check`.")
    print("  `catalog_check` will FAIL until you add a non-empty tools_configurations")
    print("  (marketplace installs skip autoconfig - an unclassified tool blocks).")
    print(f"  The `{skill}` skill walks through the whole flow.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
