/**
 * The plugin surface: registration against a stub context, the slash-command
 * grammar, and — when the harness packages resolve — the real `defineTool`
 * compiler, which is the authority on whether a declared schema is legal.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Config, apply, inject, name, parseLaunchInput } from '../src/index.js'
import { PLUGIN_VERSION } from '../src/install.js'

/** A Cordis context that records what the plugin registers. */
function stubContext() {
  const tools = []
  const commands = []
  const logs = []
  return {
    tools,
    commands,
    logs,
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    tools_register: undefined,
    register(definition) { tools.push(definition) },
    inject(deps, callback) {
      this.injected = deps
      callback({ commands: { register: (command) => commands.push(command) } })
    },
  }
}

/** Apply the plugin to a stub context of the documented shape. */
function applyToStub(overrides = {}) {
  const context = { ...stubContext(), ...overrides }
  context.tools = { register: (definition) => { context.registered.push(definition) } }
  context.registered = []
  apply(context, undefined)
  return context
}

test('the plugin declares its identity and its one required service', () => {
  assert.equal(name, 'launch-in-one-click')
  assert.deepEqual(inject, ['tools'])
})

test('configuration carries every documented default', () => {
  const resolved = new Config({})
  assert.equal(resolved.defaultPort, 3080)
  assert.equal(resolved.language, 'auto')
  assert.equal(resolved.runner, 'npx')
  assert.equal(resolved.packageSpec, '@deepseek-ai/dsh')
  assert.equal(resolved.openBrowser, true)
})

test('applying registers three tools and one command', () => {
  const context = applyToStub()
  assert.deepEqual(context.registered.map((entry) => entry.name).sort(), ['launcher_doctor', 'launcher_install', 'launcher_uninstall'])
  assert.deepEqual(context.injected, ['commands'])
  assert.equal(context.commands.length, 1)
  assert.equal(context.commands[0].name, 'launch')
})

test('the version in the plugin matches the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, PLUGIN_VERSION)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies['iconv-lite'] !== undefined, true)
  // Peers are exactly what the plugin imports at runtime. cordis loads the
  // plugin rather than being imported by it, and `commands` arrives through
  // ctx.inject, so neither is a peer dependency here.
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'])
  for (const peer of Object.keys(manifest.peerDependencies)) {
    assert.equal(manifest.dependencies[peer], undefined, `${peer} must not be a bundled dependency`)
  }
})

test('the peer range admits every published harness prerelease', (t) => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']

  // node-semver only lets a prerelease satisfy a range when some comparator
  // carries that exact major.minor.patch tuple AND a prerelease tag, so a range
  // like ">=0.0.1-rc.1 <0.2.0" silently excludes 0.1.5-rc.2. The published
  // tuples below are the ones users can actually be running.
  const requiredTuples = ['0.0.1', '0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.5']
  const comparators = [...range.matchAll(/(?:>=|\^|~)?(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+/g)].map((match) => match[1])
  const missing = requiredTuples.filter((tuple) => !comparators.includes(tuple))
  assert.deepEqual(missing, [], `a prerelease on these tuples would hit ERESOLVE: ${missing.join(', ')}`)
  assert.match(range, /<0\.2\.0-0/, 'the upper bound must be an explicit prerelease bound')

  const installed = installedHarnessVersion()
  if (installed === null) {
    t.diagnostic('harness packages are not installed here; checked the range statically')
    return
  }
  if (!installed.includes('-')) return
  const tuple = installed.split('-')[0]
  assert.ok(
    comparators.includes(tuple),
    `the harness installed here (${installed}) would not satisfy the declared peer range`,
  )
})

/**
 * The harness version resolvable from this checkout, or `null` when the peer
 * packages are not installed (the normal case for a fresh clone).
 */
function installedHarnessVersion() {
  try {
    const path = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json')
    return JSON.parse(readFileSync(path, 'utf8')).version
  } catch {
    return null
  }
}

test('the command grammar accepts the documented switches', () => {
  assert.deepEqual(parseLaunchInput('').error, null)
  assert.equal(parseLaunchInput('doctor').doctor, true)
  assert.equal(parseLaunchInput('--port 3111').port, 3111)
  assert.equal(parseLaunchInput('--name Custom.bat').fileName, 'Custom.bat')
  assert.equal(parseLaunchInput('--overwrite').overwrite, true)
  assert.equal(parseLaunchInput('--dry-run').dryRun, true)
  assert.equal(parseLaunchInput('doctor --port 3111 --dry-run').port, 3111)
})

test('the command grammar rejects what it cannot honour', () => {
  assert.match(parseLaunchInput('--port abc').error, /integer/)
  assert.match(parseLaunchInput('--port').error, /integer/)
  assert.match(parseLaunchInput('--port 70000').error, /integer/)
  assert.match(parseLaunchInput('--name').error, /file name/)
  assert.match(parseLaunchInput('--wat').error, /Unrecognized/)
  assert.match(parseLaunchInput('--help').error, /Usage/)
})

test('the doctor report renders one line per check', () => {
  const rendered = renderDoctorFixture()
  assert.match(rendered, /\[ok\] node:/)
  assert.match(rendered, /\[warn\] port:/)
  assert.match(rendered, /1 failing/)
})

/** Exercise the doctor renderer through a stubbed diagnosis. */
function renderDoctorFixture() {
  const context = applyToStub()
  const doctor = context.registered.find((entry) => entry.name === 'launcher_doctor')
  const value = {
    ok: false,
    platform: 'win32',
    codePage: 936,
    port: 3080,
    portState: 'dsh',
    portOwner: 'PID 1 node.exe',
    directory: 'C:\\Users\\me\\Desktop',
    directorySource: 'known-folder',
    writable: true,
    targetPath: 'C:\\Users\\me\\Desktop\\DSH.bat',
    installed: 'none',
    launcherVersion: null,
    launcherBytes: 0,
    nodeVersion: '22.23.2',
    runner: 'npx',
    runnerPath: 'C:\\nodejs\\npx.cmd',
    checks: [
      { id: 'node', status: 'ok', detail: 'Node 22.23.2' },
      { id: 'port', status: 'warn', detail: 'serves a harness' },
      { id: 'directory', status: 'fail', detail: 'missing' },
    ],
    summary: { ok: 1, warn: 1, fail: 1, info: 0, skip: 0 },
  }
  const blocks = doctor.output.render({}, value)
  return blocks.map((block) => block.text).join('\n')
}
