/**
 * Who holds a port, for the one diagnostic a verdict alone cannot give.
 *
 * The probe decides *whether* a launcher may start; this module answers the
 * follow-up question a person asks next — "what is holding it?" — by reading
 * `netstat -ano` and `tasklist`. Both are diagnostics only: a failure here
 * degrades the report, never the verdict.
 *
 * @module dsh-launch-in-one-click/netstat
 */

import { runCommand } from './run.js'

/**
 * Parse `netstat -ano` output into listening TCP ports and their owner PIDs.
 * Header and non-TCP lines are skipped, and a malformed line is ignored rather
 * than thrown, because netstat output is localized and version-dependent.
 * @param text - netstat stdout.
 * @returns Port to owning PIDs, in first-seen order.
 */
export function parseNetstatListeners(text) {
  const listeners = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    if (!/^TCP$/i.test(fields[0])) continue
    if (!/^LISTENING$/i.test(fields[3])) continue
    const local = fields[1]
    const separator = local.lastIndexOf(':')
    if (separator < 0) continue
    const port = Number(local.slice(separator + 1))
    const pid = Number(fields[4])
    if (!Number.isInteger(port) || port < 0 || port > 65535) continue
    if (!Number.isInteger(pid) || pid <= 0) continue
    const owners = listeners.get(port) ?? []
    owners.push(pid)
    listeners.set(port, owners)
  }
  return listeners
}

/**
 * Parse `tasklist /FO CSV /NH` output into image names by PID.
 * @param text - tasklist stdout.
 * @returns PID to image name.
 */
export function parseTasklistCsv(text) {
  const names = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim())
    if (match === null) continue
    names.set(Number(match[2]), match[1])
  }
  return names
}

/**
 * Find the processes listening on a port.
 * @param port - the port of interest.
 * @param options - environment, abort signal, runner, and output decoder.
 * @returns Owner PIDs and, when `tasklist` answers, their image names.
 */
export async function findPortOwner(port, options = {}) {
  const { env = process.env, signal, run = runCommand, decode, platform = process.platform } = options
  if (platform !== 'win32') return { supported: false, pids: [], names: [] }

  const netstat = await run('netstat', ['-ano', '-p', 'TCP'], { env, signal, decode })
  if (netstat.failure !== undefined || netstat.code !== 0) {
    return { supported: true, pids: [], names: [], failure: netstat.failure ?? `exit:${String(netstat.code)}` }
  }

  const pids = parseNetstatListeners(netstat.stdout).get(port) ?? []
  if (pids.length === 0) return { supported: true, pids: [], names: [] }

  const names = []
  for (const pid of pids) {
    const listed = await run('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], { env, signal, decode })
    if (listed.failure !== undefined || listed.code !== 0) continue
    const name = parseTasklistCsv(listed.stdout).get(pid)
    if (name !== undefined) names.push({ pid, name })
  }
  return { supported: true, pids, names }
}
