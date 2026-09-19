/**
 * What the `npx` runner has, and what the registry offers.
 *
 * A generated launcher starts the harness with `npx -y @deepseek-ai/dsh`, which
 * resolves the published version on every run rather than pinning one. So the
 * interesting question is not "is it up to date" — it always is — but "will the
 * next start spend its time downloading", and that is answered by comparing the
 * version npx has cached with the version the registry now publishes.
 *
 * Reading the cache is local and cheap. Asking the registry is a network call,
 * so it happens only when a caller asks for it.
 *
 * @module dsh-launch-in-one-click/npx
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './run.js'
import { compareVersions } from './versions.js'

/** The default npm cache location on Windows; a relocated cache reads as unknown. */
export function defaultNpxCacheRoot(env = process.env) {
  const local = env.LOCALAPPDATA
  if (typeof local !== 'string' || local.length === 0) return null
  return join(local, 'npm-cache', '_npx')
}

/**
 * The package name inside an npm spec: `@scope/name@1.2.3` becomes `@scope/name`.
 * @param spec - a package spec.
 * @returns The package name.
 */
export function packageNameOf(spec) {
  const text = String(spec ?? '').trim()
  const at = text.lastIndexOf('@')
  return at > 0 ? text.slice(0, at) : text
}

/**
 * The newest version of a package that npx has already unpacked.
 * @param packageSpec - package name, with an optional version.
 * @param options - environment and cache-root overrides.
 * @returns The version, or `null` when nothing is cached there.
 */
export function readCachedHarnessVersion(packageSpec, options = {}) {
  const {
    env = process.env,
    cacheRoot = defaultNpxCacheRoot(env),
    readDirectory = readdirSync,
    readFile = readFileSync,
  } = options
  if (cacheRoot === null) return null

  let entries
  try {
    entries = readDirectory(cacheRoot)
  } catch {
    return null
  }

  const manifest = join('node_modules', ...packageNameOf(packageSpec).split('/'), 'package.json')
  let newest = null
  for (const entry of entries) {
    let version
    try {
      version = JSON.parse(readFile(join(cacheRoot, entry, manifest), 'utf8')).version
    } catch {
      continue
    }
    if (typeof version !== 'string') continue
    if (newest === null || compareVersions(version, newest) === 1) newest = version
  }
  return newest
}

/**
 * The version the registry publishes for a package.
 * @param packageSpec - package name, with an optional version.
 * @param options - runner, environment, abort signal, and timeout.
 * @returns The published version, or `null` when the registry cannot be asked.
 */
export async function fetchPublishedHarnessVersion(packageSpec, options = {}) {
  const { run = runCommand, env = process.env, signal, timeoutMs = 20000 } = options
  const result = await run('npm', ['view', packageSpec, 'version'], {
    env,
    signal,
    timeoutMs,
    decode: (buffer) => buffer.toString('utf8'),
  })
  if (result.failure !== undefined || result.code !== 0) return null
  // `npm view` prints the newest matching version, or one line per match when a
  // spec matches several; the last line is the newest.
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.length === 0 ? null : lines[lines.length - 1].replace(/^['"]|['"]$/g, '')
}
