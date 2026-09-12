/**
 * Installing, verifying, and removing a one-click launcher.
 *
 * The install is a small state machine with an explicit refusal at every step
 * that could destroy something:
 *
 * - a file this plugin did not write is never overwritten without consent, and
 *   never overwritten without a backup when consent is given;
 * - identical content is left alone rather than rewritten under a running user;
 * - the write is atomic, the result is re-read and hashed, and a verification
 *   failure restores the backup instead of leaving a broken shortcut;
 * - the launcher is then executed once in dry-run mode, which proves the file
 *   parses, reaches its own port logic, and can be run by this machine, a
 *   check no amount of unit testing on the generator can replace.
 *
 * @module dsh-launch-in-one-click/install
 */

import { basename, join } from 'node:path'
import {
  REAL_FS, errorCode, hashBytes, probeWritableDirectory, readFileBytes, removeQuietly, writeFileAtomic,
} from './atomic.js'
import { readLauncherMarker, renderLauncher, toCrlf } from './bat-template.js'
import { resolveDesktopDirectory } from './desktop.js'
import { UTF8_CODE_PAGE, detectLauncherCodePage, encodeForCodePage, makeDecoder } from './encoding.js'
import { EXIT, describeExitCode } from './exit-codes.js'
import { runPortProbe } from './probe.js'
import { runCommand } from './run.js'
import {
  checkDirectory, checkFileName, checkLanguage, checkPackageSpec, checkPort, checkRunner, checkWorkdir,
} from './validate.js'

/** Plugin version recorded in every generated launcher. */
export const PLUGIN_VERSION = '1.0.0'

/** Default launcher name per resolved language. */
const DEFAULT_FILE_NAMES = Object.freeze({ zh: '启动 DeepSeek Harness.bat', en: 'Launch DeepSeek Harness.bat' })

/** Code pages that justify Chinese text under `language: auto`. */
const CHINESE_CODE_PAGES = new Set([936, 950])

/** Exit codes that prove a launcher ran correctly in dry-run mode. */
const VERIFIED_DRY_RUN_CODES = new Set([EXIT.OK, EXIT.PORT_DSH, EXIT.PORT_FOREIGN])

/** Default dependencies, each replaceable by tests. */
function defaultDeps() {
  return {
    fs: REAL_FS,
    run: runCommand,
    now: () => new Date(),
    detectLauncherCodePage,
    resolveDesktopDirectory,
    runPortProbe,
    writeFileAtomic,
    probeWritableDirectory,
    readFileBytes,
    hashBytes,
    removeQuietly,
    verifyLauncherByRunning,
  }
}

/**
 * Resolve the language a launcher is written in.
 * @param requested - `auto`, `en`, or `zh`.
 * @param codePage - the console code page the file will be read in.
 * @returns The concrete language.
 */
function resolveLanguage(requested, codePage) {
  if (requested !== 'auto') return requested
  return codePage !== null && CHINESE_CODE_PAGES.has(codePage) ? 'zh' : 'en'
}

/** Render a thrown filesystem error for a result hint. */
function failureDetail(error) {
  const code = failureDetail(error)
  if (code !== 'unknown') return code
  return error instanceof Error ? error.message : String(error)
}

/** Build one failure result. */
function failure(reason, hint, extra = {}) {
  return {
    ok: false,
    reason,
    hint,
    path: null,
    directory: null,
    fileName: null,
    bytes: 0,
    encoding: null,
    codePage: null,
    language: null,
    workdir: null,
    port: null,
    runner: null,
    replaced: false,
    unchanged: false,
    backupPath: null,
    verified: false,
    verification: null,
    portState: null,
    warnings: [],
    existing: 'none',
    ...extra,
  }
}

/** Build one success-shaped result. */
function success(fields) {
  return {
    ok: true,
    reason: null,
    hint: null,
    path: null,
    directory: null,
    fileName: null,
    bytes: 0,
    encoding: null,
    codePage: null,
    language: null,
    workdir: null,
    port: null,
    runner: null,
    replaced: false,
    unchanged: false,
    backupPath: null,
    verified: false,
    verification: null,
    portState: null,
    warnings: [],
    existing: 'none',
    ...fields,
  }
}

