/**
 * The install state machine: what it refuses, what it backs up, what it rolls
 * back. Every filesystem effect here is real, only the machine-specific probes
 * are injected, so the ownership and atomicity rules are exercised for real.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { DEFAULT_FILE_NAMES, findInstalledLauncher, installLauncher, inspectLauncher, uninstallLauncher, verifyLauncherByRunning } from '../src/install.js'
import { readLauncherMarker } from '../src/bat-template.js'
import { encodeForCodePage } from '../src/encoding.js'

/** Take an ephemeral port and release it, so nothing is listening there. */
async function reserveFreePort() {
  const server = http.createServer()
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  await new Promise((resolve) => { server.close(resolve) })
  return port
}

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
    detectLauncherCodePage: async () => ({ codePage: 936, source: 'stub', detail: 'stub' }),
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

test('an English console gets an English launcher without being told', async (t) => {
  const ascii = asciiDirectory()
  if (ascii === null) {
    t.skip('no ASCII-only writable directory available on this machine')
    return
  }
  const result = await install({ directory: ascii, workdir: ascii }, {
    detectLauncherCodePage: async () => ({ codePage: 437, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.language, 'en')
  assert.equal(result.encoding, 'cp437')
  assert.deepEqual(result.warnings, [], 'matching the console is not a fallback worth warning about')
  const bytes = readFileSync(result.path)
  assert.equal(bytes.every((byte) => byte < 0x80), true, 'the English launcher must be pure ASCII')
})

test('an explicit Chinese request survives a console that cannot print it', async (t) => {
  const ascii = asciiDirectory()
  if (ascii === null) {
    t.skip('no ASCII-only writable directory available on this machine')
    return
  }
  const result = await install({ directory: ascii, workdir: ascii, language: 'zh' }, {
    detectLauncherCodePage: async () => ({ codePage: 437, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.language, 'zh', 'asking for Chinese and getting English would be a silent downgrade')
  assert.equal(result.encoding, 'utf8')
  assert.equal(result.codePage, 65001)
  assert.match(readFileSync(result.path, 'utf8'), /试运行结束/)
})

test('a code page that cannot carry the target path switches the file to UTF-8', async () => {
  // The work directory is what gets baked into the launcher, so it is the value
  // that must be unrepresentable in cp437. Naming it here rather than relying on
  // the machine's own temp path keeps the test meaning the same thing on a
  // runner whose profile name is ASCII.
  const unrepresentable = join(directory, '启动器目录')
  mkdirSync(unrepresentable, { recursive: true })
  const result = await install({ directory: unrepresentable, workdir: unrepresentable }, {
    detectLauncherCodePage: async () => ({ codePage: 437, source: 'stub', detail: 'stub' }),
  })
  assert.equal(result.ok, true, `${String(result.reason)}: ${String(result.hint)}`)
  assert.equal(result.encoding, 'utf8')
  assert.equal(result.codePage, 65001)
  assert.match(result.warnings.join(' '), /switches itself to UTF-8/)
  assert.equal(readFileSync(result.path).subarray(0, 11).toString('latin1'), '@echo off\r\n')
  assert.match(readFileSync(result.path, 'utf8'), /启动器目录/)
  assert.match(readFileSync(result.path, 'utf8'), /启动器目录/)
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
    detectLauncherCodePage: async () => ({ codePage: 936, source: 'stub', detail: 'stub' }),
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

test('onlyIfAbsent never replaces, whatever is already there', async () => {
  // Nothing on disk: it creates one.
  const fresh = await install({ onlyIfAbsent: true })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.unchanged, false)

  // Its own launcher: left exactly as it is, even when the settings changed.
  const again = await install({ onlyIfAbsent: true, port: 3111 })
  assert.equal(again.ok, true)
  assert.equal(again.unchanged, true)
  assert.match(readFileSync(again.path, 'utf8'), /set "PORT=3080"/, 'the installed port was not rewritten')

  // A file that merely has the same name: untouched, and not treated as a refusal.
  const foreignDirectory = mkdtempSync(join(tmpdir(), 'dsh-launch-absent-'))
  created.push(foreignDirectory)
  writeFileSync(join(foreignDirectory, 'DSH.bat'), 'not ours\r\n')
  const foreign = await installLauncher(
    { directory: foreignDirectory, fileName: 'DSH.bat', workdir: foreignDirectory, onlyIfAbsent: true, verify: 'none' },
    deps(),
  )
  assert.equal(foreign.ok, true)
  assert.equal(foreign.unchanged, true)
  assert.equal(readFileSync(join(foreignDirectory, 'DSH.bat'), 'utf8'), 'not ours\r\n')
})

test('onlyIfAbsent finds a launcher saved under the other shipped name', async () => {
  // No explicit name: the launcher was written in whichever language the
  // console implied at the time, so both shipped names have to be considered.
  const name = DEFAULT_FILE_NAMES.en
  writeFileSync(join(directory, name), 'rem @dsh-launch-in-one-click v1.0.0\r\n')
  const result = await install({ fileName: undefined, onlyIfAbsent: true })
  assert.equal(result.ok, true)
  assert.equal(result.unchanged, true)
  assert.equal(result.fileName, name, 'the file that is already there is the one reported')
})

test('backups do not pile up: only the newest survives', async () => {
  // Reported from a real Desktop: two files, and no idea what the second was.
  await install({ port: 3080 })
  await install({ port: 3111 })
  let remaining = backupsIn(directory)
  assert.equal(remaining.length, 1, 'the first replacement keeps one backup')
  assert.match(readFileSync(join(directory, remaining[0]), 'utf8'), /set "PORT=3080"/, 'holding the state it replaced')

  await install({ port: 3222 })
  remaining = backupsIn(directory)
  assert.equal(remaining.length, 1, 'the older backup is removed rather than accumulated')
  assert.match(readFileSync(join(directory, remaining[0]), 'utf8'), /set "PORT=3111"/, 'and the survivor is the most recent state')
})

test('pruning touches nothing but this launcher\u2019s own backups', async () => {
  writeFileSync(join(directory, 'SomeoneElses.bak'), 'keep me\r\n')
  writeFileSync(join(directory, 'DSH.bat.backup'), 'not our naming\r\n')
  await install({ port: 3080 })
  await install({ port: 3111 })
  assert.equal(readFileSync(join(directory, 'SomeoneElses.bak'), 'utf8'), 'keep me\r\n')
  assert.equal(readFileSync(join(directory, 'DSH.bat.backup'), 'utf8'), 'not our naming\r\n')
  assert.equal(backupsIn(directory).length, 1)
})

/** The backups this launcher left behind in a directory. */
function backupsIn(target) {
  return readdirSync(target).filter((entry) => entry.startsWith('DSH.bat.') && entry.endsWith('.bak'))
}

test('the installed launcher is found under either shipped name', async () => {
  // Exercised through the real function, not a stub: the language switch reads
  // this to keep the port and workspace it is switching the language of.
  assert.equal(await findInstalledLauncher({ directory }, deps()), null)

  writeFileSync(join(directory, 'SomeoneElses.bat'), 'not ours\r\n')
  assert.equal(await findInstalledLauncher({ directory }, deps()), null, 'a foreign file is not a launcher of ours')

  const written = await install({ fileName: DEFAULT_FILE_NAMES.en })
  assert.equal(written.ok, true, `${String(written.reason)}: ${String(written.hint)}`)

  const found = await findInstalledLauncher({ directory }, deps())
  assert.equal(found.owned, true)
  assert.equal(found.config.port, '3080')
  assert.equal(found.fileName, DEFAULT_FILE_NAMES.en)
})

test('a recorded work directory survives inspection in a non-ASCII path', async () => {
  // The launcher stores the work directory in its own code page, so the marker
  // reader has to decode the values the same way the launcher tells cmd to.
  // Reading them as latin1 turned 方向容 into mojibake that the language switch
  // would then have written into the regenerated launcher.
  const chinese = join(directory, '工作区')
  mkdirSync(chinese, { recursive: true })
  const written = await install({ fileName: DEFAULT_FILE_NAMES.zh, workdir: chinese, port: 3111 })
  assert.equal(written.ok, true, `${String(written.reason)}: ${String(written.hint)}`)

  const found = await findInstalledLauncher({ directory }, deps())
  assert.equal(found.config.workdir, chinese)
  assert.equal(found.config.port, '3111')
})

test('the real runner executes the launcher and reports its dry run', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows only')
    return
  }
  const path = join(directory, 'real.bat')
  // A port nothing is listening on, taken and released, so the launcher reaches
  // its dry-run plan instead of refusing a busy port on a shared runner.
  const free = await reserveFreePort()
  const written = await install({ fileName: 'real.bat', port: free }, { verifyLauncherByRunning })
  assert.equal(written.ok, true)
  assert.equal(written.verified, true)
  assert.equal(written.verification.exitCode, 0)
  assert.match(written.verification.output, /cd \/d/)

  const output = readFileSync(path)
  assert.equal(output.subarray(0, 11).toString('latin1'), '@echo off\r\n')
})
