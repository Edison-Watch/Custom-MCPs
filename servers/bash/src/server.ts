/**
 * The `bash-mcp` MCP server: the `run` tool wiring, launch-default parsing, and
 * the server factory. Kept out of `index.ts` (a thin CLI entry that always calls
 * main()) so tests can drive `buildServer` in-process without spawning a shell,
 * and so the published bin starts reliably under npx's symlink.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  checkAllowlist,
  execCommand,
  formatResult,
  isErrorResult,
  resolveShell,
  validateCwd
} from './exec.js'

export const VERSION = '0.1.0'

/** How often to emit a progress heartbeat while a command is running (ms). */
const DEFAULT_HEARTBEAT_MS = 10_000

/** Server-level defaults resolved once at launch. */
export interface ServerDefaults {
  /** Default working directory: `--cwd` flag or BASH_MCP_CWD. */
  cwd?: string
}

function heartbeatMs(): number {
  const raw = process.env.BASH_MCP_HEARTBEAT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS
}

/**
 * Zod wrapper that treats a blank / whitespace-only string as an omitted value,
 * then makes the field optional. Used only for `cwd`: a client that serializes an
 * unset field as `""` (or a padded path) should be treated as "no cwd" rather
 * than failing validation. NOT used for `stdin`, where whitespace is real data.
 *
 * The trailing `.optional()` is load-bearing: a bare `z.preprocess(...)` is a
 * ZodEffects, not a ZodOptional, so the generated tool input schema would mark
 * the field REQUIRED.
 */
function optionalNonBlank<T extends z.ZodTypeAny>(schema: T) {
  return z
    .preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v) : v), schema)
    .optional()
}

/**
 * Resolve server-level defaults from the launch argv (`--cwd <dir>` or the `=`
 * form) and the BASH_MCP_CWD env var. A launch flag wins over the env var; a
 * per-call `cwd` argument wins over both.
 */
export function parseServerDefaults(argv: string[]): ServerDefaults {
  const defaults: ServerDefaults = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--cwd') defaults.cwd = argv[++i]
    else if (arg.startsWith('--cwd=')) defaults.cwd = arg.slice('--cwd='.length)
  }
  if (!defaults.cwd && process.env.BASH_MCP_CWD) defaults.cwd = process.env.BASH_MCP_CWD
  if (defaults.cwd !== undefined && defaults.cwd.trim() === '') delete defaults.cwd
  return defaults
}

function registerRunTool(server: McpServer, defaults: ServerDefaults): void {
  server.registerTool(
    'run',
    {
      title: 'Run bash command',
      description:
        `Run a shell command with ${resolveShell(undefined)} and return its exit code, ` +
        'stdout, and stderr. Full bash is available (pipes, redirects, globs, env, &&/||). ' +
        'The command runs to completion, then the combined result is returned.',
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('The bash command line to execute, e.g. `ls -la | head`. Full shell syntax.'),
        cwd: optionalNonBlank(z.string().optional()).describe(
          'Absolute path to the working directory. When omitted, the launch default ' +
            "(--cwd / BASH_MCP_CWD) is used, else the server's own working directory."
        ),
        // Plain optional: whitespace-only stdin is legitimate data, so it must NOT
        // be normalized away the way a blank `cwd` is.
        stdin: z
          .string()
          .optional()
          .describe('Optional data piped to the command on stdin, followed by EOF.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Per-call timeout in milliseconds. Overrides the server default (BASH_MCP_TIMEOUT_MS).'
          )
      }
    },
    async ({ command, cwd, stdin, timeout_ms }, extra) => {
      // Working-directory precedence: a valid per-call `cwd` wins; otherwise the
      // launch default; otherwise the server's own cwd. A bad cwd fails loudly.
      // Prefer the path exactly as given (a directory may legitimately have
      // leading/trailing spaces); only fall back to a trimmed value when the
      // exact path is unusable, to absorb client-added padding like `'/repo '`.
      const rawCwd = cwd ?? defaults.cwd
      let chosenCwd = rawCwd
      if (rawCwd !== undefined && validateCwd(rawCwd) !== undefined) {
        const trimmed = rawCwd.trim()
        chosenCwd = trimmed === '' ? undefined : trimmed
      }
      const cwdError = validateCwd(chosenCwd)
      if (cwdError) {
        return { content: [{ type: 'text', text: cwdError }], isError: true }
      }

      const denied = checkAllowlist(command)
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true }
      }

      // A long-running command emits no MCP traffic on its own, so the call can
      // look hung. Emit a progress notification for every output line plus a
      // periodic heartbeat, so clients that reset their request timeout on
      // progress keep the call alive. Only sent when a progressToken was given.
      const progressToken = extra._meta?.progressToken
      let ticks = 0
      let latest = ''
      const sendProgress = (message: string): void => {
        if (progressToken === undefined) return
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: ++ticks, message }
          })
          .catch(() => {
            // Client disconnected or does not accept progress; ignore.
          })
      }
      // One progress notification per complete output line. A logical line can
      // arrive split across chunks, so buffer per stream and only emit on a
      // newline; flush any trailing partial line when the process finishes.
      //
      // The pending-line buffer is itself bounded: `execCommand` caps CAPTURED
      // output at MAX_STREAM_BYTES, but it still calls onStdout/onStderr for
      // every raw chunk, so a command emitting a huge line with no newline
      // (`head -c 1G /dev/zero`) would otherwise grow `buf` without limit and
      // exhaust the connector. A progress message is only ever sliced to 200
      // chars, so retaining more than ~1 KiB of an unfinished line is useless;
      // keep the head, drop the overflow, and still emit once at the newline.
      const MAX_PENDING = 1024
      const makeLineEmitter = () => {
        let buf = ''
        const send = (line: string): void => {
          const trimmed = line.trim()
          if (!trimmed) return
          latest = trimmed.slice(0, 200)
          sendProgress(latest)
        }
        return {
          emit(chunk: string): void {
            let start = 0
            while (start < chunk.length) {
              const nl = chunk.indexOf('\n', start)
              const end = nl >= 0 ? nl : chunk.length
              const room = MAX_PENDING - buf.length
              if (room > 0) buf += chunk.slice(start, Math.min(end, start + room))
              if (nl < 0) break
              send(buf)
              buf = ''
              start = nl + 1
            }
          },
          flush(): void {
            send(buf)
            buf = ''
          }
        }
      }
      const outEmit = makeLineEmitter()
      const errEmit = makeLineEmitter()

      const heartbeat = setInterval(() => {
        sendProgress(latest || 'running...')
      }, heartbeatMs())
      heartbeat.unref()

      try {
        const result = await execCommand(command, {
          cwd: chosenCwd,
          stdin,
          timeoutMs: timeout_ms,
          onStdout: outEmit.emit,
          onStderr: errEmit.emit
        })
        outEmit.flush()
        errEmit.flush()
        return {
          content: [{ type: 'text', text: formatResult(command, result) }],
          isError: isErrorResult(result)
        }
      } finally {
        clearInterval(heartbeat)
      }
    }
  )
}

/** Build a configured `bash-mcp` server (exported so tests can drive it in-process). */
export function buildServer(defaults: ServerDefaults = {}): McpServer {
  const server = new McpServer({ name: 'sealgate-bash', version: VERSION })
  registerRunTool(server, defaults)
  return server
}