/**
 * Compose launcher text, choosing an encoding that can actually carry it.
 *
 * The language is already settled before this runs: `auto` resolved it from the
 * console code page, and an explicit choice is the caller's. What is left is
 * the encoding, and there is exactly one problem it can hit — a VALUE with no
 * representation in the console code page. In practice that is the work
 * directory, which is the user's own profile path and not something they can
 * change, and English does not fix a path. So the file switches itself to UTF-8
 * and tells cmd so with its own `chcp`, which can carry every path Windows
 * allows.
 *
 * A launcher produced that way is still verified by execution before the
 * install is reported successful, so an encoding this machine cannot actually
 * parse fails the install instead of shipping.
 *
 * @param spec - everything the template needs except the language.
 * @param language - the resolved language.
 * @param codePage - the console code page to prefer.
 * @returns The text, its encoding, the code page it targets, and warnings.
 */
function composeLauncher(spec, language, codePage) {
  const warnings = []
  const nativeText = toCrlf(renderLauncher({ ...spec, language, codePage }))
  const native = encodeForCodePage(nativeText, codePage)
  if (native.lossless) return { text: nativeText, encoded: native, language, codePage, warnings }

  if (codePage !== UTF8_CODE_PAGE) {
    const utf8Text = toCrlf(renderLauncher({ ...spec, language, codePage: UTF8_CODE_PAGE }))
    const utf8 = encodeForCodePage(utf8Text, UTF8_CODE_PAGE)
    if (utf8.lossless) {
      warnings.push(
        `the console code page ${String(codePage)} cannot carry the target path or name (${String(native.reason)}); `
        + 'the launcher switches itself to UTF-8 instead',
      )
      return { text: utf8Text, encoded: utf8, language, codePage: UTF8_CODE_PAGE, warnings }
    }
  }

  return { text: nativeText, encoded: native, language, codePage, warnings }
}

/**
 * Run a written launcher in dry-run mode and judge whether it works.
 * @param path - launcher path.
 * @param options - runner, environment, timeout, and verbatim-argument control.
 * @returns The exit code, output, and whether the run proves the file is sound.
 */
export async function verifyLauncherByRunning(path, options = {}) {
  const {
    run = runCommand,
    env = process.env,
    signal,
    timeoutMs = 30000,
    platform = process.platform,
    decode = (buffer) => buffer.toString('utf8'),
  } = options
  if (platform !== 'win32') return { ran: false, exitCode: null, output: '', ok: false, reason: 'not-windows' }

  // `windowsVerbatimArguments` keeps cmd from re-quoting a path that contains
  // spaces: the outer pair is what cmd strips, the inner pair is the path.
  const result = await run('cmd', ['/c', `""${path}" --dry-run"`], {
    env,
    signal,
    timeoutMs,
    windowsVerbatimArguments: true,
    decode,
  })

  if (result.failure !== undefined) {
    return { ran: false, exitCode: null, output: result.stderr ?? '', ok: false, reason: result.failure }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    ran: true,
    exitCode: result.code,
    output,
    ok: result.code !== null && VERIFIED_DRY_RUN_CODES.has(result.code),
    reason: result.code !== null && VERIFIED_DRY_RUN_CODES.has(result.code) ? null : describeExitCode(result.code),
  }
}

/**
 * Install one launcher.
 * @param options - requested settings; every field is optional.
 * @param overrides - dependency overrides for tests.
 * @returns A structured result describing what was written, or why nothing was.
 */
