/**
 * Load-time provisioning and auto-update: the behaviour a marketplace install
 * depends on.
 *
 * The promise being tested is narrow on purpose — create when the Desktop has no
 * launcher, refresh one that an older build wrote, leave everything else alone,
 * and never block or break the plugin load.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeProvision, provisionLauncher } from '../src/provision.js'
import { PLUGIN_VERSION } from '../src/install.js'

/** A stub installer that records what it was asked to do. */
function stubInstall(result) {
  const calls = []
  const install = async (options) => {
    calls.push(options)
    return result
  }
  return { calls, install }
}

/** A finder that reports one installed launcher of the given version. */
function stubFind(installed) {
  const calls = []
  return {
    calls,
    find: async (options) => {
      calls.push(options ?? {})
      return installed
    },
  }
}

test('an absent launcher is created with the deployment settings', async () => {
  const stub = stubInstall({ ok: true, unchanged: false, path: 'C:\\Users\\me\\Desktop\\DSH.bat', port: 3080, encoding: 'gbk' })
  const outcome = await provisionLauncher(
    { port: 3080, workdir: 'C:\\work', runner: 'npx', language: 'auto', packageSpec: '@deepseek-ai/dsh', openBrowser: true },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(null).find },
  )
  assert.equal(outcome.action, 'installed')
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].workdir, 'C:\\work')
  assert.equal(stub.calls[0].onlyIfAbsent, true, 'a load must never replace an installed launcher')
  assert.equal(stub.calls[0].verify, 'none', 'a silent install must not spawn a self-test')
  assert.match(describeProvision(outcome), /created/)
})

test('provisionOnLoad false leaves an empty Desktop empty', async () => {
  const stub = stubInstall({ ok: true })
  const outcome = await provisionLauncher(
    { port: 3080, provisionOnLoad: false },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(null).find },
  )
  assert.equal(outcome.action, 'skipped')
  assert.equal(outcome.reason, 'provisioning-disabled')
  assert.equal(stub.calls.length, 0)
})

test('an existing launcher is left alone', async () => {
  const stub = stubInstall({ ok: true, unchanged: true, path: 'C:\\Users\\me\\Desktop\\DSH.bat', existing: 'ours' })
  const outcome = await provisionLauncher(
    { port: 3080 },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(null).find },
  )
  assert.equal(outcome.action, 'kept-existing')
  assert.match(describeProvision(outcome), /already on the Desktop/)
})

test('a launcher needs no maintenance when it already matches this build', async () => {
  const stub = stubInstall({ ok: true })
  const installed = { exists: true, owned: true, version: PLUGIN_VERSION, fileName: 'DSH.bat', config: { port: '3080' } }
  const outcome = await provisionLauncher(
    { port: 3080 },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(installed).find },
  )
  assert.equal(outcome.action, 'kept-existing')
  assert.equal(outcome.reason, 'current')
  assert.equal(stub.calls.length, 0, 'a current launcher is not rewritten at all')
  assert.equal(describeProvision(outcome), null, 'and nothing is worth logging')
})

test('a launcher written by an older build is refreshed, keeping its settings', async () => {
  const stub = stubInstall({ ok: true, unchanged: false, path: 'C:\\Users\\me\\Desktop\\Launch DeepSeek Harness.bat', port: 3111 })
  const installed = {
    exists: true,
    owned: true,
    version: '0.9.0',
    fileName: 'Launch DeepSeek Harness.bat',
    config: { port: '3111', runner: 'dsh', lang: 'en', cp: '936', openBrowser: '0', workdir: 'D:\\work' },
  }
  const outcome = await provisionLauncher(
    { port: 3080, workdir: 'C:\\elsewhere', runner: 'npx', language: 'auto', openBrowser: true, packageSpec: '@deepseek-ai/dsh' },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(installed).find },
  )
  assert.equal(outcome.action, 'updated')
  assert.equal(outcome.from, '0.9.0')
  assert.deepEqual(
    {
      port: stub.calls[0].port,
      workdir: stub.calls[0].workdir,
      runner: stub.calls[0].runner,
      language: stub.calls[0].language,
      openBrowser: stub.calls[0].openBrowser,
      fileName: stub.calls[0].fileName,
      verify: stub.calls[0].verify,
    },
    {
      port: 3111,
      workdir: 'D:\\work',
      runner: 'dsh',
      language: 'en',
      openBrowser: false,
      fileName: 'Launch DeepSeek Harness.bat',
      verify: 'none',
    },
    'a template refresh must not move the port, workspace, runner, language, or browser behaviour',
  )
  assert.match(describeProvision(outcome), /updated .* from v0\.9\.0/)
})

test('autoUpdate false keeps an outdated launcher exactly as it is', async () => {
  const stub = stubInstall({ ok: true })
  const installed = { exists: true, owned: true, version: '0.9.0', fileName: 'DSH.bat', config: { port: '3080' } }
  const outcome = await provisionLauncher(
    { port: 3080, autoUpdate: false },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(installed).find },
  )
  assert.equal(outcome.action, 'kept-existing')
  assert.equal(outcome.reason, 'auto-update-disabled')
  assert.equal(stub.calls.length, 0)
})

test('a launcher whose version cannot be read is not guessed at', async () => {
  const stub = stubInstall({ ok: true })
  const installed = { exists: true, owned: true, version: null, fileName: 'DSH.bat', config: null }
  const outcome = await provisionLauncher(
    { port: 3080 },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(installed).find },
  )
  assert.equal(outcome.action, 'kept-existing')
  assert.equal(outcome.reason, 'version-unreadable')
  assert.equal(stub.calls.length, 0, 'rewriting a file whose provenance is unknown is how user edits get lost')
})

test('a failure is reported, never thrown', async () => {
  const stub = stubInstall({ ok: false, reason: 'directory-not-writable' })
  const outcome = await provisionLauncher(
    { port: 3080 },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(null).find },
  )
  assert.equal(outcome.action, 'failed')
  assert.equal(outcome.reason, 'directory-not-writable')
  assert.match(describeProvision(outcome), /could not create/)
})

test('an installer that throws does not escape into the plugin load', async () => {
  const outcome = await provisionLauncher({ port: 3080 }, {
    installLauncher: async () => { throw new Error('spawn EPERM') },
    findInstalledLauncher: async () => null,
  })
  assert.equal(outcome.action, 'failed')
  assert.match(outcome.reason, /EPERM/)
})

test('a finder that throws does not escape either', async () => {
  const outcome = await provisionLauncher({ port: 3080 }, {
    findInstalledLauncher: async () => { throw new Error('EPERM: desktop unreadable') },
  })
  assert.equal(outcome.action, 'failed')
  assert.match(outcome.reason, /unreadable/)
})

test('nothing is attempted on a host that cannot run the launcher', async () => {
  const stub = stubInstall({ ok: true })
  const outcome = await provisionLauncher(
    { port: 3080, platform: 'linux' },
    { installLauncher: stub.install, findInstalledLauncher: stubFind(null).find },
  )
  assert.equal(outcome.action, 'skipped')
  assert.equal(stub.calls.length, 0)
  assert.equal(describeProvision(outcome), null, 'nothing worth logging')
})
