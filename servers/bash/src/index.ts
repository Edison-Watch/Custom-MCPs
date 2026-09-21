#!/usr/bin/env node
/**
 * SealGate bash-mcp: a thin stdio MCP server that exposes full bash command
 * execution as a single `run` tool.
 *
 * Usage:
 *   bash-mcp
 *   bash-mcp --cwd /path/to/project
 *
 * Launched on the user's machine by the SealGate daemon over a stdio tunnel,
 * e.g. `npx -y @sealgate/bash-mcp`. Because it runs arbitrary shell commands,
 * it is meant to sit behind the SealGate data firewall, which mediates every
 * call; the `run` tool is classified SECRET in the marketplace catalog.
 *
 * This file is the CLI entry only: it always starts the server (the logic and
 * the exported `buildServer` live in `server.ts`, which tests import). Starting
 * unconditionally is deliberate - a guard like `import.meta.url ===
 * file://${process.argv[1]}` fails under npx, where the bin is a symlink so the
 * two paths differ and the server would never start.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer, parseServerDefaults } from './server.js'

async function main(): Promise<void> {
  const defaults = parseServerDefaults(process.argv.slice(2))
  const server = buildServer(defaults)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
