/**
 * Load-time provisioning: the behaviour a marketplace install depends on.
 *
 * The promise being tested is narrow on purpose — create when the Desktop has
 * no launcher, do nothing otherwise, never block or break the plugin load.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeProvision, provisionLauncher } from '../src/provision.js'

/** A stub installer that records what it was asked to do. */
function stubInstall(result) {
  const calls = []
  const install = async (options) => {
    calls.push(options)
    return result
  }
  return { calls, install }
}

test('an absent launcher is created with the deployment settings', async () => {
  const stub = stubInstall({ ok: true, unchanged: false, path: 'C:\\Users\\me\\Desktop\\DSH.bat', port: 3080, encoding: 'gbk' })
  const outcome = await provisionLauncher(
    { port: 3080, workdir: 'C:\\work', runner: 'npx', language: 'auto', packageSpec: '@deepseek-ai/dsh', openBrowser: true },
    { installLauncher: stub.install },
  )
  assert.equal(outcome.action, 'installed')
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].workdir, 'C:\\work')
  assert.equal(stub.calls[0].onlyIfAbsent, true, 'a load must never replace an installed launcher')
  assert.equal(stub.calls[0].verify, 'none', 'a silent install must not spawn a self-test')
  assert.match(describeProvision(outcome), /created/)
})

test('an existing launcher is left alone', async () => {
  const stub = stubInstall({ ok: true, unchanged: true, path: 'C:\\Users\\me\\Desktop\\DSH.bat', existing: 'ours' })
  const outcome = await provisionLauncher({ port: 3080 }, { installLauncher: stub.install })
  assert.equal(outcome.action, 'kept-existing')
  assert.match(describeProvision(outcome), /already on the Desktop/)
})

test('a failure is reported, never thrown', async () => {
  const stub = stubInstall({ ok: false, reason: 'directory-not-writable' })
  const outcome = await provisionLauncher({ port: 3080 }, { installLauncher: stub.install })
  assert.equal(outcome.action, 'failed')
  assert.equal(outcome.reason, 'directory-not-writable')
  assert.match(describeProvision(outcome), /could not create/)
})

test('an installer that throws does not escape into the plugin load', async () => {
  const outcome = await provisionLauncher({ port: 3080 }, {
    installLauncher: async () => { throw new Error('spawn EPERM') },
  })
  assert.equal(outcome.action, 'failed')
  assert.match(outcome.reason, /EPERM/)
})

test('nothing is attempted on a host that cannot run the launcher', async () => {
  const stub = stubInstall({ ok: true })
  const outcome = await provisionLauncher({ port: 3080, platform: 'linux' }, { installLauncher: stub.install })
  assert.equal(outcome.action, 'skipped')
  assert.equal(stub.calls.length, 0)
  assert.equal(describeProvision(outcome), null, 'nothing worth logging')
})
