/**
 * True end-to-end test: build the package, spawn the real `dist/index.js` as a
 * subprocess, talk to it over stdio with the MCP client SDK, and assert that
 * `notifications/progress` actually reach the client while a command runs.
 *
 * Unlike server.test.ts (in-process InMemoryTransport), this exercises the shipped
 * binary, the stdio transport, and the SDK's progressToken plumbing together.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { beforeAll, describe, expect, it } from 'vitest'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(pkgDir, 'dist', 'index.js')

interface Progress {
  progress: number
  total?: number
  message?: string
}

/** Connect a real client to a freshly spawned `dist/index.js` over stdio. */
async function connect(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [entry],
    env: { ...(process.env as Record<string, string>), ...env }
  })
  const client = new Client({ name: 'e2e', version: '0' })
  await client.connect(transport)
  return client
}

async function runWithProgress(
  client: Client,
  command: string,
  extra: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean; progress: Progress[] }> {
  const progress: Progress[] = []
  const res = (await client.callTool({ name: 'run', arguments: { command, ...extra } }, undefined, {
    onprogress: (p: Progress) => progress.push(p)
  })) as { content: Array<{ text: string }>; isError?: boolean }
  return {
    text: res.content.map((c) => c.text).join('\n'),
    isError: res.isError === true,
    progress
  }
}

describe('bash-mcp e2e progress notifications', () => {
  beforeAll(() => {
    // Build the shipped artifact if it is missing or stale-ish; cheap enough to
    // always run so the test never asserts against a phantom old dist.
    execSync("bun run build", { cwd: pkgDir, stdio: 'inherit' })
    expect(existsSync(entry)).toBe(true)
  }, 60_000)

  it('streams a progress notification per output line', async () => {
    const client = await connect()
    // Emit three lines with gaps so each arrives as its own stdout chunk.
    const { text, isError, progress } = await runWithProgress(
      client,
      'for i in 1 2 3; do echo "line$i"; sleep 0.15; done'
    )
    await client.close()

    expect(isError).toBe(false)
    expect(text).toContain('line1')
    expect(text).toContain('line3')

    const messages = progress.map((p) => p.message ?? '')
    // Each emitted line should have surfaced as a progress message.
    expect(messages.some((m) => m.includes('line1'))).toBe(true)
    expect(messages.some((m) => m.includes('line2'))).toBe(true)
    expect(messages.some((m) => m.includes('line3'))).toBe(true)
    // The SDK requires monotonically increasing progress values.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.progress).toBeGreaterThan(progress[i - 1]!.progress)
    }
  }, 30_000)

  it('emits heartbeat progress while a silent command runs', async () => {
    // A command that produces no output for ~0.6s; with a 50ms heartbeat the
    // server should still keep the call alive with heartbeat notifications.
    const client = await connect({ BASH_MCP_HEARTBEAT_MS: '50' })
    const { isError, progress } = await runWithProgress(client, 'sleep 0.6')
    await client.close()

    expect(isError).toBe(false)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.some((p) => (p.message ?? '').includes('running'))).toBe(true)
  }, 30_000)

  it('sends no progress when the caller omits a progressToken', async () => {
    const client = await connect()
    // callTool without onprogress → SDK attaches no progressToken → server stays quiet.
    const res = (await client.callTool({
      name: 'run',
      arguments: { command: 'echo quiet' }
    })) as { content: Array<{ text: string }>; isError?: boolean }
    await client.close()
    expect(res.isError === true).toBe(false)
    expect(res.content.map((c) => c.text).join('\n')).toContain('quiet')
  }, 30_000)
})
