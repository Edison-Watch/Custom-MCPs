# @sealgate/bash-mcp

A thin **stdio MCP server** that exposes full bash command execution as a single
`run` tool. The SealGate daemon spawns it on the user's machine and talks to it
over stdio; because it runs arbitrary shell, **every call is mediated by the
SealGate data firewall** (the `run` tool is classified `SECRET`).

It is the raw-shell sibling of [`servers/adb`](../adb): where adb wraps the
Android Debug Bridge, this wraps `/bin/bash -c <command>`.

## Usage

```bash
# Expose bash over stdio MCP:
npx -y @sealgate/bash-mcp

# Pin a default working directory at launch:
npx -y @sealgate/bash-mcp --cwd /path/to/project
```

The server speaks MCP over stdio and exposes one tool:

### `run`

Run a single bash command and return its result.

| Field        | Type   | Required | Description                                                      |
| ------------ | ------ | -------- | ---------------------------------------------------------------- |
| `command`    | string | yes      | The bash command line, e.g. `ls -la \| head`. Full shell syntax. |
| `cwd`        | string | no       | Absolute path to the working directory. Blank counts as omitted. |
| `stdin`      | string | no       | Data piped to the command on stdin, followed by EOF.             |
| `timeout_ms` | number | no       | Per-call timeout in milliseconds. Overrides the server default.  |

The result is a single text block reporting the exit code (or the signal that
killed it), then the non-empty `stdout` and `stderr` sections. `isError` is set
on a non-zero exit, a timeout, a killing signal, or a shell launch failure.
Output is bounded per stream (5 MiB, truncated with a marker). While a command
runs the server emits MCP `notifications/progress` (per output line + a periodic
heartbeat) when the caller supplies a `progressToken`.

## Environment

| Variable                | Default     | Description                                                            |
| ----------------------- | ----------- | --------------------------------------------------------------------- |
| `BASH_MCP_TIMEOUT_MS`   | `120000`    | Per-run subprocess timeout in ms (a per-call `timeout_ms` wins).       |
| `BASH_MCP_HEARTBEAT_MS` | `10000`     | Interval between progress heartbeats while a command is live.          |
| `BASH_MCP_SHELL`        | `/bin/bash` | Shell used to interpret the command string.                            |
| `BASH_MCP_CWD`          | (unset)     | Server-wide default working directory; `--cwd` or a per-call arg wins. |
| `BASH_MCP_ALLOW`        | (unset)     | Optional comma-separated allowlist of program names (see below).       |

## Security notes

- This server runs **arbitrary shell commands**. It is meant to run behind the
  SealGate firewall, which classifies `run` `SECRET` and mediates every call.
- `run` acts on the user's own machine, so per the catalog contract it is
  `write_operation: false` (not the trifecta's external-write leg) and gated by
  `acl: SECRET`, matching `servers/adb`'s `execute_adb_command`.
- `BASH_MCP_ALLOW` is a coarse defence-in-depth knob: when set, the first bare
  word of the command (by basename) must be in the list. It does **not** parse
  the full command line (it will not catch `sh -c "..."` or a `$(...)`
  substitution) and is not a substitute for the firewall. Unset means "allow
  anything", the default for full-bash exposure.
- Output is bounded per stream (5 MiB) and truncated with a marker, so a runaway
  command cannot exhaust memory.

## Development

```bash
bun install
bun run build       # tsc -> dist/
bun run typecheck
bun run test        # vitest
```
