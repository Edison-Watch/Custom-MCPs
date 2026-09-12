/**
 * Launch-time configuration for the android-adb-mcp server. Kept in its own
 * side-effect-free module so tests can import it without running `index.ts`
 * (which opens a stdio transport on import).
 */

/** Server-level launch config resolved once from argv / env. */
export interface ServerConfig {
  /** Preferred device serial for a multi-device host, or undefined to auto-pick. */
  serial?: string
}

/** Parse `--serial <x>` / `--serial=x` from argv, falling back to the env var. */
export function parseServerConfig(argv: string[]): ServerConfig {
  const config: ServerConfig = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--serial') config.serial = argv[++i]
    else if (arg.startsWith('--serial=')) config.serial = arg.slice('--serial='.length)
  }
  if (!config.serial && process.env.ANDROID_ADB_SERIAL) {
    config.serial = process.env.ANDROID_ADB_SERIAL
  }
  if (config.serial !== undefined && config.serial.trim() === '') delete config.serial
  return config
}
