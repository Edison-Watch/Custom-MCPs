import { describe, expect, it } from 'vitest'
import {
  parseActionIntents,
  parseBounds,
  parsePackages,
  parseUiLayout,
  resolveDeviceArgs,
  tokenizeCommand,
  withSerial
} from '../src/adb.js'
import { parseServerConfig } from '../src/config.js'

describe('parsePackages', () => {
  it('strips the package: prefix, dedupes and sorts', () => {
    const raw = 'package:com.b.app\npackage:com.a.app\npackage:com.b.app\n'
    expect(parsePackages(raw)).toEqual(['com.a.app', 'com.b.app'])
  })

  it('ignores blank and non-package lines', () => {
    const raw = '\nList of things\npackage:com.only.one\n   \n'
    expect(parsePackages(raw)).toEqual(['com.only.one'])
  })

  it('returns [] for empty input', () => {
    expect(parsePackages('')).toEqual([])
  })
})

describe('parseBounds', () => {
  it('computes the centre point', () => {
    expect(parseBounds('[0,0][100,50]')).toEqual({ x: 50, y: 25 })
  })

  it('rounds the centre', () => {
    expect(parseBounds('[0,0][101,51]')).toEqual({ x: 51, y: 26 })
  })

  it('returns null on malformed bounds', () => {
    expect(parseBounds('not-bounds')).toBeNull()
    expect(parseBounds('[0,0]')).toBeNull()
  })
})

describe('parseUiLayout', () => {
  it('extracts clickable and labelled nodes with centre coordinates', () => {
    const xml = `<?xml version='1.0'?><hierarchy>
      <node class="android.widget.FrameLayout" clickable="false" text="" content-desc="" bounds="[0,0][1080,2400]"/>
      <node class="android.widget.Button" clickable="true" text="OK" content-desc="" bounds="[0,0][100,100]"/>
      <node class="android.widget.TextView" clickable="false" text="Hello" content-desc="" bounds="[10,10][110,110]"/>
      <node class="android.widget.ImageView" clickable="true" text="" content-desc="Menu" bounds="[200,0][300,100]"/>
    </hierarchy>`
    const els = parseUiLayout(xml)
    expect(els).toHaveLength(3)
    expect(els[0]).toMatchObject({
      text: 'OK',
      className: 'android.widget.Button',
      center: { x: 50, y: 50 }
    })
    expect(els[1]).toMatchObject({ text: 'Hello', center: { x: 60, y: 60 } })
    expect(els[2]).toMatchObject({ description: 'Menu', center: { x: 250, y: 50 } })
  })

  it('skips interesting nodes that have no parseable bounds', () => {
    const xml = '<node clickable="true" text="X" bounds="garbage"/>'
    expect(parseUiLayout(xml)).toEqual([])
  })

  it('decodes XML entities in attribute values', () => {
    const xml = '<node clickable="true" text="Save &amp; Exit" bounds="[0,0][10,10]"/>'
    expect(parseUiLayout(xml)[0]?.text).toBe('Save & Exit')
  })

  it('returns [] on an empty dump', () => {
    expect(parseUiLayout('')).toEqual([])
  })
})

describe('parseActionIntents', () => {
  it('extracts action names from the Non-Data Actions section', () => {
    const dumpsys = `
Activity Resolver Table:
  Full MIME Types:
      text/plain:
        com.example/.ShareActivity
  Non-Data Actions:
      android.intent.action.MAIN:
        com.example/.MainActivity
      android.intent.action.VIEW:
        com.example/.ViewActivity
  Receiver Resolver Table:
      android.intent.action.BOOT_COMPLETED:
        com.example/.BootReceiver
`
    // The receiver-table action is in a different section and must not leak in.
    expect(parseActionIntents(dumpsys)).toEqual([
      'android.intent.action.MAIN',
      'android.intent.action.VIEW'
    ])
  })

  it('returns [] when there is no Non-Data Actions section', () => {
    expect(parseActionIntents('Some other dumpsys output\n')).toEqual([])
  })

  it('dedupes repeated actions', () => {
    const dumpsys = `  Non-Data Actions:
      android.intent.action.MAIN:
        a/.A
      android.intent.action.MAIN:
        b/.B
`
    expect(parseActionIntents(dumpsys)).toEqual(['android.intent.action.MAIN'])
  })
})

