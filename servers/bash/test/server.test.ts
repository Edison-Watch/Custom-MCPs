import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, parseServerDefaults } from '../src/server.js'
import type { ServerDefaults } from '../src/server.js'

// Hermetic env: snapshot a baseline with all BASH_MCP_* keys removed so an
// ambient value in the runner's shell (e.g. a developer's BASH_MCP_ALLOW) cannot
// leak into these tests, and restore to that baseline after each test.
const baseEnv = { ...process.env }
for (const k of Object.keys(baseEnv)) if (k.startsWith('BASH_MCP_')) delete baseEnv[k]
process.env = { ...baseEnv }
afterEach(() => {
  process.env = { ...baseEnv }
})

/** Spin up the real server + an MCP client wired over an in-memory transport. */
async function connect(defaults: ServerDefaults = {}): Promise<Client> {
  const server = buildServer(defaults)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** Call the `run` tool and return { text, isError }. */
async function run(
  client: Client,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name: 'run', arguments: args })) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
  return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true }
}

describe('bash-mcp server', () => {
  it('advertises exactly the run tool with the expected schema', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['run'])
    const props = tools[0]?.inputSchema.properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['command', 'cwd', 'stdin', 'timeout_ms'])
    expect(tools[0]?.inputSchema.required).toEqual(['command'])
    await client.close()
  })

  it('runs a command and returns exit 0 without isError', async () => {
    const client = await connect()
    const { text, isError } = await run(client, { command: 'echo hello' })
    expect(isError).toBe(false)
    expect(text).toContain('exit code 0')
    expect(text).toContain('hello')
    await client.close()
  })

  it('sets isError and reports the code on a non-zero exit', async () => {
    const client = await connect()
    const { text, isError } = await run(client, { command: 'echo boom >&2; exit 7' })
    expect(isError).toBe(true)
    expect(text).toContain('exit code 7')
    expect(text).toContain('boom')
    await client.close()
  })

  it('supports full shell syntax through the tool', async () => {
    const client = await connect()
    const { text } = await run(client, { command: 'seq 1 5 | tail -n 2' })
    expect(text).toContain('4')
    expect(text).toContain('5')
    await client.close()
  })

  it('passes stdin to the command', async () => {
    const client = await connect()
    const { text } = await run(client, { command: 'cat', stdin: 'from-the-caller' })
    expect(text).toContain('from-the-caller')
    await client.close()
  })

  it('honors a per-call cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-mcp-srv-'))
    writeFileSync(join(dir, 'sentinel.txt'), 'x')
    const client = await connect()
    const { text } = await run(client, { command: 'ls', cwd: dir })
    expect(text).toContain('sentinel.txt')
    await client.close()
  })

  it('fails loudly on a bad per-call cwd (no silent fallback)', async () => {
    const client = await connect()
    const { text, isError } = await run(client, { command: 'echo hi', cwd: '/no/such/dir' })
    expect(isError).toBe(true)
    expect(text).toContain('does not exist')
    await client.close()
  })

  it('accepts a whitespace-padded but valid cwd (trims before validating)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-mcp-pad-'))
    writeFileSync(join(dir, 'padded.txt'), 'x')
    const client = await connect()
    const { text, isError } = await run(client, { command: 'ls', cwd: `  ${dir}  ` })
    expect(isError).toBe(false)
    expect(text).toContain('padded.txt')
    await client.close()
  })

  it('does not trim stdin (surrounding whitespace is data)', async () => {
    const client = await connect()
    // wc -c counts bytes; a trimmed stdin would drop the leading/trailing spaces.
    const { text } = await run(client, { command: 'wc -c', stdin: '  hi  ' })
    expect(text).toContain('6')
    await client.close()
  })

  it('treats a blank cwd as omitted', async () => {
    const client = await connect()
    const { text, isError } = await run(client, { command: 'echo ok', cwd: '   ' })
    expect(isError).toBe(false)
    expect(text).toContain('ok')
    await client.close()
  })

  it('uses the launch-default cwd when no per-call cwd is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-mcp-def-'))
    writeFileSync(join(dir, 'default-marker.txt'), 'x')
    const client = await connect({ cwd: dir })
    const { text } = await run(client, { command: 'ls' })
    expect(text).toContain('default-marker.txt')
    await client.close()
  })

  it('enforces BASH_MCP_ALLOW through the tool', async () => {
    process.env.BASH_MCP_ALLOW = 'echo'
    const client = await connect()
    const denied = await run(client, { command: 'cat /etc/passwd' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('not in BASH_MCP_ALLOW')
    const allowed = await run(client, { command: 'echo fine' })
    expect(allowed.isError).toBe(false)
    await client.close()
  })

  it('times out a hung command and sets isError', async () => {
    const client = await connect()
    const { text, isError } = await run(client, { command: 'sleep 5', timeout_ms: 150 })
    expect(isError).toBe(true)
    expect(text).toContain('timed out')
    await client.close()
  })
})

describe('parseServerDefaults', () => {
  it('reads --cwd and --cwd= forms', () => {
    expect(parseServerDefaults(['--cwd', '/a']).cwd).toBe('/a')
    expect(parseServerDefaults(['--cwd=/b']).cwd).toBe('/b')
  })

  it('falls back to BASH_MCP_CWD, with the flag winning', () => {
    process.env.BASH_MCP_CWD = '/env'
    expect(parseServerDefaults([]).cwd).toBe('/env')
    expect(parseServerDefaults(['--cwd', '/flag']).cwd).toBe('/flag')
  })

  it('treats a blank cwd as unset', () => {
    delete process.env.BASH_MCP_CWD
    expect(parseServerDefaults(['--cwd', '   ']).cwd).toBeUndefined()
  })
})
