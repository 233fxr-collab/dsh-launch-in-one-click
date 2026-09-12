/**
 * Running the shared port probe, and reading its verdict.
 *
 * The probe is executed as `node -e <script> <port>` — byte for byte the same
 * invocation the generated launcher performs — so the installer's answer and
 * the launcher's answer come from one implementation. The Node binary is the
 * one PATH resolves, because that is the binary a double-clicked launcher will
 * find; `process.execPath` is only the fallback for a host whose PATH has no
 * `node` at all.
 *
 * @module dsh-launch-in-one-click/probe
 */

import { PROBE_SCRIPT, interpretProbe } from './probe-script.js'
import { runCommand } from './run.js'
import { resolveExecutable } from './which.js'

/** Generous budget for a probe that has its own internal 5 s guard. */
export const PROBE_PROCESS_TIMEOUT_MS = 15000

/**
 * Ask whether a launcher may start on this port.
 * @param port - validated TCP port.
 * @param options - environment, abort signal, timeout, and injected runner.
 * @returns The verdict: `free`, `dsh`, `foreign`, or `error`, with its detail.
 */
export async function runPortProbe(port, options = {}) {
  const {
    env = process.env,
    signal,
    timeoutMs = PROBE_PROCESS_TIMEOUT_MS,
    run = runCommand,
    platform = process.platform,
  } = options

  const fromPath = options.nodePath ?? resolveExecutable('node', { env, platform })
  const nodePath = fromPath ?? process.execPath

  const result = await run(nodePath, ['-e', PROBE_SCRIPT, String(port)], {
    env,
    signal,
    timeoutMs,
    decode: (buffer) => buffer.toString('utf8'),
  })

  const base = { nodePath, nodeFromPath: fromPath !== null && fromPath !== undefined }
  if (result.failure !== undefined) {
    return { ...base, state: 'error', detail: `spawn:${result.failure}` }
  }
  const verdict = interpretProbe(result.code, result.stdout)
  if (verdict.state === 'error' && result.stderr.trim().length > 0) {
    return { ...base, ...verdict, detail: result.stderr.trim().split('\n')[0] }
  }
  return { ...base, ...verdict }
}
