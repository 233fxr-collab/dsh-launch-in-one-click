/**
 * The install state machine: what it refuses, what it backs up, what it rolls
 * back. Every filesystem effect here is real, only the machine-specific probes
 * are injected, so the ownership and atomicity rules are exercised for real.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { installLauncher, inspectLauncher, uninstallLauncher, verifyLauncherByRunning } from '../src/install.js'
import { readLauncherMarker } from '../src/bat-template.js'
import { encodeForCodePage } from '../src/encoding.js'

const created = []
let directory

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-launch-install-'))
  created.push(directory)
})

after(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

/** Probes stubbed out: these tests are about files, not about this machine. */
function deps(overrides = {}) {
  return {
    detectConsoleCodePage: async () => ({ codePage: 936, source: 'stub', detail: 'stub' }),
    resolveDesktopDirectory: async () => ({ path: directory, source: 'stub', candidates: [] }),
    probeWritableDirectory: async () => ({ writable: true, reason: null }),
    runPortProbe: async () => ({ state: 'free', detail: 'free' }),
    verifyLauncherByRunning: async () => ({ ran: true, exitCode: 0, output: 'dry run ok', ok: true, reason: null }),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  }
}

/** Install with the machine-specific probes stubbed. */
function install(options = {}, overrides = {}) {
  return installLauncher({ directory, fileName: 'DSH.bat', workdir: directory, ...options }, deps(overrides))
}

test('a fresh install writes a recognized launcher', async () => {
  const result = await install()
  assert.equal(result.ok, true)
  assert.equal(result.path, join(directory, 'DSH.bat'))
  assert.equal(result.encoding, 'gbk')
  assert.equal(result.language, 'zh')
  assert.equal(result.replaced, false)
  assert.equal(result.backupPath, null)
  assert.equal(result.verified, true)

  const bytes = readFileSync(result.path)
  assert.equal(bytes.subarray(0, 11).toString('latin1'), '@echo off\r\n')
  assert.equal(readLauncherMarker(bytes.toString('latin1')).owned, true)
  assert.equal(result.bytes, bytes.length)
})

test('a dry run reports the plan and writes nothing', async () => {
  const result = await install({ dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(directory, 'DSH.bat')), false)
  assert.match(result.warnings.join(' '), /dry run/)
})

test('an identical launcher is left alone', async () => {
  await install()
  const again = await install()
  assert.equal(again.ok, true)
  assert.equal(again.unchanged, true)
  assert.equal(again.backupPath, null)
  assert.match(again.warnings.join(' '), /already up to date/)
})

test('a file this plugin did not write is refused, and left untouched', async () => {
  const path = join(directory, 'DSH.bat')
  writeFileSync(path, 'mine, hands off\r\n')
  const result = await install()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'file-not-ours')
  assert.equal(result.existing, 'foreign')
  assert.equal(readFileSync(path, 'utf8'), 'mine, hands off\r\n')
})

test('overwrite replaces a foreign file and keeps a backup of it', async () => {
  const path = join(directory, 'DSH.bat')
  writeFileSync(path, 'mine, hands off\r\n')
  const result = await install({ overwrite: true })
  assert.equal(result.ok, true)
  assert.equal(result.replaced, true)
  assert.ok(result.backupPath !== null)
  assert.equal(readFileSync(result.backupPath, 'utf8'), 'mine, hands off\r\n')
  assert.equal(readLauncherMarker(readFileSync(path).toString('latin1')).owned, true)
})

test('changing the port replaces the launcher and backs up the old one', async () => {
  await install({ port: 3080 })
  const result = await install({ port: 3111 })
  assert.equal(result.ok, true)
  assert.equal(result.replaced, true)
  assert.ok(result.backupPath !== null)
  assert.match(readFileSync(result.path, 'utf8'), /set "PORT=3111"/)
})

