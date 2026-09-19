/**
 * The plugin surface: registration against a stub context, the slash-command
 * grammar, and — when the harness packages resolve — the real `defineTool`
 * compiler, which is the authority on whether a declared schema is legal.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Config, apply, handleLaunchCommand, inject, name, parseLaunchInput } from '../src/index.js'
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
  // Both provisioning switches off, which is the documented way to load this
  // plugin without touching anything. A test run that left them at their
  // defaults wrote to the developer's real Desktop — measured, not theorised.
  apply(context, { provisionOnLoad: false, autoUpdate: false })
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
  assert.equal(resolved.provisionOnLoad, true, 'a fresh install should put the launcher on the Desktop')
  assert.equal(resolved.autoUpdate, true, 'and keep it matched to the installed build')
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

test('the command can list what it already put on the Desktop', async () => {
  const deployment = { defaultPort: 3080, language: 'auto', runner: 'npx', packageSpec: '@deepseek-ai/dsh', openBrowser: true }
  const launchers = [
    {
      path: 'C:\\Users\\me\\Desktop\\启动 DeepSeek Harness.bat',
      fileName: '启动 DeepSeek Harness.bat',
      version: PLUGIN_VERSION,
      config: { port: '3080', workdir: 'C:\\work', lang: 'zh' },
    },
    { path: 'C:\\Users\\me\\Desktop\\Older.bat', fileName: 'Older.bat', version: '0.9.0', config: { port: '3111' } },
  ]
  const result = await handleLaunchCommand('list', deployment, { list: async () => launchers })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /port 3080/)
  assert.match(result.text, /C:\\work/)
  assert.match(result.text, /port 3111/)
  assert.match(result.text, /refreshes on load/, 'an outdated launcher is named as such')

  const empty = await handleLaunchCommand('list', deployment, { list: async () => [] })
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /No launcher of this plugin is on the Desktop/)
})

test('the command grammar accepts the documented switches', () => {
  assert.deepEqual(parseLaunchInput('').error, null)
  assert.equal(parseLaunchInput('doctor').doctor, true)
  assert.equal(parseLaunchInput('list').list, true)
  assert.equal(parseLaunchInput('--port 3111').port, 3111)
  assert.equal(parseLaunchInput('--name Custom.bat').fileName, 'Custom.bat')
  assert.equal(parseLaunchInput('--overwrite').overwrite, true)
  assert.equal(parseLaunchInput('--dry-run').dryRun, true)
  assert.equal(parseLaunchInput('doctor --port 3111 --dry-run').port, 3111)
})

test('the language switch is part of the command grammar', () => {
  assert.equal(parseLaunchInput('').language, undefined, 'unset means the deployment default')
  assert.equal(parseLaunchInput('--language zh').language, 'zh')
  assert.equal(parseLaunchInput('--language en').language, 'en')
  assert.equal(parseLaunchInput('--language auto').language, 'auto')
  assert.equal(parseLaunchInput('--lang zh').language, 'zh', '--lang is the short form')
  assert.equal(parseLaunchInput('--lang en --port 3111').port, 3111)
  assert.equal(parseLaunchInput('--language zh --language en').language, 'en', 'the last one wins')

  for (const bad of ['--language', '--language fr', '--lang']) {
    const parsed = parseLaunchInput(bad)
    assert.notEqual(parsed.error, null, bad)
    assert.match(parsed.error, /auto, en, zh/, `${bad} must name the values it accepts`)
  }
})

test('so is the usage the command shows', () => {
  assert.match(parseLaunchInput('--help').error, /--lang auto\|en\|zh/)
})

test('the command writes the language it was asked for', async () => {
  const calls = []
  const install = async (options) => {
    calls.push(options)
    return { ok: true, path: 'C:\\Users\\me\\Desktop\\DSH.bat', bytes: 10, encoding: 'gbk', language: options.language, port: options.port, warnings: [] }
  }
  const find = async () => null
  const deployment = { defaultPort: 3080, language: 'auto', runner: 'npx', packageSpec: '@deepseek-ai/dsh', openBrowser: true }

  await handleLaunchCommand('--language en', deployment, { install, find })
  assert.equal(calls.at(-1).language, 'en')

  await handleLaunchCommand('', deployment, { install, find })
  assert.equal(calls.at(-1).language, 'auto', 'no switch keeps the deployment default')

  await handleLaunchCommand('--lang zh', { ...deployment, language: 'en' }, { install, find })
  assert.equal(calls.at(-1).language, 'zh', 'an explicit switch beats the deployment default')

  const refused = await handleLaunchCommand('--language fr', deployment, { install, find })
  assert.equal(refused.kind, 'error')
  assert.equal(calls.length, 3, 'a bad switch never reaches the installer')
})

test('switching language keeps what the installed launcher was written for', async () => {
  const calls = []
  const install = async (options) => {
    calls.push(options)
    return { ok: true, path: 'C:\\Users\\me\\Desktop\\DSH.bat', bytes: 10, encoding: 'utf8', language: options.language, port: options.port, warnings: [] }
  }
  const installed = {
    exists: true,
    owned: true,
    fileName: 'Launch DeepSeek Harness.bat',
    config: { port: '3111', runner: 'dsh', workdir: 'D:\\work', lang: 'en', cp: '936' },
  }
  const deployment = { defaultPort: 3080, language: 'auto', runner: 'npx', packageSpec: '@deepseek-ai/dsh', openBrowser: true }

  await handleLaunchCommand('--lang zh', deployment, { install, find: async () => installed, workdir: 'C:\\elsewhere' })
  assert.deepEqual(
    { port: calls[0].port, workdir: calls[0].workdir, runner: calls[0].runner, fileName: calls[0].fileName },
    { port: 3111, workdir: 'D:\\work', runner: 'dsh', fileName: 'Launch DeepSeek Harness.bat' },
    'a language switch must not move the port, the workspace, or the runner',
  )
  assert.equal(calls[0].language, 'zh')

  // An explicit --port still wins over what is on disk.
  await handleLaunchCommand('--lang zh --port 3222', deployment, { install, find: async () => installed })
  assert.equal(calls[1].port, 3222)

  // With nothing installed, the deployment defaults apply as before.
  await handleLaunchCommand('--lang zh', deployment, { install, find: async () => null })
  assert.equal(calls[2].port, 3080)
  assert.equal(calls[2].runner, 'npx')

  // A dry run predicts the real action, so it reads the installed launcher too —
  // otherwise it would report a different file name than a real switch uses.
  const before = calls.length
  const dry = await handleLaunchCommand('--dry-run', deployment, { install, find: async () => installed })
  assert.equal(calls.length, before + 1)
  assert.equal(calls.at(-1).dryRun, true)
  assert.equal(calls.at(-1).fileName, installed.fileName)
  assert.equal(dry.kind, 'success')
})

test('the command reports the language it installed', async () => {
  const result = await handleLaunchCommand('--lang zh', { defaultPort: 3080, language: 'auto', runner: 'npx' }, {
    install: async () => ({ ok: true, path: 'C:\\DSH.bat', bytes: 20, encoding: 'gbk', language: 'zh', port: 3080, warnings: [] }),
    find: async () => null,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /gbk, zh, port 3080/)
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
