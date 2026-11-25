# Changelog

## 0.2.0

- Moved from `@modelcontextprotocol/sdk` 1.x to MCP TS SDK 2.x
  (`@modelcontextprotocol/server`). The server now speaks the 2026-07-28
  protocol and still serves 2025-era clients that send `initialize`.
- Every tool's input schema now declares `additionalProperties: false`.
- Requires Node 20 or newer (`engines.node`).

## 0.1.0

Initial release.

- Stdio MCP server exposing `adb` for a locally-connected Android device or
  emulator, with five tools: `get_packages`, `execute_adb_command`,
  `get_uilayout`, `get_screenshot`, and `get_package_action_intents`.
- Automatic single-device detection; multi-device selection via `--serial` or
  `ANDROID_ADB_SERIAL`.
- Faithful TypeScript re-implementation of
  [minhalvp/android-mcp-server](https://github.com/minhalvp/android-mcp-server)
  (MIT), packaged for one-command `npx` distribution through the SealGate
  marketplace.