export async function installLauncher(options = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const {
    port = 3080,
    workdir = process.cwd(),
    runner = 'npx',
    packageSpec = '@deepseek-ai/dsh',
    language = 'auto',
    openBrowser = true,
    directory,
    fileName,
    overwrite = false,
    force = false,
    dryRun = false,
    probePort = true,
    verify = 'run',
    signal,
    env = process.env,
    platform = process.platform,
  } = options

  // Checked before the option rules, so a non-Windows host is told the real
  // reason rather than a path-shape complaint about a Windows path.
  if (platform !== 'win32') {
    return failure(
      'unsupported-platform',
      'A one-click launcher for DeepSeek Harness is a Windows batch file; this host is not Windows.',
    )
  }

  const portCheck = checkPort(port)
  if (!portCheck.ok) return failure(portCheck.reason, portCheck.hint)
  const workdirCheck = checkWorkdir(workdir, platform)
  if (!workdirCheck.ok) return failure(workdirCheck.reason, workdirCheck.hint)
  const runnerCheck = checkRunner(runner)
  if (!runnerCheck.ok) return failure(runnerCheck.reason, runnerCheck.hint)
  const packageCheck = checkPackageSpec(packageSpec)
  if (!packageCheck.ok) return failure(packageCheck.reason, packageCheck.hint)
  const languageCheck = checkLanguage(language)
  if (!languageCheck.ok) return failure(languageCheck.reason, languageCheck.hint)
  if (directory !== undefined) {
    const directoryCheck = checkDirectory(directory)
    if (!directoryCheck.ok) return failure(directoryCheck.reason, directoryCheck.hint)
  }

  const detected = await deps.detectLauncherCodePage({ run: deps.run, env, signal, platform })
  if (detected.codePage === null) {
    return failure(
      'code-page-unknown',
      'The console code page could not be determined, so the launcher text cannot be encoded safely.',
    )
  }
  const codePage = detected.codePage
  const resolvedLanguage = resolveLanguage(languageCheck.value, codePage)

  let targetDirectory = directory
  let directorySource = 'argument'
  if (targetDirectory === undefined) {
    const desktop = await deps.resolveDesktopDirectory({ run: deps.run, env, signal, platform })
    if (desktop.path === null) {
      return failure(
        'desktop-not-found',
        'The Desktop folder could not be resolved; pass an explicit directory.',
        { warnings: [`desktop candidates: ${JSON.stringify(desktop.candidates)}`] },
      )
    }
    targetDirectory = desktop.path
    directorySource = desktop.source
  }

  const writable = await deps.probeWritableDirectory(targetDirectory, { signal })
  if (!writable.writable) {
    return failure(
      'directory-not-writable',
      `The directory ${targetDirectory} cannot be written (${writable.reason}).`,
      { directory: targetDirectory },
    )
  }

  const resolvedName = fileName ?? DEFAULT_FILE_NAMES[resolvedLanguage]
  const nameCheck = checkFileName(resolvedName)
  if (!nameCheck.ok) return failure(nameCheck.reason, nameCheck.hint, { directory: targetDirectory })

  const targetPath = join(targetDirectory, nameCheck.value)
  const existingBytes = deps.readFileBytes(targetPath, deps.fs)
  const existingText = existingBytes === null ? null : existingBytes.toString('latin1')
  const existingMarker = existingText === null ? { owned: false, version: null, config: null } : readLauncherMarker(existingText)
  const existing = existingBytes === null ? 'none' : existingMarker.owned ? 'ours' : 'foreign'

  if (existing === 'foreign' && overwrite !== true) {
    return failure(
      'file-not-ours',
      `${targetPath} already exists and was not written by this plugin; pass overwrite to replace it, which keeps a backup.`,
      { path: targetPath, directory: targetDirectory, fileName: nameCheck.value, existing },
    )
  }

  const generatedAt = deps.now().toISOString()
  const spec = {
    version: PLUGIN_VERSION,
    port: portCheck.value,
    workdir: workdirCheck.value,
    runner: runnerCheck.value,
    packageSpec: packageCheck.value,
    openBrowser,
    codePage,
    generatedAt,
    fileName: nameCheck.value,
  }

  const composed = composeLauncher(spec, resolvedLanguage, codePage)
  if (!composed.encoded.lossless) {
    return failure(
      'encoding-failed',
      composed.encoded.reason === 'cmd-metacharacter-trail-byte'
        ? 'A character in the target path or name encodes to a byte pair cmd.exe would treat as syntax.'
        : `The launcher text cannot be encoded into code page ${String(codePage)} or UTF-8 (${String(composed.encoded.reason)}).`,
      { directory: targetDirectory, fileName: nameCheck.value, codePage },
    )
  }

  const bytes = Buffer.from(composed.encoded.bytes)
  const warnings = [...composed.warnings]
  const launcherCodePage = composed.codePage

  const identical = existingBytes !== null && isSameLauncher(existingBytes, existingMarker, composed.text, bytes)
  if (identical && force !== true) {
    return success({
      path: targetPath,
      directory: targetDirectory,
      directorySource,
      fileName: nameCheck.value,
      bytes: bytes.length,
      encoding: composed.encoded.encoding,
      codePage: launcherCodePage,
      language: composed.language,
      workdir: workdirCheck.value,
      port: portCheck.value,
      runner: runnerCheck.value,
      unchanged: true,
      existing,
      verified: true,
      verification: { ran: false, exitCode: null, output: '', ok: true, reason: 'unchanged' },
      warnings: [...warnings, 'the launcher is already up to date; nothing was written'],
    })
  }

  let portState = null
  if (probePort) {
    const probe = await deps.runPortProbe(portCheck.value, { run: deps.run, env, signal, platform })
    portState = probe.state
    if (probe.state === 'dsh') {
      warnings.push(`port ${String(portCheck.value)} currently serves a Harness instance; the launcher will refuse to start until that one is closed`)
    } else if (probe.state === 'foreign') {
      warnings.push(`port ${String(portCheck.value)} is currently held by another program (${probe.detail})`)
    } else if (probe.state === 'error') {
      warnings.push(`the port preflight could not reach a verdict (${probe.detail})`)
    }
  }

  if (dryRun) {
    return success({
      path: targetPath,
      directory: targetDirectory,
      directorySource,
      fileName: nameCheck.value,
      bytes: bytes.length,
      encoding: composed.encoded.encoding,
      codePage: launcherCodePage,
      language: composed.language,
      workdir: workdirCheck.value,
      port: portCheck.value,
      runner: runnerCheck.value,
      existing,
      portState,
      warnings: [...warnings, 'dry run: nothing was written'],
    })
  }

  let backupPath = null
  if (existingBytes !== null) {
    backupPath = `${targetPath}.${generatedAt.replace(/[:.]/g, '-')}.bak`
    try {
      await deps.writeFileAtomic(backupPath, existingBytes, { fs: deps.fs })
    } catch (error) {
      return failure('backup-failed', `Could not write the backup ${backupPath}: ${failureDetail(error)}`, {
        path: targetPath, directory: targetDirectory, fileName: nameCheck.value, existing,
      })
    }
  }

  try {
    await deps.writeFileAtomic(targetPath, bytes, { fs: deps.fs, signal })
  } catch (error) {
    return failure('write-failed', `Could not write ${targetPath}: ${failureDetail(error)}`, {
      path: targetPath, directory: targetDirectory, fileName: nameCheck.value, existing, backupPath,
    })
  }

  const written = deps.readFileBytes(targetPath, deps.fs)
  if (written === null || Buffer.compare(written, bytes) !== 0) {
    restoreBackup(deps, backupPath, targetPath)
    return failure('verify-failed', 'The written launcher did not match the intended bytes; the previous file was restored.', {
      path: targetPath, directory: targetDirectory, fileName: nameCheck.value, existing,
    })
  }

  let verification = { ran: false, exitCode: null, output: '', ok: true, reason: 'skipped' }
  if (verify === 'run') {
    verification = await deps.verifyLauncherByRunning(targetPath, {
      run: deps.run,
      env,
      signal,
      platform,
      decode: makeDecoder(launcherCodePage),
    })
    if (!verification.ok) {
      restoreBackup(deps, backupPath, targetPath)
      return failure(
        'launcher-verification-failed',
        `The launcher was written but failed its dry-run self-test (${String(verification.reason)}); the previous file was restored.`,
        {
          path: targetPath,
          directory: targetDirectory,
          fileName: nameCheck.value,
          existing,
          verification,
          warnings,
        },
      )
    }
  }

  return success({
    path: targetPath,
    directory: targetDirectory,
    directorySource,
    fileName: nameCheck.value,
    bytes: bytes.length,
    encoding: composed.encoded.encoding,
    codePage: launcherCodePage,
    language: composed.language,
    workdir: workdirCheck.value,
    port: portCheck.value,
    runner: runnerCheck.value,
    replaced: existingBytes !== null,
    backupPath,
    existing,
    portState,
    verified: verify === 'run' ? verification.ok : true,
    verification,
    warnings,
  })
}

