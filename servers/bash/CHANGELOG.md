# Changelog

All notable changes to `@sealgate/bash-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Changed

- Moved from `@modelcontextprotocol/sdk` 1.x to MCP TS SDK 2.x
  (`@modelcontextprotocol/server`). The server now speaks the 2026-07-28
  protocol and still serves 2025-era clients that send `initialize`.
- Progress notifications go through the 2.x request context; the progress
  token is read from the request's `_meta`.
- The `run` input schema now declares `additionalProperties: false`.
- Requires Node 20 or newer (`engines.node`).

## [0.1.0]

### Added

- Initial release: a stdio MCP server exposing full bash execution as a single
  `run` tool (`command`, `cwd`, `stdin`, `timeout_ms`), returning exit code plus
  bounded stdout/stderr.
- Progress heartbeats and per-output-line `notifications/progress` so long
  commands do not look hung.
- Optional `BASH_MCP_ALLOW` coarse allowlist, configurable shell
  (`BASH_MCP_SHELL`), timeout (`BASH_MCP_TIMEOUT_MS`), and default working
  directory (`--cwd` / `BASH_MCP_CWD`).
