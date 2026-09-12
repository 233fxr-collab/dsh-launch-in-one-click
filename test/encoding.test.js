/**
 * Console text and encoding. These tests are the reason a generated launcher
 * cannot ship a byte pair that cmd.exe would run as syntax.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DBCS_CODE_PAGES, assertEncodable, detectLauncherCodePage, encodeForCodePage, findDbcsHazard, iconvNameFor,
  makeDecoder, parseCodePage, parseOemCodePage,
} from '../src/encoding.js'
import { CATALOGS, MESSAGE_KEYS, assertEchoSafe, catalogFor, fill, messagesFor } from '../src/messages.js'

test('every shipped message is safe to print with echo', () => {
  for (const [language, catalog] of Object.entries(CATALOGS)) {
    for (const key of MESSAGE_KEYS) {
      assert.doesNotThrow(() => { assertEchoSafe(catalog[key], `${language}.${key}`) })
    }
  }
})

test('the echo guard rejects what would change a command', () => {
  for (const text of ['a & b', 'a | b', 'a > b', 'a < b', 'a ^ b', 'a (b)', 'a !b', 'a "b"', '100% done']) {
    assert.throws(() => { assertEchoSafe(text, 'probe') }, /cmd\.exe would interpret/)
  }
  assert.doesNotThrow(() => { assertEchoSafe('port %PORT% is free', 'ok') })
})

test('catalogs are complete and identical in shape', () => {
  const zh = Object.keys(catalogFor('zh')).sort()
  const en = Object.keys(catalogFor('en')).sort()
  assert.deepEqual(zh, en)
  assert.deepEqual(zh, [...MESSAGE_KEYS].sort())
  assert.throws(() => catalogFor('fr'), /no message catalog/)
})

test('placeholders are filled, and an unknown one fails loudly', () => {
  assert.equal(fill('cmd is {runner}', { runner: 'npx' }), 'cmd is npx')
  assert.throws(() => fill('cmd is {missing}', {}), /unknown placeholder/)
})

test('messages resolve with the launcher name and runner for both languages', () => {
  for (const language of ['en', 'zh']) {
    const messages = messagesFor(language, { name: 'DSH.bat', runner: 'npx' })
    assert.match(messages.helpUsage, /DSH\.bat/)
    assert.match(messages.runnerMissing, /npx/)
  }
})

test('every catalog survives every code page it can be written in', () => {
  // A DBCS trail byte that is an ASCII metacharacter would be read as syntax,
  // so the catalogs must stay clear of them in each double-byte code page.
  for (const language of ['en', 'zh']) {
    const text = MESSAGE_KEYS.map((key) => messagesFor(language, { name: 'DSH.bat', runner: 'npx' })[key]).join('\r\n')
    for (const codePage of DBCS_CODE_PAGES) {
      const encoded = encodeForCodePage(text, codePage)
      if (!encoded.lossless && encoded.reason === 'unrepresentable-character') continue
      assert.equal(encoded.reason, null, `${language} in code page ${String(codePage)}: ${String(encoded.reason)}`)
    }
  }
})

test('the hazard scanner finds a metacharacter trail byte and ignores clean text', () => {
  // 0x81 0x7C is a valid (if obscure) GBK pair whose trail byte is a pipe.
  const hazardous = Buffer.from([0x41, 0x81, 0x7c, 0x42])
  const hazard = findDbcsHazard(hazardous, 936)
  assert.equal(hazard.character, '|')
  assert.equal(hazard.offset, 1)
  assert.equal(findDbcsHazard(Buffer.from('plain ascii'), 936), null)
  // The same bytes are inert in a single-byte code page, and in UTF-8.
  assert.equal(findDbcsHazard(hazardous, 437), null)
  assert.equal(findDbcsHazard(hazardous, 65001), null)
})

test('encoding verifies by decoding back, and reports the loss', () => {
  const chinese = '端口已经占用'
  const gbk = encodeForCodePage(chinese, 936)
  assert.equal(gbk.lossless, true)
  assert.equal(makeDecoder(936)(gbk.bytes), chinese)

  const ascii = encodeForCodePage(chinese, 437)
  assert.equal(ascii.lossless, false)
  assert.equal(ascii.reason, 'unrepresentable-character')
  assert.equal(ascii.bytes, null)
})

test('UTF-8 output carries no BOM and round-trips', () => {
  const encoded = encodeForCodePage('中文 launcher', 65001)
  assert.equal(encoded.lossless, true)
  assert.notEqual(encoded.bytes[0], 0xef)
  assert.equal(encoded.bytes.toString('utf8'), '中文 launcher')
})

test('assertEncodable names the value that cannot be written', (t) => {
  assert.doesNotThrow(() => { assertEncodable('the work directory', 'C:\\Users\\方向容', 936) })
  assert.throws(() => { assertEncodable('the work directory', '中文', 437) }, /cannot be represented/)

  // The trail-byte collision is not hypothetical: find a real character in the
  // CJK block whose GBK byte pair ends in a cmd metacharacter, instead of
  // hardcoding one this test would then have to trust.
  const found = findHazardCharacter()
  if (found === null) {
    t.skip('no CJK character with a metacharacter trail byte in code page 936')
    return
  }
  assert.throws(
    () => { assertEncodable('the file name', `a${found.character}b.bat`, 936) },
    /cmd\.exe would run as syntax/,
  )
})

/** Find a CJK character whose GBK encoding ends in an ASCII metacharacter. */
function findHazardCharacter() {
  for (let code = 0x4e00; code <= 0x9fa5; code += 1) {
    const character = String.fromCharCode(code)
    const encoded = encodeForCodePage(character, 936)
    if (encoded.reason === 'cmd-metacharacter-trail-byte') return { character, hazard: encoded.hazard }
  }
  return null
}