/**
 * Decide whether an installed launcher already says what this install would
 * write.
 *
 * The generation timestamp changes on every render by design, so a byte
 * comparison alone would report every install as a change — and rewrite a file
 * under a user who double-clicks it. The comparison therefore ignores that one
 * field, and `force` remains the way to refresh it.
 *
 * @param existingBytes - the file on disk.
 * @param marker - the marker parsed from it.
 * @param newText - the text this install would write.
 * @param newBytes - the encoded bytes of that text.
 * @returns True when the installed launcher is already current.
 */
function isSameLauncher(existingBytes, marker, newText, newBytes) {
  if (Buffer.compare(existingBytes, newBytes) === 0) return true
  if (!marker.owned) return false
  const recordedCodePage = Number(marker.config?.cp)
  const decode = makeDecoder(Number.isInteger(recordedCodePage) && recordedCodePage > 0 ? recordedCodePage : null)
  return stripTimestamp(decode(existingBytes)) === stripTimestamp(newText)
}

/** Replace the generation timestamp with a placeholder. */
function stripTimestamp(text) {
  return text.replace(/ generated=\S+/, ' generated=<timestamp>')
}

/** Restore a backup over a path that failed verification. */
function restoreBackup(deps, backupPath, targetPath) {
  if (backupPath === null) {
    deps.removeQuietly(targetPath, deps.fs)
    return
  }
  const bytes = deps.readFileBytes(backupPath, deps.fs)
  if (bytes === null) return
  try {
    deps.writeFileAtomic(targetPath, bytes, { fs: deps.fs })
  } catch {
    /* the failure result already reports the state; a second failure adds nothing */
  }
}

