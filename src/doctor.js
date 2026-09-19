/**
 * The read-only diagnosis behind `launcher_doctor`.
 *
 * Every launcher verdict has a cause that exists before the launcher runs: a
 * missing Node, a Desktop folder that moved with OneDrive, a port already
 * serving a Harness instance, a file that is not this plugin's to replace. The
 * doctor reports all of them together, so one call answers "why would this fail
 * on my machine" instead of one failure at a time.
 *
 * It changes nothing except a single create-and-delete write probe, and it can
 * be asked to execute an installed launcher in dry-run mode — the strongest
 * available answer to "does the thing on my Desktop still work".
 *
 * @module dsh-launch-in-one-click/doctor
 */

import { join } from 'node:path'
import { REAL_FS, probeWritableDirectory } from './atomic.js'
import { resolveDesktopDirectory } from './desktop.js'
import { detectLauncherCodePage } from './encoding.js'
import { DEFAULT_FILE_NAMES, PLUGIN_VERSION, inspectLauncher, verifyLauncherByRunning } from './install.js'
import { findPortOwner } from './netstat.js'
import { runPortProbe } from './probe.js'
import { runCommand } from './run.js'
import { checkPort, checkRunner } from './validate.js'
import { resolveExecutable } from './which.js'

/** Node major version the harness targets; older versions are reported as a warning. */
export const RECOMMENDED_NODE_MAJOR = 22

/** Default dependencies, each replaceable by tests. */
function defaultDeps() {
  return {
    fs: REAL_FS,
    run: runCommand,
    detectLauncherCodePage,
    resolveDesktopDirectory,
    runPortProbe,
    findPortOwner,
    probeWritableDirectory,
    verifyLauncherByRunning,
    inspectLauncher,
  }
}

/** Build one check row. */
function check(id, status, detail) {
  return { id, status, detail }
}

/**
 * Parse `node --version` output.
 * @param text - the version line, such as `v22.23.2`.
 * @returns The trimmed version and its major number, or `null`s.
 */
export function parseNodeVersion(text) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  if (match === null) return { version: null, major: null }
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) }
}

/**
 * Diagnose the machine a launcher would run on.
 * @param options - port, directory, file name, runner, and probe switches.
 * @param overrides - dependency overrides for tests.
 * @returns Checks, a summary, and the resolved facts each check reads.
 */
