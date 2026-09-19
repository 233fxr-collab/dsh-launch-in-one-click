/**
 * The batch file the plugin generates: its shape, its ordering guarantees, and
 * the marker that lets a later run recognize it as its own.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MARKER_LINE, assertBakeable, normalizeDirectory, readLauncherMarker, renderLauncher, toCrlf } from '../src/bat-template.js'
import { PROBE_SCRIPT, assertEmbeddable, interpretProbe, PROBE_EXIT } from '../src/probe-script.js'
import { encodeForCodePage } from '../src/encoding.js'

/** Render one launcher with the shipped defaults. */
function render(overrides = {}) {
  return renderLauncher({
    version: '1.0.0',
    port: 3080,
    workdir: 'C:\\Users\\me\\projects',
    runner: 'npx',
    packageSpec: '@deepseek-ai/dsh',
    openBrowser: true,
    language: 'zh',
    codePage: 936,
    generatedAt: '2026-01-01T00:00:00.000Z',
    fileName: 'DSH.bat',
    ...overrides,
  })
}

test('the probe survives one trip through node -e inside a batch file', () => {
  assert.doesNotThrow(() => { assertEmbeddable(PROBE_SCRIPT) })
  assert.equal(PROBE_SCRIPT.includes('\n'), false)
  assert.equal(PROBE_SCRIPT.includes('"'), false)
  assert.equal(PROBE_SCRIPT.includes('%'), false)
  assert.throws(() => { assertEmbeddable('say("hi")') }, /cannot survive/)
  assert.throws(() => { assertEmbeddable('a%PATH%b') }, /cannot survive/)
})

test('probe exit codes map to verdicts', () => {
  assert.equal(interpretProbe(PROBE_EXIT.FREE, 'free').state, 'free')
  assert.equal(interpretProbe(PROBE_EXIT.DSH, 'dsh').state, 'dsh')
  assert.equal(interpretProbe(PROBE_EXIT.FOREIGN, 'foreign:200').state, 'foreign')
  assert.equal(interpretProbe(PROBE_EXIT.ERROR, 'error:EACCES').state, 'error')
  assert.equal(interpretProbe(255, '').detail, 'exit:255')
})

test('the code page switch happens before the first non-ASCII byte', () => {
  const text = render()
  const lines = text.split('\n')
  const chcpIndex = lines.findIndex((line) => line.startsWith('chcp '))
  assert.ok(chcpIndex > 0, 'the launcher must set its code page')
  const before = lines.slice(0, chcpIndex).join('\n')
  // eslint-disable-next-line no-control-regex -- the ASCII test is the point
  assert.match(before, /^[\x00-\x7F]*$/, 'nothing non-ASCII may precede the chcp')
  for (const line of lines.slice(chcpIndex + 1)) {
    if (/[^\x00-\x7F]/.test(line)) return
  }
  assert.fail('expected the launcher to print localized text after the chcp')
})

