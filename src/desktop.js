/**
 * Finding the user's Desktop the way Windows defines it.
 *
 * `%USERPROFILE%\Desktop` is the common answer and the wrong one on any machine
 * where the shell folder was redirected — OneDrive's "Back up your folders"
 * moves it to `%USERPROFILE%\OneDrive\Desktop`, and the name may be localized
 * ("桌面"). Installers that hardcode the path quietly write to a folder nobody
 * looks at.
 *
 * Three sources are tried in order of authority: the shell's own known-folder
 * API, then the two registry keys that back it, then the conventional path. A
 * source that yields a directory which does not exist is not an answer, so a
 * mis-decoded or stale value falls through to the next one instead of becoming
 * a failure.
 *
 * @module dsh-launch-in-one-click/desktop
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './run.js'

/** Registry keys that hold the shell folder table, most authoritative first. */
const SHELL_FOLDER_KEYS = Object.freeze([
  ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'REG_EXPAND_SZ'],
  ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'REG_SZ'],
])

/**
 * Expand `%NAME%` references against an environment.
 * @param value - raw value, possibly containing references.
 * @param env - environment to resolve against.
 * @returns The expanded value; an unknown name is left untouched.
 */
export function expandEnvVars(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => {
    if (Object.hasOwn(env, name)) return env[name]
    const upper = name.toUpperCase()
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === upper) return env[key]
    }
    return match
  })
}

/**
 * Read one value out of `reg query` output.
 * @param text - reg stdout.
 * @param valueName - the value to read, usually `Desktop`.
 * @returns The raw value, or `null` when absent.
 */
export function parseRegQueryValue(text, valueName = 'Desktop') {
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'im')
  const match = pattern.exec(String(text ?? ''))
  if (match === null) return null
  const value = match[1]
  return value.length > 0 ? value : null
}

/** Strip a UTF-8 BOM and surrounding whitespace from a captured path. */
function cleanPath(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim()
}

/** Default directory probe. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the Desktop directory.
 * @param options - environment, runner, decoder, abort signal, and injected probe.
 * @returns The resolved directory, its source, and every candidate considered.
 */
export async function resolveDesktopDirectory(options = {}) {
  const {
    env = process.env,
    run = runCommand,
    signal,
    decode,
    platform = process.platform,
    isDirectory: directoryProbe = isDirectory,
    powershellPath = defaultPowerShellPath(env),
  } = options

  const candidates = []

  const accept = (path, source) => {
    const clean = cleanPath(path)
    if (clean.length === 0) {
      candidates.push({ source, path: null, reason: 'empty' })
      return null
    }
    if (!directoryProbe(clean)) {
      candidates.push({ source, path: clean, reason: 'missing' })
      return null
    }
    candidates.push({ source, path: clean, reason: 'ok' })
    return { path: clean, source, candidates }
  }

  if (platform === 'win32') {
    const knownFolder = await run(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"],
      { env, signal, decode: (buffer) => buffer.toString('utf8') },
    )
    if (knownFolder.failure === undefined && knownFolder.code === 0) {
      const accepted = accept(knownFolder.stdout, 'known-folder')
      if (accepted !== null) return accepted
    } else {
      candidates.push({ source: 'known-folder', path: null, reason: knownFolder.failure ?? `exit:${String(knownFolder.code)}` })
    }
  }

  if (platform === 'win32') {
    for (const [key, expectedType] of SHELL_FOLDER_KEYS) {
      const source = expectedType === 'REG_EXPAND_SZ' ? 'registry-expand' : 'registry'
      const query = await run('reg', ['query', key, '/v', 'Desktop'], { env, signal, decode })
      if (query.failure !== undefined || query.code !== 0) {
        candidates.push({ source, path: null, reason: query.failure ?? `exit:${String(query.code)}` })
        continue
      }
      const raw = parseRegQueryValue(query.stdout)
      if (raw === null) {
        candidates.push({ source, path: null, reason: 'value-not-found' })
        continue
      }
      const accepted = accept(expandEnvVars(raw, env), source)
      if (accepted !== null) return accepted
    }
  }

  const userProfile = env.USERPROFILE ?? env.HOME
  if (typeof userProfile === 'string' && userProfile.length > 0) {
    const accepted = accept(join(userProfile, 'Desktop'), 'userprofile')
    if (accepted !== null) return accepted
  } else {
    candidates.push({ source: 'userprofile', path: null, reason: 'unset' })
  }

  return { path: null, source: null, candidates }
}

/**
 * Absolute path to Windows PowerShell, which exists on every supported Windows
 * even when PATH was trimmed to nothing.
 * @param env - environment carrying SystemRoot.
 * @returns The executable path to try.
 */
export function defaultPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot ?? env.windir
  if (typeof systemRoot === 'string' && systemRoot.length > 0) {
    return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return 'powershell.exe'
}
