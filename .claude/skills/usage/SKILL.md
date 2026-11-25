---
name: usage
description: How to use the CLI, API, and MCP interfaces. Use this skill when interacting with the tool as an end user.
---
# Usage Guide

This skill teaches you how to use the three interfaces provided by this project.

## CLI

```bash
# Install
pip install custom-mcps

# Basic usage
edisonmcps --help                  # see all commands
edisonmcps greet Alice             # run a command
edisonmcps config show             # view configuration
edisonmcps doctor                  # check system health

# Global flags (go before the subcommand)
edisonmcps --verbose greet Alice   # detailed output
edisonmcps --format json config show  # JSON output
edisonmcps --dry-run greet Bob     # preview without executing
edisonmcps --version               # print version
```

## Server (HTTP API + MCP)

```bash
# Start the server: HTTP API and MCP (streamable HTTP) on one port.
edisonmcps-serve

# Default http://localhost:8080. See /docs for OpenAPI, /mcp for MCP.
```

## MCP

The MCP server exposes the same services as CLI tools via the Model Context Protocol.

**Primary transport: streamable HTTP at `/mcp`** (started by `edisonmcps-serve`).
Stdio is supported via `edisonmcps-mcp` for local Claude Desktop / dev only.

```bash
# Legacy stdio transport
edisonmcps-mcp

# Debug with the MCP inspector (stdio)
mcp dev mcp_server/server.py
```

### Connecting MCP to your editor

Remote (preferred - works on Claude Desktop 0.7+, Cursor, etc.):

```json
{
  "mcpServers": {
    "edisonmcps": {
      "url": "https://YOUR-DEPLOYMENT/mcp",
      "headers": { "X-API-KEY": "sk_..." }
    }
  }
}
```

Local stdio (legacy):

```json
{
  "mcpServers": {
    "edisonmcps": {
      "command": "edisonmcps-mcp"
    }
  }
}
```

## Updating

```bash
edisonmcps update    # check for updates and upgrade
```
