/**
 * Durable single-file writes, and the writability probe that precedes them.
 *
 * A launcher is written the way any file a person depends on should be: into a
 * temporary name in the destination directory, then renamed over the target.
 * The rename is the commit — a reader either sees the old file or the new one,
 * never half of either.
 *
 * The retry loop is not defensive padding. On Windows, `MoveFileEx` fails with
 * `EPERM` when an indexer, an antivirus scanner, or a text editor holds the
 * destination open for a few milliseconds. That is a transient condition on a
 * normal machine, so a rename is retried with backoff before it becomes an
 * error the user has to understand.
 *
 * @module dsh-launch-in-one-click/atomic
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Rename failures worth retrying: another process holds the file briefly. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/** Default rename attempts and first backoff, in milliseconds. */
export const RENAME_ATTEMPTS = 5
export const RENAME_BACKOFF_MS = 25

/**
 * The real filesystem functions, overridable one at a time in tests. Callers
 * taking an `fs` option must pass this whole surface, not a subset: the atomic
 * write needs the open/write/rename trio, and a missing function would surface
 * as an opaque TypeError instead of a filesystem error.
 */
export const REAL_FS = Object.freeze({
  closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
})

/** Default sleep. @param ms - milliseconds to wait. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * SHA-256 of a byte buffer, used to prove a written file is the intended one.
 * @param bytes - file contents.
 * @returns Lowercase hex digest.
 */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read a file, or `null` when it does not exist or cannot be read.
 * @param path - file path.
 * @param fs - filesystem surface.
 * @returns The bytes, or `null`.
 */
export function readFileBytes(path, fs = REAL_FS) {
  try {
    return fs.readFileSync(path)
  } catch {
    return null
  }
}

/**
 * Test whether a directory accepts a new file, by creating one and removing it.
 * A permission bit is not enough on Windows: the effective answer depends on
 * ACLs, on Controlled Folder Access, and on whether the folder is a sync root,
 * so the probe does the real thing and cleans up after itself.
 * @param directory - directory to test.
 * @param options - filesystem surface and abort signal.
 * @returns Whether a file could be created, and why not when it could not.
 */
export async function probeWritableDirectory(directory, options = {}) {
  const { fs = REAL_FS, signal } = options
  if (signal?.aborted === true) return { writable: false, reason: 'aborted' }
  if (!fs.existsSync(directory)) return { writable: false, reason: 'missing' }
  try {
    if (!fs.statSync(directory).isDirectory()) return { writable: false, reason: 'not-a-directory' }
  } catch (error) {
    return { writable: false, reason: errorCode(error) }
  }

  const probePath = join(directory, `.dsh-launch-write-probe-${randomBytes(4).toString('hex')}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(probePath, 'wx')
    fs.writeSync(fd, Buffer.from('probe', 'utf8'))
    return { writable: true, reason: null }
  } catch (error) {
    return { writable: false, reason: errorCode(error) }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* closing a probe handle cannot change the verdict */
      }
    }
    try {
      if (fs.existsSync(probePath)) fs.unlinkSync(probePath)
    } catch {
      /* a leftover probe file is reported by the directory listing, not here */
    }
  }
}

/**
 * Write bytes to a path atomically.
 * @param path - destination file.
 * @param bytes - exact bytes to write.
 * @param options - filesystem surface, retry policy, and injected sleep.
 * @returns The temporary path used, and how many rename attempts it took.
 * @throws when the temporary write or the final rename fails.
 */
export async function writeFileAtomic(path, bytes, options = {}) {
  const {
    fs = REAL_FS,
    attempts = RENAME_ATTEMPTS,
    backoffMs = RENAME_BACKOFF_MS,
    sleep: sleepImpl = sleep,
  } = options

  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`)

  let fd = null
  try {
    fd = fs.openSync(temporary, 'wx')
    let written = 0
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written)
    }
    fs.closeSync(fd)
    fd = null
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* the original failure is the one worth reporting */
      }
    }
    removeQuietly(fs, temporary)
    throw error
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.renameSync(temporary, path)
      return { temporary, attemptsUsed: attempt }
    } catch (error) {
      const retryable = RETRYABLE_RENAME.has(errorCode(error))
      if (!retryable || attempt === attempts) {
        removeQuietly(fs, temporary)
        throw error
      }
      await sleepImpl(backoffMs * 2 ** (attempt - 1))
    }
  }

  removeQuietly(fs, temporary)
  throw new Error(`dsh-launch-in-one-click: could not replace ${path}`)
}

/**
 * Remove a file, ignoring the case where it is already gone.
 * @param path - file path.
 * @param fs - filesystem surface.
 */
export function removeQuietly(path, fs = REAL_FS) {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path)
  } catch {
    /* best effort: the caller reports the operation that actually mattered */
  }
}

/**
 * Read the machine-readable error code from a thrown filesystem error.
 * @param error - the thrown value.
 * @returns The code, or `unknown`.
 */
export function errorCode(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code
  return 'unknown'
}