test('a launcher that fails its own dry run is rolled back', async () => {
  const path = join(directory, 'DSH.bat')
  await install()
  const good = readFileSync(path)

  const result = await install({ port: 3111 }, {
    verifyLauncherByRunning: async () => ({ ran: true, exitCode: 255, output: 'was unexpected at this time', ok: false, reason: 'unknown' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'launcher-verification-failed')
  assert.deepEqual(readFileSync(path), good, 'the previous launcher must be restored')
})

test('a failed first install leaves nothing behind', async () => {
  const result = await install({}, {
    verifyLauncherByRunning: async () => ({ ran: true, exitCode: 1, output: '', ok: false, reason: 'node-missing' }),
  })
  assert.equal(result.ok, false)
  assert.equal(existsSync(join(directory, 'DSH.bat')), false)
})

test('a code page that cannot carry Chinese falls back to English', async (t) => {
  const ascii = asciiDirectory()
  if (ascii === null) {
    t.skip('no ASCII-only writable directory available on this machine')
    return
  }
  const result = await install({ directory: ascii, workdir: ascii, language: 'zh' }, {
    detectConsoleCodePage: async () => ({ codePage: 437, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.language, 'en')
  assert.equal(result.encoding, 'cp437')
  assert.match(result.warnings.join(' '), /cannot carry the Chinese text/)
  const bytes = readFileSync(result.path)
  assert.equal(bytes.every((byte) => byte < 0x80), true, 'the fallback file must be pure ASCII')
})

test('a code page that cannot carry the target path switches the file to UTF-8', async () => {
  // The temporary directory carries this machine's profile name, which is
  // exactly the case English cannot rescue: the path is not the user's to change.
  const result = await install({}, {
    detectConsoleCodePage: async () => ({ codePage: 437, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.encoding, 'utf8')
  assert.equal(result.codePage, 65001)
  assert.match(result.warnings.join(' '), /switches itself to UTF-8/)
  assert.equal(readFileSync(result.path).subarray(0, 11).toString('latin1'), '@echo off\r\n')
  assert.match(readFileSync(result.path, 'utf8'), /chcp 65001/)
})

test('a name whose code page byte pair is cmd syntax switches to UTF-8', async (t) => {
  // The hazard scanner rejects such a file in the console code page; UTF-8 has
  // no such collision, so the launcher is written there instead of failing.
  const hazardous = findHazardousName()
  if (hazardous === null) {
    t.skip('no CJK character with a metacharacter trail byte in code page 936')
    return
  }
  const result = await install({ fileName: hazardous }, {
    detectConsoleCodePage: async () => ({ codePage: 936, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.encoding, 'utf8')
  assert.equal(result.codePage, 65001)
  assert.match(result.warnings.join(' '), /switches itself to UTF-8/)
})

/** Find a file name whose GBK encoding collides with cmd syntax. */
function findHazardousName() {
  for (let code = 0x4e00; code <= 0x9fa5; code += 1) {
    const candidate = `${String.fromCharCode(code)}.bat`
    if (encodeForCodePage(candidate, 936).reason === 'cmd-metacharacter-trail-byte') return candidate
  }
  return null
}

/**
 * An ASCII-only writable directory, which is what a console code page like 437
 * needs in order to be able to write anything at all. `null` when this machine
 * has no such path, in which case the caller skips.
 */
function asciiDirectory() {
  const base = process.cwd()
  if (!/^[\x20-\x7E]+$/.test(base)) return null
  const path = mkdtempSync(join(base, '.tmp-ascii-'))
  created.push(path)
  return path
}

test('an unwritable directory is refused before anything is attempted', async () => {
  const result = await install({}, { probeWritableDirectory: async () => ({ writable: false, reason: 'EACCES' }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'directory-not-writable')
})

test('an unresolvable Desktop is refused with the candidates it tried', async () => {
  const result = await installLauncher(
    { fileName: 'DSH.bat', workdir: directory },
    deps({ resolveDesktopDirectory: async () => ({ path: null, source: null, candidates: [{ source: 'known-folder', reason: 'missing' }] }) }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'desktop-not-found')
  assert.match(result.warnings.join(' '), /known-folder/)
})

test('non-Windows hosts are refused instead of writing a .bat nobody can run', async () => {
  const result = await install({ platform: 'linux' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported-platform')
})

test('a busy port is a warning, because it may be free by the time the user clicks', async () => {
  const result = await install({}, { runPortProbe: async () => ({ state: 'dsh', detail: 'dsh' }) })
  assert.equal(result.ok, true)
  assert.equal(result.portState, 'dsh')
  assert.match(result.warnings.join(' '), /serves a Harness instance/)
})

test('bad options are refused with the rule that was broken', async () => {
  assert.equal((await install({ port: 0 })).reason, 'port-out-of-range')
  assert.equal((await install({ fileName: 'DSH.txt' })).reason, 'file-name-extension')
  assert.equal((await install({ workdir: 'relative\\path' })).reason, 'workdir-not-absolute')
  assert.equal((await install({ runner: 'cmd' })).reason, 'runner-invalid')
})

test('inspection reports ownership without changing the file', async () => {
  const path = join(directory, 'DSH.bat')
  writeFileSync(path, 'not ours\r\n')
  const before = readFileSync(path)
  const inspected = inspectLauncher(path)
  assert.equal(inspected.exists, true)
  assert.equal(inspected.owned, false)
  assert.equal(inspected.sha256.length, 64)
  assert.deepEqual(readFileSync(path), before)

  const missing = inspectLauncher(join(directory, 'absent.bat'))
  assert.equal(missing.exists, false)
  assert.equal(missing.sha256, null)
})

test('uninstall removes only a launcher this plugin wrote', async () => {
  const path = join(directory, 'DSH.bat')
  await install()

  const foreignPath = join(directory, 'mine.bat')
  writeFileSync(foreignPath, 'mine\r\n')
  const refused = await uninstallLauncher({ path: foreignPath }, deps())
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'file-not-ours')
  assert.equal(existsSync(foreignPath), true)

  const forced = await uninstallLauncher({ path: foreignPath, force: true }, deps())
  assert.equal(forced.ok, true)
  assert.equal(forced.removed, true)
  assert.equal(existsSync(foreignPath), false)

  const removed = await uninstallLauncher({ path }, deps())
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, true)
  assert.equal(existsSync(path), false)

  const absent = await uninstallLauncher({ path }, deps())
  assert.equal(absent.ok, true)
  assert.equal(absent.removed, false)
})

test('the real runner executes the launcher and reports its dry run', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only')
    return
  }
  const path = join(directory, 'real.bat')
  const written = await install({ fileName: 'real.bat', port: 34567 }, { verifyLauncherByRunning })
  assert.equal(written.ok, true)
  assert.equal(written.verified, true)
  assert.equal(written.verification.exitCode, 0)
  assert.match(written.verification.output, /cd \/d/)

  const output = readFileSync(path)
  assert.equal(output.subarray(0, 11).toString('latin1'), '@echo off\r\n')
})
