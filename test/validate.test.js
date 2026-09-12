/**
 * Validation rules, including the ones a plain `fs.writeFile` would only
 * discover after the file was created.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkDirectory, checkFileName, checkLanguage, checkPackageSpec, checkPort, checkRunner, checkWorkdir,
} from '../src/validate.js'

test('ports are integers inside the TCP range', () => {
  assert.equal(checkPort(3080).value, 3080)
  assert.equal(checkPort('3080').value, 3080)
  assert.equal(checkPort(' 3080 ').value, 3080)
  for (const bad of [0, -1, 65536, 1.5, NaN, 'abc', '', null, undefined, '30 80']) {
    const result = checkPort(bad)
    assert.equal(result.ok, false, `expected ${String(bad)} to be rejected`)
    assert.ok(result.reason.length > 0)
  }
})

test('file names must be a bare .bat or .cmd name', () => {
  assert.equal(checkFileName('DSH.bat').value, 'DSH.bat')
  assert.equal(checkFileName('Launch DeepSeek Harness.CMD').value, 'Launch DeepSeek Harness.CMD')
  assert.equal(checkFileName('启动 DeepSeek Harness.bat').ok, true)
})

test('file names Windows would reject are rejected with a reason', () => {
  const cases = [
    ['', 'file-name-empty'],
    ['   ', 'file-name-empty'],
    ['sub/DSH.bat', 'file-name-has-separator'],
    ['sub\\DSH.bat', 'file-name-has-separator'],
    ['..', 'file-name-relative'],
    ['DSH.txt', 'file-name-extension'],
    ['DSH', 'file-name-extension'],
    ['DSH.bat ', 'file-name-trailing-dot-or-space'],
    ['DSH.bat.', 'file-name-trailing-dot-or-space'],
    ['CO<N>.bat', 'file-name-illegal-character'],
    ['NUL.bat', 'file-name-reserved-device'],
    ['con.cmd', 'file-name-reserved-device'],
    ['LPT1.bat', 'file-name-reserved-device'],
    [`${'x'.repeat(101)}.bat`, 'file-name-too-long'],
  ]
  for (const [name, reason] of cases) {
    const result = checkFileName(name)
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`)
    assert.equal(result.reason, reason)
    assert.ok(result.hint.length > 0)
  }
})

test('file names carrying batch syntax are rejected rather than escaped', () => {
  // Windows allows these in a file name; a batch file does not, and the
  // launcher prints its own name in its usage text.
  for (const name of ['a&b.bat', 'a^b.bat', 'a%b.bat']) {
    const result = checkFileName(name)
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`)
    assert.equal(result.reason, 'file-name-cmd-metacharacter')
  }
  // These are illegal in a Windows file name to begin with, and the more
  // fundamental rule is the one reported.
  for (const name of ['a|b.bat', 'a<b.bat', 'a>b.bat', 'a"b.bat']) {
    const result = checkFileName(name)
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`)
    assert.equal(result.reason, 'file-name-illegal-character')
  }
})

test('the work directory must be absolute and free of batch syntax', () => {
  assert.equal(checkWorkdir('C:\\Users\\me\\projects', 'win32').ok, true)
  assert.equal(checkWorkdir('\\\\server\\share\\x', 'win32').ok, true)
  assert.equal(checkWorkdir('/home/me/projects', 'linux').ok, true)

  assert.equal(checkWorkdir('projects', 'win32').reason, 'workdir-not-absolute')
  assert.equal(checkWorkdir('C:\\a&b', 'win32').reason, 'workdir-cmd-metacharacter')
  assert.equal(checkWorkdir('C:\\a%b', 'win32').reason, 'workdir-cmd-metacharacter')
  assert.equal(checkWorkdir('', 'win32').reason, 'workdir-empty')
  assert.equal(checkWorkdir('C:\\a\0b', 'win32').reason, 'workdir-illegal-character')
})

test('the target directory keeps its drive colon and separators', () => {
  assert.equal(checkDirectory('D:\\steam\\steamapps').ok, true)
  assert.equal(checkDirectory('C:\\Users\\me\\Desktop').ok, true)
  assert.equal(checkDirectory('C:\\a<b').reason, 'directory-illegal-character')
  assert.equal(checkDirectory('').reason, 'directory-empty')
})

test('a package spec cannot smuggle a second command', () => {
  assert.equal(checkPackageSpec('@deepseek-ai/dsh').ok, true)
  assert.equal(checkPackageSpec('@deepseek-ai/dsh@0.1.5-rc.2').ok, true)
  assert.equal(checkPackageSpec('dsh').ok, true)
  for (const bad of ['@deepseek-ai/dsh & calc', 'a|b', 'a>b', '"quoted"', '', 'a b']) {
    assert.equal(checkPackageSpec(bad).ok, false, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('runner and language are closed sets', () => {
  assert.equal(checkRunner('npx').ok, true)
  assert.equal(checkRunner('dsh').ok, true)
  assert.equal(checkRunner('cmd').reason, 'runner-invalid')
  assert.equal(checkLanguage('auto').ok, true)
  assert.equal(checkLanguage('zh').ok, true)
  assert.equal(checkLanguage('fr').reason, 'language-invalid')
})
