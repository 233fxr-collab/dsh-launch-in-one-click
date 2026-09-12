/**
 * End-to-end: generate a launcher, then run it with real cmd.exe and judge it
 * by its exit code.
 *
 * This is the test that would have caught the two defects the generator's own
 * unit tests could not: a file written with bare LF endings, which cmd reads as
 * one enormous line, and a code page switch placed after the first multi-byte
 * character. Both produced a launcher that looked correct in every string
 * assertion and failed the moment it ran.
 *
 * Every launcher is decoded with the code page THAT install chose, and asserted
 * against the language THAT install resolved. A launcher runs `chcp`, and a
 * `cmd /c` child shares the console it was started from, so running a launcher
 * changes the code page the next install detects. That is the launcher behaving
 * correctly — it forces its own code page so its own bytes always match — but it
 * makes any single code page cached for the whole file meaningless.
 *
 * The port verdicts are exercised against real listeners: a real HTTP server
 * answering like a Harness web server, a real HTTP server that does not, and a
 * real free port.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DSH_FINGERPRINT } from '../src/probe-script.js'
import { makeDecoder } from '../src/encoding.js'
import { EXIT } from '../src/exit-codes.js'
import { installLauncher } from '../src/install.js'
import { runCommand } from '../src/run.js'

const windowsOnly = process.platform === 'win32'
const created = []
let directory
let harnessServer
let harnessPort
let foreignServer
let foreignPort
let freePort

/** Start a listener on an ephemeral port and resolve it. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address().port) })
  })
}

/** Find a port nothing is listening on, by taking one and letting it go. */
async function reserveFreePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve) => { server.close(resolve) })
  return port
}

before(async () => {
  if (!windowsOnly) return
  directory = mkdtempSync(join(tmpdir(), 'dsh-launch-e2e-'))
  created.push(directory)

  harnessServer = http.createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`${DSH_FINGERPRINT}; reopen the URL printed by dsh web.\n`)
  })
  harnessPort = await listen(harnessServer)

  foreignServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello from an unrelated server')
  })
  foreignPort = await listen(foreignServer)

  freePort = await reserveFreePort()
})

