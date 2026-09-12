/**
 * Exit codes of a generated launcher, shared by the generator, the probe
 * subprocess, the documentation, and the tests. The launcher's exit code is
 * its contract: a caller (a scheduled task, a shortcut wrapper, CI) can branch
 * on it without parsing the console text, which is localized.
 *
 * Codes 0-9 are the launcher's own outcomes. 20 is reserved for "the harness
 * itself failed", kept far away from them so a pass-through child code can
 * never be mistaken for a launcher verdict.
 *
 * @module dsh-launch-in-one-click/exit-codes
 */

/** Launcher and probe exit codes. */
export const EXIT = Object.freeze({
  /** The server ran and exited cleanly, or a dry run printed its plan. */
  OK: 0,
  /** `node` is not on PATH: nothing can run. */
  NO_NODE: 1,
  /** The port already serves a Harness instance; a second one is not started. */
  PORT_DSH: 2,
  /** The port is held by an unrelated program; the launcher refuses to guess. */
  PORT_FOREIGN: 3,
  /** A command-line argument is invalid. */
  BAD_ARGS: 4,
  /** The configured work directory is missing or cannot be entered. */
  BAD_WORKDIR: 5,
  /** The preflight probe itself could not reach a verdict. */
  PROBE_ERROR: 9,
  /** The harness process started and failed; its own code is printed above. */
  SERVER_FAILED: 20,
})

/**
 * Human-readable label for one exit code, used in tool output and tests.
 * @param code - a launcher exit code.
 * @returns The label, or `unknown` for a code this version does not define.
 */
export function describeExitCode(code) {
  switch (code) {
    case EXIT.OK: return 'ok'
    case EXIT.NO_NODE: return 'node-missing'
    case EXIT.PORT_DSH: return 'port-serves-harness'
    case EXIT.PORT_FOREIGN: return 'port-foreign-owner'
    case EXIT.BAD_ARGS: return 'bad-arguments'
    case EXIT.BAD_WORKDIR: return 'bad-workdir'
    case EXIT.PROBE_ERROR: return 'probe-error'
    case EXIT.SERVER_FAILED: return 'harness-failed'
    default: return 'unknown'
  }
}