test('the launcher is CRLF and carries no BOM in either encoding', () => {
  const text = toCrlf(render())
  assert.equal(text.includes('\n'), true)
  assert.equal(/[^\r]\n/.test(text), false, 'every LF must be preceded by CR')
  for (const codePage of [936, 65001]) {
    const encoded = encodeForCodePage(text, codePage)
    assert.equal(encoded.lossless, true)
    assert.notDeepEqual([...encoded.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(encoded.bytes.subarray(0, 11).toString('latin1'), '@echo off\r\n')
  }
})

test('the launcher logs its run, and a hidden run does not wait for a keypress', () => {
  const text = render()
  // The log lives beside the user's other application data, falls back to NUL
  // when it cannot be created, and appends through one routine.
  assert.match(text, /set "LOGDIR=%LOCALAPPDATA%\\dsh-launch"/)
  assert.match(text, /if not exist "%LOGDIR%" set "LOG=NUL"/)
  assert.match(text, /^:log$/m)
  assert.match(text, />>"%LOG%" echo %~1/)
  assert.match(text, /call :log "refused: port %PORT% already serves a harness instance"/)
  assert.match(text, /call :log "exit %EXITCODE%"/)
  // A hidden window can never receive the keypress a pause waits for.
  assert.match(text, /if defined DSH_LAUNCH_HIDDEN \(endlocal & exit \/b %EXITCODE%\)/)
  assert.doesNotMatch(text, /if defined DSH_LAUNCH_HIDDEN endlocal/, 'an ungrouped ampersand would exit unconditionally')
})

test('the silent hand-off uses the path captured before the argument parser', () => {
  // `shift` moves %0 as well, so reading %~f0 after parsing yields the last flag
  // — measured, with the launcher trying to Start-Process `--dry-run`.
  const text = render()
  const lines = text.split('\n')
  const capture = lines.findIndex((line) => line.startsWith('set "SELF=%~f0"'))
  const firstShift = lines.findIndex((line) => line.trim() === 'shift')
  assert.ok(capture > 0, 'the file must capture its own path')
  assert.ok(firstShift > capture, 'and capture it before anything shifts the arguments')
  assert.match(text, /Start-Process -FilePath \$env:DSH_LAUNCH_SELF -WindowStyle Hidden/)
  assert.doesNotMatch(text, /Start-Process -FilePath '/, 'never interpolate the path into the command text')
  assert.match(text, /if \/i "%~1"=="--silent" goto arg_silent/)
  assert.match(text, /if "%SILENT%"=="1" if not defined DSH_LAUNCH_HIDDEN goto silent_relaunch/)
})

test('the silent hand-off passes the resolved settings in the environment', () => {
  const text = render()
  for (const name of ['PORT', 'WORKDIR', 'NOOPEN', 'DRYRUN']) {
    assert.ok(text.includes(`set "DSH_LAUNCH_${name}=`), `the child needs ${name}`)
    assert.ok(text.includes(`if defined DSH_LAUNCH_${name} set "`), `and the child must read ${name} back`)
  }
})

test('the marker records the browser behaviour as well', () => {
  assert.match(render({ openBrowser: true }), /@config .* openBrowser=1 /)
  assert.match(render({ openBrowser: false }), /@config .* openBrowser=0 /)
})

test('the marker round-trips with its version and config', () => {
  const text = toCrlf(render({ port: 3111, runner: 'dsh', language: 'en', codePage: 65001 }))
  const marker = readLauncherMarker(text)
  assert.equal(marker.owned, true)
  assert.equal(marker.version, '1.0.0')
  assert.equal(marker.config.port, '3111')
  assert.equal(marker.config.runner, 'dsh')
  assert.equal(marker.config.lang, 'en')
  assert.equal(marker.config.cp, '65001')
  assert.equal(marker.config.workdir, 'C:\\Users\\me\\projects')
})

test('a file that is not ours is not claimed', () => {
  assert.equal(readLauncherMarker('@echo off\r\necho hello\r\n').owned, false)
  assert.equal(readLauncherMarker('').owned, false)
  assert.equal(readLauncherMarker('rem @dsh-launch-other v1').owned, false)
})

test('the runner selection changes the command that is baked in', () => {
  assert.match(render(), /call npx -y @deepseek-ai\/dsh web --port %PORT%/)
  assert.match(render({ runner: 'dsh' }), /call dsh web --port %PORT%/)
})

test('opening the browser is a switch, not a hardcoded default', () => {
  assert.match(render({ openBrowser: true }), /set "NO_OPEN=0"/)
  assert.match(render({ openBrowser: false }), /set "NO_OPEN=1"/)
})

test('values that a batch file would reinterpret are refused, not escaped', () => {
  assert.throws(() => render({ workdir: 'C:\\a&b' }), /contains "&"/)
  assert.throws(() => render({ workdir: 'C:\\100%' }), /contains "%"/)
  assert.throws(() => render({ fileName: 'a"b.bat' }), /contains/)
  assert.throws(() => assertBakeable('x', 'line\nbreak'), /contains/)
})

test('the port is validated in the batch file as well as before generation', () => {
  const text = render()
  assert.match(text, /for \/f "delims=0123456789" %%A in \("%PORT%"\) do goto err_port_invalid/)
  assert.match(text, /if %PORT% GTR 65535 goto err_port_invalid/)
})

test('the refusal paths exist for every documented exit code', () => {
  const text = render()
  for (const label of [
    ':err_no_node', ':err_no_runner', ':port_dsh', ':port_foreign', ':err_probe',
    ':err_port_invalid', ':err_workdir', ':err_server',
  ]) {
    assert.ok(text.includes(label), `expected a ${label} handler`)
  }
  assert.match(text, /set "EXITCODE=2"/)
  assert.match(text, /set "EXITCODE=3"/)
  assert.match(text, /set "EXITCODE=20"/)
})

test('the file never starts a second instance or opens a bare URL', () => {
  const text = render()
  assert.equal(/start "" "http/.test(text), false, 'the launcher must not open a browser at a URL it cannot authenticate')
  assert.match(text, /http:\/\/127\.0\.0\.1:%PORT% 会返回 401|answers 401|:port_dsh/)
})

test('directories are normalized for cmd', () => {
  assert.equal(normalizeDirectory('C:/Users/me/projects/'), 'C:\\Users\\me\\projects')
  assert.equal(normalizeDirectory('C:\\'), 'C:\\')
  assert.equal(normalizeDirectory('C:/'), 'C:\\')
  assert.equal(normalizeDirectory('//server/share/'), '\\\\server\\share')
})

test('the marker line is exactly what the reader searches for', () => {
  assert.ok(render().includes(`\n${MARKER_LINE} v1.0.0\r\n`) || render().includes(`\n${MARKER_LINE} v1.0.0\n`))
})
