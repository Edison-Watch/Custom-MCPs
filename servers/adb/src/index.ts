#!/usr/bin/env node
/**
 * SealGate android-adb-mcp: a thin stdio MCP server that exposes Android Debug
 * Bridge (adb) for a locally-connected device or emulator.
 *
 * Tools (a faithful TypeScript re-implementation of minhalvp/android-mcp-server,
 * MIT, https://github.com/minhalvp/android-mcp-server):
 *   - get_packages
 *   - execute_adb_command
 *   - get_uilayout
 *   - get_screenshot
 *   - get_package_action_intents
 *
 * Launched on the user's machine by the SealGate daemon over a stdio tunnel,
 * e.g. `npx -y @sealgate/android-adb-mcp`. Pick a device on a multi-device host
 * with `--serial <serial>` or the `ANDROID_ADB_SERIAL` env var.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  parseActionIntents,
  parsePackages,
  parseUiLayout,
  resolveSerial,
  runAdb,
  runAdbBinary,
  tokenizeCommand,
  withSerial
} from './adb.js'
import { parseServerConfig, type ServerConfig } from './config.js'

const VERSION = '0.1.0'

/** A validated Android package name (also guards the dumpsys shell argument). */
const PACKAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/

/** Where `uiautomator dump` writes on the device before we cat it back. */
const UI_DUMP_PATH = '/sdcard/window_dump.xml'

/** A tool handler that has already resolved which device to talk to. */
type SerialResolver = () => Promise<string>

/**
 * Resolve the target serial at most once per process. Cached because it costs an
 * `adb devices` round-trip and the connected device does not change mid-session;
 * a failed resolution is not cached so replugging a device recovers.
 */
function makeSerialResolver(config: ServerConfig): SerialResolver {
  let cached: string | undefined
  return async () => {
    if (cached) return cached
    cached = await resolveSerial(config.serial)
    return cached
  }
}

function textResult(
  text: string,
  isError = false
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError }
}

/** Render a failed adb invocation into a single human-readable error string. */
function adbFailure(action: string, stderr: string, code: number | null): string {
  const detail = stderr.trim() || '(no stderr)'
  return `${action} failed (adb exit ${code ?? 'null'}):\n${detail}`
}

function registerTools(server: McpServer, resolve: SerialResolver): void {
  server.registerTool(
    'get_packages',
    {
      title: 'List installed packages',
      description: 'List all packages installed on the connected Android device.',
      inputSchema: {}
    },
    async () => {
      const serial = await resolve()
      const res = await runAdb(withSerial(serial, ['shell', 'pm', 'list', 'packages']))
      if (res.code !== 0) return textResult(adbFailure('get_packages', res.stderr, res.code), true)
      const packages = parsePackages(res.stdout)
      return textResult(JSON.stringify({ count: packages.length, packages }, null, 2))
    }
  )

  server.registerTool(
    'execute_adb_command',
    {
      title: 'Execute an adb command',
      description:
        'Run an arbitrary adb command against the connected device and return its output. ' +
        'The command is everything after `adb` (e.g. "shell ls /sdcard", "pm list packages", ' +
        '"logcat -d"). The target device is selected automatically.',
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('The adb command to run, without the leading `adb` (e.g. "shell ls /sdcard").')
      }
    },
    async ({ command }) => {
      const args = tokenizeCommand(command)
      if (args.length === 0) return textResult('execute_adb_command: empty command', true)
      const serial = await resolve()
      const res = await runAdb(withSerial(serial, args))
      const out = res.stdout.trim()
      const err = res.stderr.trim()
      if (res.code !== 0) {
        const parts = [`adb exited with code ${res.code ?? 'null'}.`]
        if (out) parts.push(`--- stdout ---\n${out}`)
        if (err) parts.push(`--- stderr ---\n${err}`)
        return textResult(parts.join('\n\n'), true)
      }
      return textResult(out || err || '(no output)')
    }
  )

  server.registerTool(
    'get_uilayout',
    {
      title: 'Get UI layout',
      description:
        'Dump the current screen UI hierarchy and return the clickable/labelled elements with ' +
        'their text, content description, class, bounds, and centre tap coordinates.',
      inputSchema: {}
    },
    async () => {
      const serial = await resolve()
      const dump = await runAdb(withSerial(serial, ['shell', 'uiautomator', 'dump', UI_DUMP_PATH]))
      // `uiautomator dump` prints its status to stdout and a non-zero exit only on
      // hard failure; tolerate the status line and rely on the cat below.
      if (dump.code !== 0 && !/dumped to/i.test(dump.stdout + dump.stderr)) {
        return textResult(
          adbFailure('get_uilayout (dump)', dump.stderr || dump.stdout, dump.code),
          true
        )
      }
      const cat = await runAdb(withSerial(serial, ['shell', 'cat', UI_DUMP_PATH]))
      if (cat.code !== 0)
        return textResult(adbFailure('get_uilayout (read)', cat.stderr, cat.code), true)
      const elements = parseUiLayout(cat.stdout)
      return textResult(JSON.stringify({ count: elements.length, elements }, null, 2))
    }
  )

  server.registerTool(
    'get_screenshot',
    {
      title: 'Take a screenshot',
      description: 'Capture a PNG screenshot of the connected device screen.',
      inputSchema: {}
    },
    async () => {
      const serial = await resolve()
      const res = await runAdbBinary(withSerial(serial, ['exec-out', 'screencap', '-p']))
      if (res.code !== 0 || res.data.length === 0) {
        return textResult(adbFailure('get_screenshot', res.stderr, res.code), true)
      }
      return {
        content: [
          { type: 'image' as const, data: res.data.toString('base64'), mimeType: 'image/png' }
        ]
      }
    }
  )

  server.registerTool(
    'get_package_action_intents',
    {
      title: 'Get package action intents',
      description:
        'List the non-data intent actions a package advertises in its Activity Resolver Table ' +
        '(useful for launching specific screens of an app).',
      inputSchema: {
        package_name: z
          .string()
          .min(1)
          .describe('The package name to inspect, e.g. "com.android.settings".')
      }
    },
    async ({ package_name }) => {
      if (!PACKAGE_NAME.test(package_name)) {
        return textResult(`Invalid package name: ${JSON.stringify(package_name)}`, true)
      }
      const serial = await resolve()
      const res = await runAdb(withSerial(serial, ['shell', 'dumpsys', 'package', package_name]))
      if (res.code !== 0) {
        return textResult(adbFailure('get_package_action_intents', res.stderr, res.code), true)
      }
      const actions = parseActionIntents(res.stdout)
      return textResult(
        JSON.stringify({ package: package_name, count: actions.length, actions }, null, 2)
      )
    }
  )
}

async function main(): Promise<void> {
  const config = parseServerConfig(process.argv.slice(2))
  const server = new McpServer({ name: 'sealgate-android-adb', version: VERSION })
  registerTools(server, makeSerialResolver(config))

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
