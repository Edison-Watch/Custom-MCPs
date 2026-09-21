import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkAllowlist,
  execCommand,
  formatResult,
  isErrorResult,
  resolveShell,
  validateCwd
} from '../src/exec.js'

// Hermetic env: strip ambient BASH_MCP_* so the runner's shell can't skew tests.
const baseEnv = { ...process.env }
for (const k of Object.keys(baseEnv)) if (k.startsWith('BASH_MCP_')) delete baseEnv[k]
process.env = { ...baseEnv }

// Track temp dirs created by tests and remove them afterwards.
const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bash-mcp-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  process.env = { ...baseEnv }
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('execCommand', () => {
  it('runs a command and captures stdout with exit 0', async () => {
    const result = await execCommand('echo hello')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(isErrorResult(result)).toBe(false)
  })

  it('captures a non-zero exit code and stderr', async () => {
    const result = await execCommand('echo oops >&2; exit 3')
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toBe('oops')
    expect(isErrorResult(result)).toBe(true)
  })

  it('supports full shell syntax (pipes and &&)', async () => {
    const result = await execCommand('printf "a\\nb\\nc\\n" | wc -l')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('3')
  })

  it('feeds stdin to the command', async () => {
    const result = await execCommand('cat', { stdin: 'piped-in' })
    expect(result.stdout).toBe('piped-in')
  })

  it('runs in the given cwd', async () => {
    const dir = mkTmp()
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const result = await execCommand('ls', { cwd: dir })
    expect(result.stdout).toContain('marker.txt')
  })

  it('times out and kills a hung command', async () => {
    const result = await execCommand('sleep 5', { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(isErrorResult(result)).toBe(true)
  })

  it('reports a spawn error for a missing shell', async () => {
    const result = await execCommand('echo hi', { shell: '/nonexistent/shell' })
    expect(result.spawnError).toBeDefined()
    expect(isErrorResult(result)).toBe(true)
  })

  it('survives a large stdin payload to a command that ignores it (no EPIPE crash)', async () => {
    // `true` exits immediately without reading stdin; a >pipe-buffer payload would
    // raise EPIPE on child.stdin. Without an error handler that crashes the whole
    // process; here it must resolve cleanly. If the fix regresses, this kills the
    // vitest worker rather than failing softly.
    const result = await execCommand('true', { stdin: 'x'.repeat(2_000_000) })
    expect(result.spawnError).toBeUndefined()
    expect(result.code).toBe(0)
  })
})

describe('validateCwd', () => {
  it('accepts an existing directory and undefined', () => {
    expect(validateCwd(undefined)).toBeUndefined()
    expect(validateCwd(tmpdir())).toBeUndefined()
  })

  it('rejects a missing path', () => {
    expect(validateCwd('/definitely/not/here')).toContain('does not exist')
  })

  it('rejects a file', () => {
    const dir = mkTmp()
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    expect(validateCwd(file)).toContain('not a directory')
  })
})

describe('checkAllowlist', () => {
  it('allows anything when unset', () => {
    delete process.env.BASH_MCP_ALLOW
    expect(checkAllowlist('rm -rf /')).toBeUndefined()
  })

  it('allows a listed program (by basename)', () => {
    process.env.BASH_MCP_ALLOW = 'ls, git'
    expect(checkAllowlist('git status')).toBeUndefined()
    expect(checkAllowlist('/usr/bin/ls -la')).toBeUndefined()
  })

  it('denies an unlisted program', () => {
    process.env.BASH_MCP_ALLOW = 'ls'
    expect(checkAllowlist('cat /etc/passwd')).toContain('not in BASH_MCP_ALLOW')
  })
})

describe('formatResult', () => {
  it('shows exit code and stdout on success', () => {
    const text = formatResult('echo hi', {
      code: 0,
      signal: null,
      stdout: 'hi\n',
      stderr: '',
      timedOut: false
    })
    expect(text).toContain('exit code 0')
    expect(text).toContain('hi')
  })

  it('surfaces a spawn error verbatim', () => {
    const text = formatResult('echo hi', {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: 'failed to launch shell'
    })
    expect(text).toBe('failed to launch shell')
  })

  it('labels a timeout', () => {
    const text = formatResult('sleep 99', {
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true
    })
    expect(text).toContain('timed out')
  })
})

describe('resolveShell', () => {
  it('prefers the explicit shell, then env, then default', () => {
    delete process.env.BASH_MCP_SHELL
    expect(resolveShell('/bin/zsh')).toBe('/bin/zsh')
    process.env.BASH_MCP_SHELL = '/bin/sh'
    expect(resolveShell(undefined)).toBe('/bin/sh')
    delete process.env.BASH_MCP_SHELL
    expect(resolveShell(undefined)).toBe('/bin/bash')
  })
})
