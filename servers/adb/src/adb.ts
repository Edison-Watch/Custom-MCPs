/**
 * Android Debug Bridge helpers for the SealGate android-adb-mcp server.
 *
 * The pure functions (`parsePackages`, `parseUiLayout`, `parseActionIntents`,
 * `resolveDeviceArgs`, `tokenizeCommand`, ...) hold all the parsing/decision
 * logic and are unit-tested without a device. The `run*` wrappers are thin
 * shells over `child_process.spawn` that shell out to the real `adb` binary on
 * the user's machine.
 */

import { spawn } from 'node:child_process'

/** The `adb` executable. Overridable for tests / non-standard installs. */
export const ADB_BIN = process.env.ADB_PATH || 'adb'

/** Result of a completed adb invocation. */
export interface AdbResult {
  stdout: string
  stderr: string
  code: number | null
}

/** A clickable/interesting node from a `uiautomator` UI dump. */
export interface UiElement {
  text: string
  description: string
  className: string
  bounds: string
  /** Centre point, ready to feed back into `adb shell input tap x y`. */
  center: { x: number; y: number }
}

/**
 * Parse `adb shell pm list packages` output into a sorted list of package names.
 * Each line looks like `package:com.example.app`; blank lines and any line
 * without the `package:` prefix are ignored.
 */
export function parsePackages(raw: string): string[] {
  const pkgs = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => l.slice('package:'.length).trim())
    .filter(Boolean)
  return [...new Set(pkgs)].sort()
}

/**
 * Parse a `uiautomator` bounds string `[x1,y1][x2,y2]` into its centre point.
 * Returns null when the string is malformed, so a single bad node never throws.
 */
export function parseBounds(bounds: string): { x: number; y: number } | null {
  const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
  if (!m) return null
  const x1 = Number(m[1])
  const y1 = Number(m[2])
  const x2 = Number(m[3])
  const y2 = Number(m[4])
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

/** Decode the handful of XML entities `uiautomator` emits in attribute values. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function attr(node: string, name: string): string {
  const m = node.match(new RegExp(`${name}="([^"]*)"`))
  return m ? decodeXmlEntities(m[1] ?? '') : ''
}

/**
 * Parse a `uiautomator dump` XML document into the interesting elements: those
 * marked `clickable="true"` or carrying visible `text` / `content-desc`. Uses a
 * tolerant `<node .../>` scan rather than a full XML parser so a slightly
 * malformed dump (common from `uiautomator`) still yields what it can instead of
 * failing whole. Nodes without parseable bounds are skipped (no tap target).
 */
export function parseUiLayout(xml: string): UiElement[] {
  const elements: UiElement[] = []
  for (const m of xml.matchAll(/<node\b[^>]*?\/?>/g)) {
    const node = m[0]
    const text = attr(node, 'text')
    const description = attr(node, 'content-desc')
    const clickable = attr(node, 'clickable') === 'true'
    if (!clickable && !text && !description) continue
    const bounds = attr(node, 'bounds')
    const center = parseBounds(bounds)
    if (!center) continue
    elements.push({
      text,
      description,
      className: attr(node, 'class'),
      bounds,
      center
    })
  }
  return elements
}

/**
 * Extract the action names from the "Non-Data Actions" section of
 * `adb shell dumpsys package <pkg>` output (the Activity Resolver Table). These
 * are the intent actions a package can be launched with. Action lines look like
 * `        android.intent.action.MAIN:` and are followed by indented component
 * rows (`<pkg>/<activity> ...`), which we skip. Deduped and sorted.
 */
export function parseActionIntents(dumpsys: string): string[] {
  const lines = dumpsys.split('\n')
  const actions = new Set<string>()
  let inActions = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (/Non-Data Actions:/.test(trimmed)) {
      inActions = true
      continue
    }
    if (!inActions) continue
    // The section ends at the next non-indented / differently-headed block.
    if (trimmed === '' || /^[A-Z][A-Za-z ]+:$/.test(trimmed)) {
      if (trimmed !== '' && !/Non-Data Actions:/.test(trimmed)) break
      continue
    }
    // An action header ends in ':' and contains no component separator '/'.
    const m = trimmed.match(/^([A-Za-z0-9_.]+):$/)
    if (m && m[1] && m[1].includes('.') && !m[1].includes('/')) {
      actions.add(m[1])
    }
  }
  return [...actions].sort()
}

