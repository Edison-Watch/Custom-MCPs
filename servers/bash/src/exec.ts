/**
 * Core execution primitive for bash-mcp: spawn a shell, run a command string,
 * capture bounded stdout/stderr, and format the result. Unlike agent-cli-mcp,
 * this DOES spawn a shell (`/bin/bash -c <command>`) on purpose (exposing full
 * bash is the whole point), so every caller must be behind the SealGate firewall.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'

/** Hard cap on captured output per stream, to bound memory (bytes). */
export const MAX_STREAM_BYTES = 5 * 1024 * 1024

/** Default per-run timeout; overridable per-call or via BASH_MCP_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000

/** Default shell used to interpret the command string. */
export const DEFAULT_SHELL = '/bin/bash'

export interface ExecResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the shell itself could not be launched (e.g. ENOENT). */
  spawnError?: string
}

export interface ExecOptions {
  /** Shell binary to run the command with. Default: BASH_MCP_SHELL or /bin/bash. */
  shell?: string
  /** Working directory. Must exist; validate with `validateCwd` first. */
  cwd?: string
  /** Data piped to the command's stdin, then EOF. Omitted means stdin is closed. */
  stdin?: string
  /** Per-run timeout in ms. Falls back to BASH_MCP_TIMEOUT_MS then the default. */
  timeoutMs?: number
  /** Called with each raw stdout chunk (for progress); never alters captured output. */
  onStdout?: (chunk: string) => void
  /** Called with each raw stderr chunk (for progress); never alters captured output. */
  onStderr?: (chunk: string) => void
}

function envTimeoutMs(): number {
  const raw = process.env.BASH_MCP_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export function resolveShell(shell: string | undefined): string {
  return shell || process.env.BASH_MCP_SHELL || DEFAULT_SHELL
}

/**
 * A bounded, self-truncating byte buffer. Keeps memory flat when a command
 * spews megabytes, and annotates the output when it had to drop data.
 */
class BoundedBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  push(chunk: Buffer): void {
    if (this.size >= MAX_STREAM_BYTES) {
      this.truncated = true
      return
    }
    const room = MAX_STREAM_BYTES - this.size
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room))
      this.size += room
      this.truncated = true
    } else {
      this.chunks.push(chunk)
      this.size += chunk.length
    }
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${text}\n[output truncated at ${MAX_STREAM_BYTES} bytes]` : text
  }
}

/**
 * Validate a caller-supplied working directory. Returns an error message if the
 * path is unusable, otherwise undefined. Unlike agent-cli-mcp we do NOT silently
 * fall back on a bad cwd: a bash command that expects `/repo` should fail loudly
 * rather than run somewhere unexpected.
 */
export function validateCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (!existsSync(cwd)) return `cwd does not exist: ${cwd}`
  if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`
  return undefined
}

/**
 * Optional command allowlist. When BASH_MCP_ALLOW is set to a comma-separated
 * list of program names, the FIRST bare word of the command must be one of them.
 * This is a coarse guard (it does not parse the full command), meant as a
 * defence-in-depth knob on top of the SealGate firewall, not a substitute for
 * it. Unset means "allow anything", the default for full-bash exposure.
 */
export function checkAllowlist(command: string): string | undefined {
  const raw = process.env.BASH_MCP_ALLOW
  if (!raw || !raw.trim()) return undefined
  const allowed = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const firstWord = command.trim().split(/\s+/)[0] ?? ''
  const program = basename(firstWord)
  if (!allowed.has(program)) {
    return `command "${program}" is not in BASH_MCP_ALLOW (${[...allowed].join(', ')})`
  }
  return undefined
}

/**
 * Run `command` through a shell and resolve with its captured result. Never
 * rejects: launch failures and timeouts are reported in the resolved value so
 * the caller can format a single consistent tool response.
 */
export function execCommand(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const shell = resolveShell(opts.shell)
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : envTimeoutMs()

  return new Promise((resolve) => {
    const out = new BoundedBuffer()
    const err = new BoundedBuffer()
    let settled = false
    let timedOut = false

    const child = spawn(shell, ['-c', command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeout)

    child.stdout?.on('data', (d: Buffer) => {
      out.push(d)
      opts.onStdout?.(d.toString('utf8'))
    })
    child.stderr?.on('data', (d: Buffer) => {
      err.push(d)
      opts.onStderr?.(d.toString('utf8'))
    })

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: string
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        spawnError
      })
    }

    child.on('error', (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === 'ENOENT' ? ` (is the shell "${shell}" installed on this machine?)` : ''
      finish(null, null, `failed to launch shell "${shell}": ${e.message}${hint}`)
    })

    child.on('close', (code, signal) => finish(code, signal))

    if (opts.stdin !== undefined && child.stdin) {
      // The child can close its read end before the write lands: a command that
      // ignores stdin and exits fast, or a payload bigger than the pipe buffer.
      // That surfaces as an 'error' (EPIPE) on the stdin stream; with no listener
      // Node promotes it to an uncaughtException and kills this long-lived server,
      // so one bad call would break every later call. Swallow it: the command's
      // exit code and stderr already carry the real outcome.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.stdin)
    }
  })
}

/**
 * Compose the text payload returned to the MCP client. Shows the exit code and
 * each non-empty stream, so a caller (and the SealGate audit log) sees exactly
 * what happened. The `isError` flag is derived separately by the caller.
 */
export function formatResult(command: string, result: ExecResult): string {
  if (result.spawnError) return result.spawnError

  const stdout = result.stdout.replace(/\s+$/, '')
  const stderr = result.stderr.replace(/\s+$/, '')

  if (result.timedOut) {
    const parts = [`command timed out and was killed: ${command}`]
    if (stdout) parts.push(`--- stdout ---\n${stdout}`)
    if (stderr) parts.push(`--- stderr ---\n${stderr}`)
    return parts.join('\n\n')
  }

  const exit = result.signal
    ? `killed by signal ${result.signal}`
    : `exit code ${result.code ?? 'unknown'}`
  const parts = [exit]
  if (stdout) parts.push(`--- stdout ---\n${stdout}`)
  if (stderr) parts.push(`--- stderr ---\n${stderr}`)
  if (!stdout && !stderr) parts.push('(no output)')
  return parts.join('\n\n')
}

/** Whether a finished run should set the MCP `isError` flag. */
export function isErrorResult(result: ExecResult): boolean {
  return (
    result.spawnError !== undefined ||
    result.timedOut ||
    result.signal !== null ||
    (result.code ?? 1) !== 0
  )
}
