/**
 * Reading Windows' answers about who holds a port and where the Desktop is.
 * Fixtures are captured from a real Simplified-Chinese Windows 11 session,
 * because that is where a parser that assumes English silently returns nothing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPortOwner, parseNetstatListeners, parseTasklistCsv } from '../src/netstat.js'
import { defaultPowerShellPath, expandEnvVars, parseRegQueryValue, resolveDesktopDirectory } from '../src/desktop.js'

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       15024',
  '  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       22event',
  '  TCP    127.0.0.1:445          0.0.0.0:0              LISTENING       4',
  '  TCP    127.0.0.1:52341        127.0.0.1:3080         ESTABLISHED     9921',
  '  TCP    [::]:135               [::]:0                 LISTENING       1088',
  '  TCP    0.0.0.0:30800          0.0.0.0:0              LISTENING       5',
  '  UDP    127.0.0.1:1900         *:*                                    4231',
  '',
].join('\r\n')

test('listening TCP ports are indexed by port with their owner', () => {
  const listeners = parseNetstatListeners(NETSTAT)
  assert.deepEqual(listeners.get(3080), [15024])
  assert.deepEqual(listeners.get(445), [4])
  assert.deepEqual(listeners.get(135), [1088])
  // A port whose number merely starts with 3080 is a different port.
  assert.deepEqual(listeners.get(30800), [5])
})

test('non-listening, UDP, malformed and unknown lines are ignored', () => {
  const listeners = parseNetstatListeners(NETSTAT)
  assert.equal(listeners.has(52341), false, 'ESTABLISHED is not a listener')
  assert.equal(listeners.has(1900), false, 'UDP has no LISTENING state')
  assert.equal(listeners.has(3081), false, 'a non-numeric PID is not an owner')
  assert.deepEqual([...parseNetstatListeners('garbage\n\n  TCP  x  y  z  w').keys()], [])
  assert.deepEqual([...parseNetstatListeners('').keys()], [])
})

test('several listeners on one port are all reported', () => {
  const dual = '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    11\r\n  TCP    [::1]:3080    [::]:0    LISTENING    11\r\n'
  assert.deepEqual(parseNetstatListeners(dual).get(3080), [11, 11])
})

test('tasklist CSV rows map PIDs to image names', () => {
  const csv = '"node.exe","15024","Console","1","120,000 K"\r\n"System","4","Services","0","144 K"\r\n'
  const names = parseTasklistCsv(csv)
  assert.equal(names.get(15024), 'node.exe')
  assert.equal(names.get(4), 'System')
  assert.equal(names.get(999), undefined)
})

test('the owner lookup degrades to data when the commands fail', async () => {
  const failing = async () => ({ code: 1, stdout: '', stderr: '', failure: 'ENOENT' })
  const result = await findPortOwner(3080, { run: failing, platform: 'win32' })
  assert.equal(result.supported, true)
  assert.deepEqual(result.pids, [])
  assert.equal(result.failure, 'ENOENT')

  const nonWindows = await findPortOwner(3080, { run: failing, platform: 'linux' })
  assert.equal(nonWindows.supported, false)
})

test('the owner lookup names the process holding the port', async () => {
  const run = async (command, args) => {
    if (command === 'netstat') return { code: 0, stdout: NETSTAT, stderr: '' }
    if (command === 'tasklist') return { code: 0, stdout: '"node.exe","15024","Console","1","1 K"\r\n', stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  const result = await findPortOwner(3080, { run, platform: 'win32' })
  assert.deepEqual(result.pids, [15024])
  assert.deepEqual(result.names, [{ pid: 15024, name: 'node.exe' }])
})

/* ------------------------------------------------------------------ desktop */

test('registry values are parsed whether or not they are expandable', () => {
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Desktop',
    '',
  ].join('\r\n')
  assert.equal(parseRegQueryValue(output), '%USERPROFILE%\\Desktop')

  const redirected = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Desktop    REG_EXPAND_SZ    C:\\Users\\me\\OneDrive\\Desktop',
    '',
  ].join('\r\n')
  assert.equal(parseRegQueryValue(redirected), 'C:\\Users\\me\\OneDrive\\Desktop')
  assert.equal(parseRegQueryValue('    Personal    REG_SZ    C:\\x'), null)
})

test('environment references expand, and an unknown one is left alone', () => {
  const env = { USERPROFILE: 'C:\\Users\\方向容', HOME: '/home/me' }
  assert.equal(expandEnvVars('%USERPROFILE%\\Desktop', env), 'C:\\Users\\方向容\\Desktop')
  assert.equal(expandEnvVars('%HOMEDRIVE%\\x', env), '%HOMEDRIVE%\\x')
  assert.equal(expandEnvVars('C:\\plain', env), 'C:\\plain')
})

test('an unknown PowerShell location falls back to the registry and the profile', async () => {
  const run = async (command, args) => {
    if (command.endsWith('powershell.exe')) return { code: 0, stdout: '', stderr: '' }
    if (command === 'reg' && args[1].includes('User Shell Folders')) {
      return { code: 0, stdout: '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop\r\n', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }
  const env = { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' }
  const resolved = await resolveDesktopDirectory({
    run,
    env,
    platform: 'win32',
    isDirectory: (path) => path === 'C:\\Users\\me\\OneDrive\\Desktop',
  })
  assert.equal(resolved.path, 'C:\\Users\\me\\OneDrive\\Desktop')
  assert.equal(resolved.source, 'registry-expand')
})

test('a source that points at a missing folder is skipped, not trusted', async () => {
  const run = async (command) => {
    if (command.endsWith('powershell.exe')) return { code: 0, stdout: 'C:\\stale\\Desktop\r\n', stderr: '' }
    if (command === 'reg') return { code: 0, stdout: '    Desktop    REG_SZ    C:\\also-stale\r\n', stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  const env = { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' }
  const resolved = await resolveDesktopDirectory({
    run,
    env,
    platform: 'win32',
    isDirectory: (path) => path === 'C:\\Users\\me\\Desktop',
  })
  assert.equal(resolved.path, 'C:\\Users\\me\\Desktop')
  assert.equal(resolved.source, 'userprofile')
  assert.equal(resolved.candidates.length, 4)
  assert.deepEqual(resolved.candidates.map((entry) => entry.reason), ['missing', 'missing', 'missing', 'ok'])
})

test('no Desktop anywhere is reported as null with its candidates', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: '' })
  const resolved = await resolveDesktopDirectory({
    run,
    env: { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' },
    platform: 'win32',
    isDirectory: () => false,
  })
  assert.equal(resolved.path, null)
  assert.equal(resolved.source, null)
  assert.ok(resolved.candidates.length >= 3)
})

test('PowerShell is located through SystemRoot, not through PATH', () => {
  assert.equal(
    defaultPowerShellPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.equal(defaultPowerShellPath({}), 'powershell.exe')
})