describe('resolveDeviceArgs', () => {
  const oneDevice = 'List of devices attached\nemulator-5554\tdevice\n'
  const twoDevices = 'List of devices attached\nemulator-5554\tdevice\nABC123\tdevice\n'
  const withOffline = 'List of devices attached\nABC123\toffline\nemulator-5554\tdevice\n'

  it('auto-picks the single online device', () => {
    expect(resolveDeviceArgs(oneDevice)).toEqual({ serial: 'emulator-5554' })
  })

  it('uses the requested serial when it is online', () => {
    expect(resolveDeviceArgs(twoDevices, 'ABC123')).toEqual({ serial: 'ABC123' })
  })

  it('errors when the requested serial is not connected', () => {
    const res = resolveDeviceArgs(oneDevice, 'NOPE')
    expect(res).toHaveProperty('error')
    if ('error' in res) expect(res.error).toContain('NOPE')
  })

  it('errors and lists devices when multiple are connected and none requested', () => {
    const res = resolveDeviceArgs(twoDevices)
    expect(res).toHaveProperty('error')
    if ('error' in res) {
      expect(res.error).toContain('emulator-5554')
      expect(res.error).toContain('ABC123')
    }
  })

  it('errors when no online device is present, surfacing offline ones', () => {
    const res = resolveDeviceArgs('List of devices attached\nABC123\toffline\n')
    expect(res).toHaveProperty('error')
    if ('error' in res) expect(res.error).toContain('offline')
  })

  it('ignores offline devices when exactly one is online', () => {
    expect(resolveDeviceArgs(withOffline)).toEqual({ serial: 'emulator-5554' })
  })
})

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('shell ls /sdcard')).toEqual(['shell', 'ls', '/sdcard'])
  })

  it('keeps double-quoted groups together and strips the quotes', () => {
    expect(tokenizeCommand('shell "pm list packages"')).toEqual(['shell', 'pm list packages'])
  })

  it('handles single quotes', () => {
    expect(tokenizeCommand("shell 'am start -n com.x/.Main'")).toEqual([
      'shell',
      'am start -n com.x/.Main'
    ])
  })

  it('returns [] for a blank command', () => {
    expect(tokenizeCommand('   ')).toEqual([])
  })
})

describe('withSerial', () => {
  it('prefixes -s <serial> when a serial is given', () => {
    expect(withSerial('ABC', ['shell', 'ls'])).toEqual(['-s', 'ABC', 'shell', 'ls'])
  })

  it('leaves args untouched with no serial', () => {
    expect(withSerial(undefined, ['devices'])).toEqual(['devices'])
  })
})

describe('parseServerConfig', () => {
  it('reads --serial <x>', () => {
    expect(parseServerConfig(['--serial', 'ABC123'])).toEqual({ serial: 'ABC123' })
  })

  it('reads --serial=x', () => {
    expect(parseServerConfig(['--serial=ABC123'])).toEqual({ serial: 'ABC123' })
  })

  it('is empty when nothing is passed and no env is set', () => {
    const saved = process.env.ANDROID_ADB_SERIAL
    delete process.env.ANDROID_ADB_SERIAL
    try {
      expect(parseServerConfig([])).toEqual({})
    } finally {
      if (saved !== undefined) process.env.ANDROID_ADB_SERIAL = saved
    }
  })

  it('falls back to ANDROID_ADB_SERIAL', () => {
    const saved = process.env.ANDROID_ADB_SERIAL
    process.env.ANDROID_ADB_SERIAL = 'ENVSERIAL'
    try {
      expect(parseServerConfig([])).toEqual({ serial: 'ENVSERIAL' })
    } finally {
      if (saved === undefined) delete process.env.ANDROID_ADB_SERIAL
      else process.env.ANDROID_ADB_SERIAL = saved
    }
  })
})
