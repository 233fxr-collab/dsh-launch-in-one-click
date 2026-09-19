/**
 * Keeping the Desktop launcher matched to the installed plugin.
 *
 * A marketplace hot-mounts a plugin whose bundle patch is a plain insert, so
 * this runs the moment someone clicks Install — and on every start after that.
 * Two things can need doing, and they are deliberately separate switches:
 *
 * - **provision** (`provisionOnLoad`, default true) — there is no launcher, so
 *   make one. Without this, a fresh install would leave the user to run
 *   `/launch` before the plugin does anything, which is not what its name says.
 * - **update** (`autoUpdate`, default true) — there IS one, and it was written by
 *   a different build of this plugin, so its template is out of date. Rewriting
 *   it is what keeps a repaired message or a fixed code-page path from living
 *   only in the repository.
 *
 * An update rewrites *that* launcher: the port, workspace, runner, language, and
 * browser behaviour recorded inside it are carried over, so refreshing a
 * template can never move someone's setup. Changing settings stays an explicit
 * `launcher_install` or `/launch`.
 *
 * A launcher whose recorded version already matches is left byte-for-byte alone,
 * and so is one written by a build whose version cannot be read — the point of
 * the version field is that a guess is never needed.
 *
 * Both switches off means the plugin loads and touches nothing, which is what a
 * deployment that manages its own launcher wants.
 *
 * @module dsh-launch-in-one-click/provision
 */

import { PLUGIN_VERSION, findInstalledLauncher, installLauncher } from './install.js'

/**
 * Install or refresh the launcher, according to the two switches.
 * @param options - deployment settings as the plugin's config resolved them,
 *   plus `provisionOnLoad` and `autoUpdate`.
 * @param overrides - dependency overrides for tests.
 * @returns What happened, for the caller to log. Never throws.
 */
export async function provisionLauncher(options = {}, overrides = {}) {
  const {
    installLauncher: install = installLauncher,
    findInstalledLauncher: find = findInstalledLauncher,
    version = PLUGIN_VERSION,
  } = overrides

  const {
    platform = process.platform,
    signal,
    provisionOnLoad = true,
    autoUpdate = true,
    fileName,
    ...settings
  } = options

  if (platform !== 'win32') {
    return { action: 'skipped', reason: 'unsupported-platform', result: null }
  }

  try {
    const installed = await find({ fileName })

    if (installed === null) {
      if (!provisionOnLoad) return { action: 'skipped', reason: 'provisioning-disabled', result: null }
      // A load-time install never runs the dry-run self-test: the file appears
      // silently, and spawning cmd during startup to prove it works is a cost the
      // user did not ask for. The explicit tools still verify.
      const result = await install({ ...settings, fileName, onlyIfAbsent: true, verify: 'none', signal })
      if (result.ok !== true) return { action: 'failed', reason: result.reason ?? 'unknown', result }
      return result.unchanged === true
        ? { action: 'kept-existing', reason: 'already-present', result }
        : { action: 'installed', reason: null, result }
    }

    if (!autoUpdate) return { action: 'kept-existing', reason: 'auto-update-disabled', result: null }
    if (installed.version === version) return { action: 'kept-existing', reason: 'current', result: null }
    if (installed.version === null) return { action: 'kept-existing', reason: 'version-unreadable', result: null }

    const recorded = installed.config ?? {}
    const port = Number(recorded.port)
    const result = await install({
      ...settings,
      fileName: installed.fileName ?? fileName,
      port: Number.isInteger(port) && port > 0 ? port : settings.port,
      workdir: recorded.workdir ?? settings.workdir,
      runner: recorded.runner ?? settings.runner,
      language: recorded.lang ?? settings.language,
      openBrowser: recorded.openBrowser === undefined
        ? settings.openBrowser
        : recorded.openBrowser === '1',
      verify: 'none',
      signal,
    })
    if (result.ok !== true) return { action: 'failed', reason: result.reason ?? 'unknown', result }
    if (result.unchanged === true) return { action: 'kept-existing', reason: 'already-current', result }
    return { action: 'updated', reason: null, from: installed.version, result }
  } catch (error) {
    return { action: 'failed', reason: error instanceof Error ? error.message : String(error), result: null }
  }
}

/**
 * Compose the line the plugin logs about one provisioning attempt.
 * @param outcome - a {@link provisionLauncher} result.
 * @returns A single log line, or `null` when there is nothing worth saying.
 */
export function describeProvision(outcome) {
  switch (outcome.action) {
    case 'installed':
      return `created ${String(outcome.result?.path)} (port ${String(outcome.result?.port)}, ${String(outcome.result?.encoding)})`
    case 'updated':
      return `updated ${String(outcome.result?.path)} from v${String(outcome.from)} to this build's template`
    case 'kept-existing':
      return outcome.reason === 'current' || outcome.reason === 'already-current'
        ? null
        : 'a launcher is already on the Desktop; leaving it untouched'
    case 'failed':
      return `could not create the launcher: ${String(outcome.reason)}`
    default:
      return null
  }
}
