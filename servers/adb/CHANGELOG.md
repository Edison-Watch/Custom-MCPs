# Changelog

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
