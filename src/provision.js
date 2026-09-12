/**
 * Provisioning the launcher when the plugin loads.
 *
 * The market hot-mounts a plugin whose bundle patch is a plain insert, so this
 * plugin goes live the moment someone clicks Install — no restart. That makes
 * "the file is on the Desktop right after installing" achievable, and it is the
 * whole promise of the plugin's name, so it happens by default.
 *
 * The policy is deliberately one-way: **create when absent, never replace.**
 * A load is not a decision by the user. If a launcher is already there — theirs,
 * an older one of ours, or a file that merely has the same name — it is left
 * exactly as it is, and the log says so. Changing an installed launcher stays an
 * explicit action through `launcher_install` or `/launch`.
 *
 * @module dsh-launch-in-one-click/provision
 */

import { installLauncher } from './install.js'

/**
 * Install the launcher once, if nothing is there yet.
 * @param options - deployment settings, as the plugin's config resolved them.
 * @param overrides - dependency overrides for tests.
 * @returns What happened, for the caller to log. Never throws.
 */
export async function provisionLauncher(options = {}, overrides = {}) {
  const { installLauncher: install = installLauncher } = overrides
  const { platform = process.platform, signal, ...settings } = options

  if (platform !== 'win32') {
    return { action: 'skipped', reason: 'unsupported-platform', result: null }
  }

  try {
    // A load-time install never runs the dry-run self-test: the file is created
    // silently, and spawning cmd during startup to prove it works is a cost the
    // user did not ask for. The explicit tools still verify.
    const result = await install({ ...settings, onlyIfAbsent: true, verify: 'none', signal })
    if (result.ok !== true) return { action: 'failed', reason: result.reason ?? 'unknown', result }
    if (result.unchanged === true) return { action: 'kept-existing', reason: null, result }
    return { action: 'installed', reason: null, result }
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
    case 'kept-existing':
      return 'a launcher is already on the Desktop; leaving it untouched'
    case 'failed':
      return `could not create the launcher: ${String(outcome.reason)}`
    default:
      return null
  }
}