/**
 * Remove a launcher this plugin wrote.
 * @param options - target directory, file name, or an explicit path, plus force.
 * @param overrides - dependency overrides for tests.
 * @returns A structured result describing what was removed, or why nothing was.
 */
export async function uninstallLauncher(options = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const { path, directory, fileName, force = false, env = process.env, platform = process.platform } = options

  if (platform !== 'win32') {
    return { ok: false, reason: 'unsupported-platform', hint: 'This plugin installs Windows launchers only.', path: null, removed: false, existing: 'none' }
  }

  let target = path
  if (target === undefined) {
    let targetDirectory = directory
    if (targetDirectory === undefined) {
      const desktop = await deps.resolveDesktopDirectory({ run: deps.run, env, platform })
      if (desktop.path === null) {
        return { ok: false, reason: 'desktop-not-found', hint: 'Pass the directory or path explicitly.', path: null, removed: false, existing: 'none' }
      }
      targetDirectory = desktop.path
    }
    const name = fileName ?? DEFAULT_FILE_NAMES.zh
    target = join(targetDirectory, basename(name))
  }

  const bytes = deps.readFileBytes(target, deps.fs)
  if (bytes === null) {
    return { ok: true, reason: null, hint: null, path: target, removed: false, existing: 'none' }
  }
  const marker = readLauncherMarker(bytes.toString('latin1'))
  if (!marker.owned && force !== true) {
    return {
      ok: false,
      reason: 'file-not-ours',
      hint: `${target} was not written by this plugin; pass force to delete it anyway.`,
      path: target,
      removed: false,
      existing: 'foreign',
    }
  }
  try {
    deps.removeQuietly(target, deps.fs)
  } catch (error) {
    return { ok: false, reason: 'remove-failed', hint: `${target}: ${failureDetail(error)}`, path: target, removed: false, existing: marker.owned ? 'ours' : 'foreign' }
  }
  const gone = deps.readFileBytes(target, deps.fs) === null
  return {
    ok: gone,
    reason: gone ? null : 'remove-failed',
    hint: gone ? null : `${target} still exists after the delete.`,
    path: target,
    removed: gone,
    existing: marker.owned ? 'ours' : 'foreign',
  }
}

/**
 * Inspect an installed launcher without changing it.
 * @param path - launcher path.
 * @param overrides - dependency overrides for tests.
 * @returns Ownership, recorded config, and whether the bytes match a fresh render.
 */
export function inspectLauncher(path, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const bytes = deps.readFileBytes(path, deps.fs)
  if (bytes === null) return { exists: false, owned: false, version: null, config: null, bytes: 0, sha256: null, path }
  const marker = readLauncherMarker(bytes.toString('latin1'))
  return {
    exists: true,
    owned: marker.owned,
    version: marker.version,
    config: marker.config,
    bytes: bytes.length,
    sha256: deps.hashBytes(bytes),
    path,
  }
}

/**
 * Render the launcher text without touching the filesystem, for previews and
 * tests.
 * @param spec - template inputs.
 * @param language - resolved language.
 * @param codePage - target code page.
 * @returns The text and its encoding outcome.
 */
export function previewLauncher(spec, language, codePage) {
  const text = renderLauncher({ ...spec, language, codePage })
  return { text, encoded: encodeForCodePage(text, codePage) }
}

/** Re-exported so callers share one definition of the default launcher name. */
export { DEFAULT_FILE_NAMES, toCrlf }
