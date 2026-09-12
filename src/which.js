/**
 * PATH lookup, implemented rather than shelled out so it stays testable and so
 * a launcher verdict never depends on a localized `where.exe` transcript.
 *
 * The extension order matters on Windows: `C:\Program Files\nodejs` ships
 * `npx`, `npx.cmd`, AND `npx.ps1`. The extensionless `npx` is a POSIX shell
 * script that `cmd.exe` cannot run, so PATHEXT candidates are tried first and
 * the bare name last — the same order `cmd.exe` itself uses for an
 * extensionless command.
 *
 * @module dsh-launch-in-one-click/which
 */

import { realpathSync, statSync } from 'node:fs'

/** Fallback used when PATH itself is unset or empty. */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

/**
 * Read the executable extensions for a Windows host.
 * @param options - platform and environment overrides.
 * @returns Extension list without the empty entry; `['']` on POSIX.
 */
export function pathExtensions(options = {}) {
  const { platform = process.platform, env = process.env } = options
  if (platform !== 'win32') return ['']
  const raw = typeof env.PATHEXT === 'string' && env.PATHEXT.length > 0 ? env.PATHEXT : DEFAULT_PATHEXT.join(';')
  const parsed = raw.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  return parsed.length > 0 ? parsed : DEFAULT_PATHEXT
}

/**
 * Split a PATH value into directories, dropping blanks and unquoting entries
 * (a quoted PATH entry is legal and appears on real machines).
 * @param value - the raw PATH value.
 * @param platform - target platform, which selects the separator.
 * @returns Directory list in search order.
 */
export function splitPath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) return []
  const separator = platform === 'win32' ? ';' : ':'
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .map((entry) => (entry.length > 1 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
    .filter((entry) => entry.length > 0)
}

/** Default existence probe: a regular file (not a directory) at the path. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a hit to its on-disk name. Candidates are constructed from PATHEXT,
 * which is normally upper case, so without this a diagnostic would report
 * `node.EXE` for a file named `node.exe`. Canonicalizing also makes the result
 * usable on a directory with per-directory case sensitivity enabled.
 */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Resolve a command name to an absolute file path.
 * @param name - command name, with or without an extension; a name containing a
 *   path separator is probed as a path and never searched on PATH.
 * @param options - platform, environment, and file-probe overrides.
 * @returns The resolved path, or `null` when nothing matches.
 */
export function resolveExecutable(name, options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    isFile: probe = isFile,
    canonicalize = canonical,
  } = options
  if (typeof name !== 'string' || name.length === 0) return null

  const extensions = platform === 'win32' ? [...pathExtensions({ platform, env }), ''] : ['']
  const separator = platform === 'win32' ? '\\' : '/'
  const hasSeparator = /[\\/]/.test(name)
  const directories = hasSeparator ? [''] : splitPath(env.PATH ?? env.Path ?? '', platform)

  for (const directory of directories) {
    // Joined by hand rather than with `path.join`: this function simulates a
    // platform, and the host's separator is not necessarily that platform's.
    const prefix = directory === '' ? '' : `${directory.replace(/[\\/]+$/, '')}${separator}`
    for (const extension of extensions) {
      const candidate = `${prefix}${name}${extension}`
      if (probe(candidate)) return canonicalize(candidate)
    }
  }
  return null
}
