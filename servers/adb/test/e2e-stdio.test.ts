/**
 * End-to-end test: build the package, spawn the real `dist/index.js` as a
 * subprocess, and drive it over stdio with the MCP client SDK on BOTH protocol
 * eras: the 2025-era `initialize` handshake (the client's default) and the
 * 2026-07-28 era (pinned, via `server/discover`).
 *
 * No device or adb binary is needed: the tool call uses an invalid package name,
 * which the server rejects before ever spawning adb, so the result is the same on
 * a bare CI runner and on a developer machine with a phone plugged in.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { beforeAll, describe, expect, it } from 'vitest'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(pkgDir, 'dist', 'index.js')
const MODERN = '2026-07-28'

const EXPECTED_TOOLS = [
  'execute_adb_command',
  'get_package_action_intents',
  'get_packages',
  'get_screenshot',
  'get_uilayout'
]

async function connect(pin?: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [entry],
    env: process.env as Record<string, string>,
    stderr: 'pipe'
  })
  const client = new Client(
    { name: 'e2e', version: '0' },
    pin ? { versionNegotiation: { mode: { pin } } } : {}
  )
  await client.connect(transport)
  return client
}

describe('android-adb-mcp e2e over stdio', () => {
  beforeAll(() => {
    execSync('bun run build', { cwd: pkgDir, stdio: 'inherit' })
    expect(existsSync(entry)).toBe(true)
  }, 60_000)

  for (const [label, pin] of [
    ['2025-era initialize (default)', undefined],
    [`${MODERN} (pinned)`, MODERN]
  ] as const) {
    it(`lists tools and fails a tool call cleanly over ${label}`, async () => {
      const client = await connect(pin)
      try {
        const negotiated = client.getNegotiatedProtocolVersion()
        if (pin) expect(negotiated).toBe(pin)
        else expect(negotiated).not.toBe(MODERN)

        const { tools } = await client.listTools()
        expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS)

        const res = (await client.callTool({
          name: 'get_package_action_intents',
          arguments: { package_name: 'not a package!' }
        })) as { content: Array<{ type: string; text: string }>; isError?: boolean }
        expect(res.isError).toBe(true)
        expect(res.content.map((c) => c.text).join('\n')).toContain('Invalid package name')
      } finally {
        await client.close()
      }
    }, 30_000)
  }
})