after(async () => {
  if (!windowsOnly) return
  await new Promise((resolve) => { harnessServer.close(resolve) })
  await new Promise((resolve) => { foreignServer.close(resolve) })
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

/**
 * Install a launcher and return it with the decisions that install made.
 * @returns The path, and the code page, language, and encoding it was written in.
 */
async function write(fileName, options = {}, overrides = {}) {
  const result = await installLauncher(
    { directory, fileName, workdir: directory, verify: 'none', ...options },
    overrides,
  )
  assert.equal(result.ok, true, `install failed: ${String(result.reason)} ${String(result.hint)}`)
  return { path: result.path, codePage: result.codePage, language: result.language, encoding: result.encoding }
}

/** Run a launcher the way a user would, decoding it the way it was written. */
async function run(launcher, args = [], env = process.env) {
  const line = `""${launcher.path}"${args.length > 0 ? ` ${args.join(' ')}` : ''}"`
  const result = await runCommand('cmd', ['/c', line], {
    env,
    windowsVerbatimArguments: true,
    decode: makeDecoder(launcher.codePage),
    timeoutMs: 60000,
  })
  return { code: result.code, output: `${result.stdout}${result.stderr}`, failure: result.failure }
}

/** Pick the expected text for the language this launcher was generated in. */
function phrase(launcher, zh, en) {
  return launcher.language === 'zh' ? zh : en
}

test('a launcher on a free port plans the run and exits 0', { skip: !windowsOnly }, async () => {
  const launcher = await write('free.bat', { port: freePort })
  const result = await run(launcher, ['--dry-run'])
  assert.equal(result.failure, undefined)
  assert.equal(result.code, EXIT.OK, result.output)
  assert.match(result.output, new RegExp(`web --port ${String(freePort)}`))
  assert.match(result.output, /cd \/d/)
})

test('a launcher refuses to start a second instance on the harness port', { skip: !windowsOnly }, async () => {
  const launcher = await write('harness.bat', { port: harnessPort })
  const result = await run(launcher, ['--dry-run'])
  assert.equal(result.code, EXIT.PORT_DSH, result.output)
  assert.match(result.output, phrase(launcher, /不会启动第二个实例/, /second one is not started/))
  assert.match(result.output, /401/)
})

test('a launcher refuses a port held by something else, and names the holder', { skip: !windowsOnly }, async () => {
  const launcher = await write('foreign.bat', { port: foreignPort })
  const result = await run(launcher, ['--dry-run'])
  assert.equal(result.code, EXIT.PORT_FOREIGN, result.output)
  assert.match(result.output, phrase(launcher, /被其它程序占用/, /held by another program/))
  assert.match(result.output, /PID: \d+/)
})

test('the launcher prints in the language its code page implies', { skip: !windowsOnly }, async () => {
  const launcher = await write('lang.bat', { port: freePort })
  const result = await run(launcher, ['--dry-run'])
  assert.equal(result.code, EXIT.OK, result.output)
  if (launcher.language === 'zh') {
    assert.match(result.output, /试运行结束/, `code page ${String(launcher.codePage)} resolves to Chinese`)
  } else {
    assert.match(result.output, /Dry run finished/, `code page ${String(launcher.codePage)} resolves to English`)
  }
})

test('an explicit language is honoured whatever the console reports', { skip: !windowsOnly }, async () => {
  const launcher = await write('forced-zh.bat', { port: freePort, language: 'zh' })
  assert.equal(launcher.language, 'zh')
  const result = await run(launcher, ['--dry-run'])
  assert.equal(result.code, EXIT.OK, result.output)
  assert.match(result.output, /试运行结束/)
})

test('the runner can be baked as the installed command instead of npx', { skip: !windowsOnly }, async () => {
  const launcher = await write('runner.bat', { port: freePort, runner: 'dsh' })
  const result = await run(launcher, ['--dry-run'])
  // `dsh` is not installed in this test environment, so the environment check
  // is what should stop it — before any port work.
  assert.ok([EXIT.OK, EXIT.NO_NODE].includes(result.code), result.output)
})

test('--port overrides the baked port and is validated', { skip: !windowsOnly }, async () => {
  const launcher = await write('override.bat', { port: freePort })
  const good = await run(launcher, ['--dry-run', '--port', String(harnessPort)])
  assert.equal(good.code, EXIT.PORT_DSH, good.output)

  for (const bad of ['abc', '0', '70000', '-1']) {
    const result = await run(launcher, ['--dry-run', '--port', bad])
    assert.equal(result.code, EXIT.BAD_ARGS, `expected ${bad} to be a usage error: ${result.output}`)
  }
})

test('--help prints the usage and exits 0', { skip: !windowsOnly }, async () => {
  const launcher = await write('help.bat', { port: freePort })
  const result = await run(launcher, ['--help'])
  assert.equal(result.code, EXIT.OK)
  assert.match(result.output, /--dry-run/)
  assert.match(result.output, /--workdir/)
})

test('an unknown argument is a usage error', { skip: !windowsOnly }, async () => {
  const launcher = await write('unknown.bat', { port: freePort })
  const result = await run(launcher, ['--nonsense'])
  assert.equal(result.code, EXIT.BAD_ARGS, result.output)
})

test('a missing work directory stops the run before the port check', { skip: !windowsOnly }, async () => {
  const launcher = await write('workdir.bat', { port: freePort })
  const missing = join(directory, 'gone', 'away')
  const result = await run(launcher, ['--dry-run', '--workdir', missing])
  assert.equal(result.code, EXIT.BAD_WORKDIR, result.output)
})

test('a host with no node on PATH is reported as such', { skip: !windowsOnly }, async () => {
  const launcher = await write('nonode.bat', { port: freePort })
  const stripped = { ...process.env, PATH: 'C:\\Windows\\System32', Path: 'C:\\Windows\\System32' }
  const result = await run(launcher, ['--dry-run'], stripped)
  assert.equal(result.code, EXIT.NO_NODE, result.output)
})

test('the installed launcher is byte-stable across runs', { skip: !windowsOnly }, async () => {
  const first = await write('stable.bat', { port: freePort })
  const second = await installLauncher({ directory, fileName: 'stable.bat', workdir: directory, port: freePort, verify: 'none' })
  assert.equal(second.unchanged, true)
  assert.equal(second.path, first.path)
})