test('code page names and chcp output are read correctly', () => {
  assert.equal(iconvNameFor(936), 'gbk')
  assert.equal(iconvNameFor(65001), 'utf8')
  assert.equal(iconvNameFor(437), 'cp437')
  assert.equal(parseCodePage('Active code page: 936'), 936)
  assert.equal(parseCodePage('活动代码页: 936'), 936)
  assert.equal(parseCodePage('no number here'), null)
  assert.equal(makeDecoder(null)(Buffer.from('中文', 'utf8')), '中文')
})

test('the OEM code page is read from the registry', () => {
  const output = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
    '    OEMCP    REG_SZ    936',
    '',
  ].join('\r\n')
  assert.equal(parseOemCodePage(output), 936)
  assert.equal(parseOemCodePage('    ACP    REG_SZ    65001'), null)
  assert.equal(parseOemCodePage(''), null)
})

test('the launcher targets the OEM code page, not the installing console', async () => {
  // The case measured on a Chinese Windows: the harness console runs UTF-8, but
  // a double-clicked launcher gets a console at the system OEM code page.
  const detected = await detectLauncherCodePage({
    run: async (command, args) => {
      if (command === 'reg') return { code: 0, stdout: '    OEMCP    REG_SZ    936\r\n', stderr: '' }
      return { code: 0, stdout: 'Active code page: 65001\r\n', stderr: '' }
    },
  })
  assert.equal(detected.codePage, 936)
  assert.equal(detected.source, 'oem')
  assert.equal(detected.consoleCodePage, 65001, 'the console it was installed from is still reported')
})

test('a host where the registry cannot be read falls back to this console', async () => {
  const detected = await detectLauncherCodePage({
    run: async (command) => (command === 'reg'
      ? { code: 1, stdout: '', stderr: '', failure: 'ENOENT' }
      : { code: 0, stdout: 'Active code page: 437\r\n', stderr: '' }),
  })
  assert.equal(detected.codePage, 437)
  assert.equal(detected.source, 'console')
})

test('no answer from either source stays unavailable rather than guessing', async () => {
  const detected = await detectLauncherCodePage({
    run: async () => ({ code: 1, stdout: '', stderr: '', failure: 'ENOENT' }),
  })
  assert.equal(detected.codePage, null)
  assert.equal(detected.source, 'unavailable')
})