/** A resolved device selection, or an error explaining why none could be chosen. */
export type DeviceSelection = { serial: string } | { error: string }

/**
 * Decide which device an adb command should target, from `adb devices` output
 * and an optional requested serial (a `--serial` launch flag or the
 * `ANDROID_ADB_SERIAL` env var). Precedence:
 *   - requested serial present and online  -> use it
 *   - requested serial not found           -> error listing what's connected
 *   - no request, exactly one device       -> use it
 *   - no request, multiple devices         -> error asking for a serial
 *   - no devices                           -> error
 * Only `device`-state entries count; `offline` / `unauthorized` are surfaced in
 * the error rather than silently targeted.
 */
export function resolveDeviceArgs(devicesRaw: string, requested?: string): DeviceSelection {
  const online: string[] = []
  const other: string[] = []
  for (const raw of devicesRaw.split('\n')) {
    const line = raw.trim()
    if (!line || /^List of devices attached/.test(line)) continue
    const [serial, state] = line.split(/\s+/)
    if (!serial) continue
    if (state === 'device') online.push(serial)
    else other.push(`${serial} (${state ?? 'unknown'})`)
  }

  const want = requested?.trim()
  if (want) {
    if (online.includes(want)) return { serial: want }
    const seen = [...online, ...other].join(', ') || 'none'
    return { error: `Requested device '${want}' is not connected/online. Devices seen: ${seen}.` }
  }
  if (online.length === 1) return { serial: online[0] as string }
  if (online.length === 0) {
    const extra = other.length ? ` (not usable: ${other.join(', ')})` : ''
    return {
      error: `No online Android devices found${extra}. Connect a device or start an emulator.`
    }
  }
  return {
    error:
      `Multiple devices connected (${online.join(', ')}). ` +
      `Set ANDROID_ADB_SERIAL or pass --serial <serial> at launch to pick one.`
  }
}

/**
 * Split a raw `execute_adb_command` string into argv the way a POSIX-ish shell
 * would for the simple cases adb needs: whitespace-separated, with single and
 * double quotes grouping tokens (quotes are stripped). This is NOT a full shell
 * (no expansion, no escaping rules beyond quotes) - it just lets callers write
 * `shell "pm list packages"` without the wrapper mangling the quoted argument.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens
}

/** Prefix `-s <serial>` onto an adb argv when a serial was resolved. */
export function withSerial(serial: string | undefined, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args
}

/** Raw result of a spawn: stdout as bytes, so both the text and binary faces
 *  can derive from one implementation. */
interface AdbBytesResult {
  data: Buffer
  stderr: string
  code: number | null
}

/**
 * The single spawn/timeout/error/close implementation. Collects stdout as raw
 * bytes (the text wrapper decodes it) plus stderr as UTF-8, kills the process on
 * timeout and reports it as `code: null` with a stderr suffix. Both public
 * wrappers below are thin typed faces over this, so the tricky process/timeout
 * logic lives in exactly one place.
 */
function spawnAdb(args: string[], timeoutMs: number): Promise<AdbBytesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        data: Buffer.concat(chunks),
        stderr: timedOut ? `${stderr}\n(adb timed out after ${timeoutMs}ms)` : stderr,
        code: timedOut ? null : code
      })
    })
  })
}

/** Spawn adb and collect stdout/stderr as UTF-8 text. */
export async function runAdb(args: string[], timeoutMs = 60_000): Promise<AdbResult> {
  const { data, stderr, code } = await spawnAdb(args, timeoutMs)
  return { stdout: data.toString('utf8'), stderr, code }
}

/** Spawn adb and collect stdout as raw bytes (for `exec-out screencap -p`). */
export function runAdbBinary(args: string[], timeoutMs = 60_000): Promise<AdbBytesResult> {
  return spawnAdb(args, timeoutMs)
}

/**
 * Resolve the device serial to target once, from `adb devices` plus the launch
 * config. Throws with a helpful message when no single device can be chosen, so
 * every tool surfaces the same guidance instead of a raw adb error.
 */
export async function resolveSerial(requested?: string): Promise<string> {
  const devices = await runAdb(['devices'])
  const selection = resolveDeviceArgs(devices.stdout, requested)
  if ('error' in selection) throw new Error(selection.error)
  return selection.serial
}