export async function runDoctor(options = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const {
    port = 3080,
    directory,
    fileName,
    runner = 'npx',
    probeWrite = true,
    verifyExecution = false,
    signal,
    env = process.env,
    platform = process.platform,
  } = options

  const checks = []
  const notes = []

  checks.push(platform === 'win32'
    ? check('platform', 'ok', `Windows (${platform})`)
    : check('platform', 'fail', `This plugin generates Windows batch launchers; the host is ${platform}.`))

  const portCheck = checkPort(port)
  if (!portCheck.ok) checks.push(check('port', 'fail', portCheck.hint))
  const runnerCheck = checkRunner(runner)
  if (!runnerCheck.ok) checks.push(check('runner', 'fail', runnerCheck.hint))

  // --- Node -----------------------------------------------------------------
  const nodePath = resolveExecutable('node', { env, platform })
  let nodeVersion = null
  if (nodePath === null) {
    checks.push(check('node', 'fail', 'node is not on PATH, so a launcher could not start the harness.'))
  } else {
    const versionResult = await deps.run(nodePath, ['--version'], { env, signal, decode: (buffer) => buffer.toString('utf8') })
    const parsed = parseNodeVersion(versionResult.stdout)
    nodeVersion = parsed.version
    if (versionResult.failure !== undefined || versionResult.code !== 0 || parsed.version === null) {
      checks.push(check('node', 'fail', `${nodePath} did not answer --version, so a launcher could not use it.`))
    } else if (parsed.major !== null && parsed.major < RECOMMENDED_NODE_MAJOR) {
      checks.push(check('node', 'warn', `Node ${parsed.version} is older than the ${String(RECOMMENDED_NODE_MAJOR)} the harness targets.`))
    } else {
      checks.push(check('node', 'ok', `Node ${parsed.version} at ${nodePath}`))
    }
  }

  // --- Runner ---------------------------------------------------------------
  const runnerPath = runnerCheck.ok ? resolveExecutable(runnerCheck.value, { env, platform }) : null
  if (runnerCheck.ok) {
    checks.push(runnerPath === null
      ? check('runner', 'fail', `${runnerCheck.value} is not on PATH, so the launcher could not start the harness.`)
      : check('runner', 'ok', `${runnerCheck.value} at ${runnerPath}`))
  }

  // --- Console code page ----------------------------------------------------
  const detected = await deps.detectLauncherCodePage({ run: deps.run, env, signal, platform })
  if (detected.codePage === null) {
    checks.push(check('code-page', 'warn', `The console code page could not be read (${detected.detail}); installing would stop here.`))
  } else {
    const source = detected.source === 'oem' ? 'system OEM, what a double-click gets' : `this console (${detected.source})`
    const mismatch = detected.consoleCodePage !== null && detected.consoleCodePage !== detected.codePage
      ? `; this console runs code page ${String(detected.consoleCodePage)}`
      : ''
    checks.push(check('code-page', 'ok', `code page ${String(detected.codePage)} (${source})${mismatch}`))
  }

  // --- Directory ------------------------------------------------------------
  let targetDirectory = directory
  let directorySource = 'argument'
  if (targetDirectory === undefined) {
    const desktop = await deps.resolveDesktopDirectory({ run: deps.run, env, signal, platform })
    if (desktop.path === null) {
      checks.push(check('directory', 'fail', `The Desktop folder could not be resolved: ${JSON.stringify(desktop.candidates)}`))
    } else {
      targetDirectory = desktop.path
      directorySource = desktop.source
      checks.push(check('directory', 'ok', `${desktop.path} (${desktop.source})`))
    }
  } else {
    const exists = (() => {
      try {
        return deps.fs.statSync(targetDirectory).isDirectory()
      } catch {
        return false
      }
    })()
    checks.push(exists
      ? check('directory', 'ok', `${targetDirectory} (explicit)`)
      : check('directory', 'fail', `${targetDirectory} is not an existing directory.`))
  }

  let writable = { writable: false, reason: 'not-checked' }
  if (targetDirectory !== undefined && probeWrite) {
    writable = await deps.probeWritableDirectory(targetDirectory, { signal })
    checks.push(writable.writable
      ? check('directory-writable', 'ok', 'a temporary file could be created and removed')
      : check('directory-writable', 'fail', `${targetDirectory} refused a test file (${writable.reason}).`))
  } else if (targetDirectory !== undefined) {
    checks.push(check('directory-writable', 'skip', 'write probe not requested'))
  }

  // --- Port -----------------------------------------------------------------
  let portState = null
  let portOwner = null
  if (portCheck.ok) {
    const probe = await deps.runPortProbe(portCheck.value, { run: deps.run, env, signal, platform })
    portState = probe.state
    if (probe.state === 'free') {
      checks.push(check('port', 'ok', `${String(portCheck.value)} is free`))
    } else if (probe.state === 'dsh') {
      const owner = await deps.findPortOwner(portCheck.value, { run: deps.run, env, signal })
      portOwner = describeOwner(owner)
      checks.push(check('port', 'warn', `${String(portCheck.value)} already serves a Harness instance${portOwner === null ? '' : ` (${portOwner})`}; a launcher will refuse to start a second one.`))
    } else if (probe.state === 'foreign') {
      const owner = await deps.findPortOwner(portCheck.value, { run: deps.run, env, signal })
      portOwner = describeOwner(owner)
      checks.push(check('port', 'warn', `${String(portCheck.value)} is held by something else${portOwner === null ? '' : ` (${portOwner})`}; a launcher will refuse to start.`))
    } else {
      checks.push(check('port', 'fail', `The port preflight reached no verdict (${probe.detail}).`))
    }
  }

  // --- Installed launcher ---------------------------------------------------
  //
  // Both shipped names are inspected, not just the language's default: the file
  // on the Desktop was written in whichever language the console implied at the
  // time, and reporting "does not exist yet" for a launcher sitting right there
  // is worse than useless.
  let installed = { exists: false, owned: false, version: null, config: null, bytes: 0, sha256: null, path: null, fileName: null }
  if (targetDirectory !== undefined) {
    const wanted = fileName === undefined ? [DEFAULT_FILE_NAMES.zh, DEFAULT_FILE_NAMES.en] : [fileName]
    for (const name of wanted) {
      const inspected = deps.inspectLauncher(join(targetDirectory, name), { fs: deps.fs })
      if (inspected.exists) {
        installed = { ...inspected, fileName: name }
        break
      }
      installed = { ...inspected, fileName: name }
    }
    if (!installed.exists) {
      checks.push(check('launcher', 'info', `${join(targetDirectory, wanted[0])} does not exist yet.`))
    } else if (!installed.owned) {
      checks.push(check('launcher', 'warn', `${String(installed.path)} exists but was not written by this plugin; installing needs overwrite.`))
    } else if (installed.version !== PLUGIN_VERSION) {
      checks.push(check(
        'launcher',
        'warn',
        `${String(installed.path)} was written by v${String(installed.version)}; this plugin is v${PLUGIN_VERSION} and refreshes it on load unless autoUpdate is off.`,
      ))
    } else {
      checks.push(check('launcher', 'ok', `${String(installed.path)} (v${String(installed.version)}, ${String(installed.bytes)} bytes)`))
    }
  }

  let execution = null
  // The path reported is the launcher that is there when one is, and otherwise
  // the one an install would write — a caller asking "where would this go" gets
  // an answer either way.
  const targetPath = installed.exists
    ? installed.path
    : (targetDirectory === undefined ? null : join(targetDirectory, fileName ?? DEFAULT_FILE_NAMES.zh))
  if (verifyExecution && targetPath !== null && installed.owned && platform === 'win32') {
    execution = await deps.verifyLauncherByRunning(targetPath, { run: deps.run, env, signal, platform })
    checks.push(execution.ok
      ? check('launcher-execution', 'ok', `dry run exited ${String(execution.exitCode)}`)
      : check('launcher-execution', 'fail', `dry run failed: ${String(execution.reason)}`))
  }

  const summary = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 }
  for (const entry of checks) summary[entry.status] += 1

  return {
    platform,
    ok: summary.fail === 0,
    summary,
    checks,
    notes,
    port: portCheck.ok ? portCheck.value : null,
    portState,
    portOwner,
    codePage: detected.codePage,
    directory: targetDirectory ?? null,
    directorySource,
    writable: writable.writable,
    writableReason: writable.reason,
    targetPath,
    installed: !installed.exists ? 'none' : installed.owned ? 'ours' : 'foreign',
    launcherVersion: installed.version,
    launcherBytes: installed.bytes,
    launcherSha256: installed.sha256,
    nodeVersion,
    nodePath,
    runner: runnerCheck.ok ? runnerCheck.value : null,
    runnerPath,
    execution,
  }
}

/** Describe a port owner for a check line. */
function describeOwner(owner) {
  if (owner === undefined || owner.supported !== true) return null
  if (owner.names.length > 0) {
    return owner.names.map((entry) => `PID ${String(entry.pid)} ${entry.name}`).join(', ')
  }
  if (owner.pids.length > 0) return owner.pids.map((pid) => `PID ${String(pid)}`).join(', ')
  return null
}
