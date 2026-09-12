/**
 * Subprocess helper used by every check that has to ask Windows a question —
 * `netstat`, `tasklist`, `reg`, `chcp`, and the embedded port probe.
 *
 * Output is captured through temporary FILES, not through pipes. That is a
 * deliberate choice with two consequences: a child that writes more than a pipe
 * buffer can never deadlock the parent before it reads, and the capture keeps
 * working in environments that forbid a process from creating the anonymous
 * pipes `stdio: 'pipe'` needs. The price is a temp file per stream, removed in
 * a `finally`.
 *
 * The runner never rejects: a missing executable, a non-zero exit, or a timeout
 * all come back as data, so a diagnostic can report "could not ask" instead of
 * failing the whole preflight.
 *
 * @module dsh-launch-in-one-click/run
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default budget for a diagnostic command, in milliseconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000

/** Create a unique capture directory, removed by the caller. */
function makeCaptureDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-launch-capture-'))
}

/** Read a capture file, tolerating a missing or partially written one. */
function readCapture(path) {
  try {
    return readFileSync(path)
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * Run a command and capture its output.
 * @param command - executable name or absolute path.
 * @param args - argument vector.
 * @param options - timeout, abort signal, environment, spawn override, and the
 *   capture-directory factory (injected by tests to keep the tree clean).
 * @returns Exit code, stdout, stderr, and an optional failure reason.
 */
export async function runCommand(command, args = [], options = {}) {
  const {
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    signal,
    env = process.env,
    spawn: spawnImpl = spawn,
    captureDir = makeCaptureDir,
    decode = (buffer) => buffer.toString('utf8'),
    windowsVerbatimArguments = false,
  } = options

  const directory = captureDir()
  const stdoutPath = join(directory, 'stdout.txt')
  const stderrPath = join(directory, 'stderr.txt')
  const clean = () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      /* a leftover temp directory is not worth failing a diagnostic over */
    }
  }

  const outFd = openSync(stdoutPath, 'w')
  const errFd = openSync(stderrPath, 'w')

  return await new Promise((resolve) => {
    let child
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const captured = {
        stdout: decode(readCapture(stdoutPath)),
        stderr: decode(readCapture(stderrPath)),
      }
      clean()
      resolve({ ...captured, ...result })
    }

    try {
      child = spawnImpl(command, args, {
        windowsHide: true,
        env,
        signal,
        stdio: ['ignore', outFd, errFd],
        windowsVerbatimArguments,
      })
    } catch (error) {
      closeSync(outFd)
      closeSync(errFd)
      finish({ code: null, failure: errorMessage(error) })
      return
    }

    closeSync(outFd)
    closeSync(errFd)

    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, failure: 'timeout' })
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (error) => finish({ code: null, failure: errorMessage(error) }))
    child.on('close', (code) => finish({ code }))
  })
}

/**
 * Read the stdout of a command that must have succeeded.
 * @param result - a {@link runCommand} result.
 * @returns The stdout text when the command exited 0, else `null`.
 */
export function stdoutOrNull(result) {
  if (result.failure !== undefined || result.code !== 0) return null
  return result.stdout
}

/**
 * Render an unknown thrown value as a message.
 * @param error - the thrown value.
 * @returns A printable message.
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
