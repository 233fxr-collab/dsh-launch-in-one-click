/**
 * The diagnosis. Two layers are covered deliberately: the report logic with
 * stubbed probes, and one real run with nothing stubbed, because a stubbed run
 * cannot catch a doctor that only fails when it actually asks this machine
 * something.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { parseNodeVersion, runDoctor } from '../src/doctor.js'
import { installLauncher } from '../src/install.js'
import { PLUGIN_VERSION } from '../src/install.js'

let directory

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-launch-doctor-'))
})

after(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Every probe answered without touching the machine. */
function deps(overrides = {}) {
  return {
    detectLauncherCodePage: async () => ({ codePage: 936, source: 'stub', detail: 'stub' }),
    resolveDesktopDirectory: async () => ({ path: directory, source: 'stub', candidates: [] }),
    probeWritableDirectory: async () => ({ writable: true, reason: null }),
    runPortProbe: async () => ({ state: 'free', detail: 'free' }),
    findPortOwner: async () => ({ supported: true, pids: [], names: [] }),
    verifyLauncherByRunning: async () => ({ ran: true, exitCode: 0, output: '', ok: true, reason: null }),
    readCachedHarnessVersion: () => '0.1.5-rc.2',
    fetchPublishedHarnessVersion: async () => null,
    run: async (command, args) => {
      if (/(^|[\\/])node(\.exe)?$/i.test(command)) return { code: 0, stdout: 'v22.23.2\r\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    },
    ...overrides,
  }
}

test('node version lines are parsed, including a bare version', () => {
  assert.deepEqual(parseNodeVersion('v22.23.2\r\n'), { version: '22.23.2', major: 22 })
  assert.deepEqual(parseNodeVersion('20.11.0'), { version: '20.11.0', major: 20 })
  assert.deepEqual(parseNodeVersion('nonsense'), { version: null, major: null })
  assert.deepEqual(parseNodeVersion(''), { version: null, major: null })
})

test('a healthy machine reports no failures', async () => {
  const report = await runDoctor({ port: 3080 }, deps())
  assert.equal(report.ok, true)
  assert.equal(report.summary.fail, 0)
  assert.equal(report.portState, 'free')
  assert.equal(report.targetPath, join(directory, '启动 DeepSeek Harness.bat'))
  assert.equal(report.installed, 'none')
  assert.equal(report.nodeVersion, '22.23.2')
  assert.ok(report.checks.some((entry) => entry.id === 'node' && entry.status === 'ok'))
})

test('an old node is a warning, not a failure', async () => {
  const report = await runDoctor({}, deps({
    run: async () => ({ code: 0, stdout: 'v18.20.4\r\n', stderr: '' }),
  }))
  const node = report.checks.find((entry) => entry.id === 'node')
  assert.equal(node.status, 'warn')
  assert.match(node.detail, /older than the 22/)
  assert.equal(report.ok, true)
})

test('a missing node is a failure with the consequence spelled out', async () => {
  const report = await runDoctor({}, deps({
    run: async () => ({ code: 1, stdout: '', stderr: '', failure: 'ENOENT' }),
  }))
  const node = report.checks.find((entry) => entry.id === 'node')
  assert.equal(node.status, 'fail')
  assert.equal(report.ok, false)
})

test('a port serving a harness is reported with its owner', async () => {
  const report = await runDoctor({ port: 3080 }, deps({
    runPortProbe: async () => ({ state: 'dsh', detail: 'dsh' }),
    findPortOwner: async () => ({ supported: true, pids: [15024], names: [{ pid: 15024, name: 'node.exe' }] }),
  }))
  const port = report.checks.find((entry) => entry.id === 'port')
  assert.equal(port.status, 'warn')
  assert.match(port.detail, /PID 15024 node\.exe/)
  assert.equal(report.portOwner, 'PID 15024 node.exe')
  assert.equal(report.ok, true, 'a busy port is the launcher\'s normal refusal, not a broken machine')
})

test('a port held by something else is reported as something else', async () => {
  const report = await runDoctor({ port: 3111 }, deps({
    runPortProbe: async () => ({ state: 'foreign', detail: 'foreign:200' }),
    findPortOwner: async () => ({ supported: true, pids: [42], names: [] }),
  }))
  assert.match(report.checks.find((entry) => entry.id === 'port').detail, /held by something else/)
  assert.equal(report.portOwner, 'PID 42')
})

test('a probe that reaches no verdict is a failure', async () => {
  const report = await runDoctor({}, deps({ runPortProbe: async () => ({ state: 'error', detail: 'error:EACCES' }) }))
  assert.equal(report.checks.find((entry) => entry.id === 'port').status, 'fail')
  assert.equal(report.ok, false)
})

test('an unwritable Desktop is a failure', async () => {
  const report = await runDoctor({}, deps({ probeWritableDirectory: async () => ({ writable: false, reason: 'EACCES' }) }))
  const writable = report.checks.find((entry) => entry.id === 'directory-writable')
  assert.equal(writable.status, 'fail')
  assert.match(writable.detail, /EACCES/)
})

test('a foreign file at the target path is reported before an install is attempted', async () => {
  const target = join(directory, '启动 DeepSeek Harness.bat')
  writeFileSync(target, 'mine\r\n')
  const report = await runDoctor({}, deps())
  assert.equal(report.installed, 'foreign')
  assert.equal(report.checks.find((entry) => entry.id === 'launcher').status, 'warn')
  rmSync(target)
})

test('an installed launcher is recognized with its version', async () => {
  await installLauncher(
    { directory, fileName: 'doctor-installed.bat', workdir: directory, verify: 'none' },
    deps({ verifyLauncherByRunning: async () => ({ ran: true, exitCode: 0, output: '', ok: true, reason: null }) }),
  )
  const report = await runDoctor({ fileName: 'doctor-installed.bat' }, deps())
  assert.equal(report.installed, 'ours')
  assert.equal(report.launcherVersion, PLUGIN_VERSION, 'a launcher this build wrote reports this build\u2019s version')
  assert.equal(report.checks.find((entry) => entry.id === 'launcher').status, 'ok')
})

test('a bad port is refused before any probing', async () => {
  const report = await runDoctor({ port: 0 }, deps())
  assert.equal(report.port, null)
  assert.equal(report.ok, false)
  assert.equal(report.checks.find((entry) => entry.id === 'port').status, 'fail')
})

test('the harness check reads the cache, and the registry only when asked', async () => {
  const cached = await runDoctor({}, deps({ readCachedHarnessVersion: () => '0.1.4' }))
  const cachedCheck = cached.checks.find((entry) => entry.id === 'harness')
  assert.equal(cachedCheck.status, 'ok')
  assert.match(cachedCheck.detail, /0\.1\.4 is cached/)
  assert.equal(cached.harnessPublished, null, 'no network call unless check_registry is set')

  const stale = await runDoctor({ checkRegistry: true }, deps({
    readCachedHarnessVersion: () => '0.1.4',
    fetchPublishedHarnessVersion: async () => '0.1.5-rc.2',
  }))
  const staleCheck = stale.checks.find((entry) => entry.id === 'harness')
  assert.equal(staleCheck.status, 'warn')
  assert.match(staleCheck.detail, /0\.1\.5-rc\.2 is published/)
  assert.match(staleCheck.detail, /next start downloads/)
  assert.equal(stale.harnessPublished, '0.1.5-rc.2')

  const current = await runDoctor({ checkRegistry: true }, deps({
    readCachedHarnessVersion: () => '0.1.5-rc.2',
    fetchPublishedHarnessVersion: async () => '0.1.5-rc.2',
  }))
  assert.equal(current.checks.find((entry) => entry.id === 'harness').status, 'ok')

  const prerelease = await runDoctor({ checkRegistry: true }, deps({
    readCachedHarnessVersion: () => '0.1.5-rc.2',
    fetchPublishedHarnessVersion: async () => '0.1.5',
  }))
  assert.equal(prerelease.checks.find((entry) => entry.id === 'harness').status, 'warn', '0.1.5 is newer than 0.1.5-rc.2')

  const empty = await runDoctor({}, deps({ readCachedHarnessVersion: () => null }))
  assert.equal(empty.checks.find((entry) => entry.id === 'harness').status, 'info')
})

test('the doctor runs for real against this machine', { skip: process.platform !== 'win32' }, async () => {
  // No stubs: this is the run that catches a probe that only breaks when it
  // actually asks Windows something.
  const report = await runDoctor({ verifyExecution: false })
  assert.equal(typeof report.ok, 'boolean')
  assert.ok(report.checks.length >= 6, 'a real run reports every check')
  assert.ok(['free', 'dsh', 'foreign', 'error', null].includes(report.portState))
  // A host with no user Desktop folder is a legitimate outcome; what must never
  // happen is silence about it.
  assert.ok(
    report.directory !== null || report.checks.some((entry) => entry.id === 'directory' && entry.status === 'fail'),
    'the Desktop is either resolved or reported as unresolvable',
  )
  for (const entry of report.checks) {
    assert.ok(entry.detail.length > 0, `${entry.id} must explain itself`)
    assert.ok(['ok', 'warn', 'fail', 'info', 'skip'].includes(entry.status))
  }
})
