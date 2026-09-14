# @sealgate/android-adb-mcp

A thin stdio [MCP](https://modelcontextprotocol.io) server that exposes the
Android Debug Bridge (`adb`) for a locally-connected device or emulator. It is a
faithful TypeScript re-implementation of
[minhalvp/android-mcp-server](https://github.com/minhalvp/android-mcp-server)
(MIT), packaged and pinned for distribution through the SealGate marketplace so
it runs with a single `npx` command and no clone.

SealGate itself does the security work (per-tool Access Control Levels, policy
enforcement, taint analysis). This server is deliberately a plain, full-access
adb passthrough, the gateway in front is what governs it.

## Tools

| Tool                         | Arguments      | Description                                                                                                                |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `get_packages`               | –              | List all installed packages on the device.                                                                                 |
| `execute_adb_command`        | `command`      | Run an arbitrary adb command (everything after `adb`) and return its output.                                               |
| `get_uilayout`               | –              | Dump the current screen and return clickable/labelled elements with text, description, bounds, and centre tap coordinates. |
| `get_screenshot`             | –              | Capture a PNG screenshot of the device screen.                                                                             |
| `get_package_action_intents` | `package_name` | List the non-data intent actions a package advertises in its Activity Resolver Table.                                      |

## Prerequisites

- **Android Platform Tools** (`adb`) on `PATH`. Set `ADB_PATH` to point at a
  non-standard `adb` binary.
- A connected device or a running emulator (`adb devices` shows it as `device`).

## Usage

```jsonc
{
  "mcpServers": {
    "adb": {
      "command": "npx",
      "args": ["-y", "@sealgate/android-adb-mcp"]
    }
  }
}
```

### Selecting a device

With one device connected it is auto-detected. On a multi-device host, pick one
with a launch flag or an env var:

```bash
npx -y @sealgate/android-adb-mcp --serial emulator-5554
# or
ANDROID_ADB_SERIAL=emulator-5554 npx -y @sealgate/android-adb-mcp
```

If multiple devices are connected and none is chosen, every tool returns an
error listing the connected serials rather than guessing.

## Security note

`execute_adb_command` is effectively arbitrary `adb shell`: it can read app
data, dump databases, and move files off the device. Behind SealGate it should
be classified `SECRET` and gated. The catalog entry ships that classification;
see `tools_configurations` in the marketplace `servers/adb.json`.

## Development

```bash
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm run test       # vitest (pure-parser unit tests, no device needed)
```

## Credit

Tool surface and behaviour are based on
[minhalvp/android-mcp-server](https://github.com/minhalvp/android-mcp-server)
by Minhal Vohra, MIT-licensed.

## License

MIT
