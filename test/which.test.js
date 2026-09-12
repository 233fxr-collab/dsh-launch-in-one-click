/**
 * PATH resolution. The interesting case is Windows' `npx`: node ships an
 * extensionless POSIX shim next to `npx.cmd`, and cmd.exe cannot run the shim.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathExtensions, resolveExecutable, splitPath } from '../src/which.js'

/**
 * PATH probe over a fixed set of existing files. Comparison is
 * case-insensitive because the filesystem it stands in for is: `npx.CMD` finds
 * the file on disk named `npx.cmd`, which is the whole point of the PATHEXT
 * order being tested here.
 */
function probeFor(files) {
  return (candidate) => files.some((file) => file.toLowerCase() === candidate.toLowerCase())
}

test('PATHEXT candidates are tried before the bare name', () => {
  const env = { PATH: 'C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const files = ['C:\\nodejs\\npx', 'C:\\nodejs\\npx.cmd', 'C:\\nodejs\\npx.ps1']
  const resolved = resolveExecutable('npx', { platform: 'win32', env, isFile: probeFor(files) })
  assert.equal(resolved.toLowerCase(), 'c:\\nodejs\\npx.cmd', 'the POSIX shim must not win over npx.cmd')
})

test('the bare name is still reachable when nothing else exists', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.EXE' }
  const files = ['C:\\tools\\thing']
  assert.equal(resolveExecutable('thing', { platform: 'win32', env, isFile: probeFor(files) }).toLowerCase(), 'c:\\tools\\thing')
})

test('directories are searched in order and blanks are skipped', () => {
  const env = { PATH: ';C:\\first;;C:\\second;', PATHEXT: '.EXE' }
  const files = ['C:\\second\\tool.exe']
  assert.equal(resolveExecutable('tool', { platform: 'win32', env, isFile: probeFor(files) }).toLowerCase(), 'c:\\second\\tool.exe')
})

test('a missing command resolves to null rather than throwing', () => {
  const env = { PATH: 'C:\\empty', PATHEXT: '.EXE' }
  assert.equal(resolveExecutable('nope', { platform: 'win32', env, isFile: probeFor([]) }), null)
  assert.equal(resolveExecutable('', { platform: 'win32', env, isFile: probeFor([]) }), null)
})

test('a name with a separator is probed as a path, never searched', () => {
  const env = { PATH: 'C:\\nodejs', PATHEXT: '.EXE' }
  const files = ['C:\\other\\node.exe']
  assert.equal(resolveExecutable('C:\\other\\node', { platform: 'win32', env, isFile: probeFor(files) }).toLowerCase(), 'c:\\other\\node.exe')
  assert.equal(resolveExecutable('node', { platform: 'win32', env, isFile: probeFor(files) }), null)
})

test('POSIX hosts get the plain separator and no extension logic', () => {
  const env = { PATH: '/usr/bin:/bin' }
  assert.deepEqual(pathExtensions({ platform: 'linux', env }), [''])
  assert.deepEqual(splitPath('/usr/bin:/bin', 'linux'), ['/usr/bin', '/bin'])
  assert.equal(resolveExecutable('node', { platform: 'linux', env, isFile: probeFor(['/bin/node']) }), '/bin/node')
})

test('quoted PATH entries are unquoted', () => {
  assert.deepEqual(splitPath('"C:\\Program Files\\nodejs";C:\\Windows', 'win32'), ['C:\\Program Files\\nodejs', 'C:\\Windows'])
})
