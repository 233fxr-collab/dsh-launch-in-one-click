/**
 * Console code pages, and what it takes to write a batch file a Chinese
 * Windows will actually parse.
 *
 * cmd.exe reads a .bat as BYTES and interprets them in the console's active
 * code page. Two failure modes follow, and both are checked here rather than
 * hoped away:
 *
 * 1. Wrong code page — UTF-8 bytes read as GBK print as mojibake.
 * 2. A DBCS *trail* byte that is an ASCII metacharacter. In GBK and the other
 *    double-byte pages, the second byte of a character may be `|`, `&`, `<`,
 *    `>`, `^`, `%`, `(`, `)`, or `"`. cmd.exe does not know the byte pair is one
 *    character: it sees the metacharacter and starts a pipe, a redirect, or a
 *    variable expansion. A file can therefore be correctly encoded and still
 *    unrunnable, so every generated file is scanned for this before it is
 *    written.
 *
 * The encoder is `iconv-lite`, and every encode is verified by decoding the
 * result back: when a character has no representation in the target code page
 * — Chinese in cp437, or an emoji anywhere legacy — the substitution is
 * detected and the caller falls back to the ASCII catalog instead of shipping
 * a launcher full of `?`.
 *
 * @module dsh-launch-in-one-click/encoding
 */

import iconv from 'iconv-lite'
import { runCommand } from './run.js'

/** Double-byte code pages whose trail bytes can collide with cmd syntax. */
export const DBCS_CODE_PAGES = Object.freeze(new Set([932, 936, 949, 950]))

/** UTF-8 code page, which is hazard-free because no byte is below 0x80. */
export const UTF8_CODE_PAGE = 65001

/**
 * ASCII bytes that change the meaning of a batch line when they appear as the
 * trail byte of a double-byte character.
 */
const HAZARDOUS_TRAIL_BYTES = new Map([
  [0x25, '%'], [0x26, '&'], [0x28, '('], [0x29, ')'], [0x22, '"'], [0x21, '!'],
  [0x3c, '<'], [0x3e, '>'], [0x5e, '^'], [0x7c, '|'],
])

/**
 * iconv-lite encoding name for a Windows code page.
 * @param codePage - numeric Windows code page.
 * @returns The encoding name iconv-lite understands.
 */
export function iconvNameFor(codePage) {
  switch (codePage) {
    case 65001: return 'utf8'
    case 936: return 'gbk'
    case 932: return 'shiftjis'
    case 949: return 'cp949'
    case 950: return 'big5'
    case 1200: return 'utf16-le'
    case 1201: return 'utf16-be'
    default: return `cp${String(codePage)}`
  }
}

/**
 * Read the first integer out of `chcp` output, which is localized but always
 * carries the number.
 * @param text - `chcp` stdout.
 * @returns The code page, or `null` when the output carries no number.
 */
export function parseCodePage(text) {
  const match = /(\d{3,5})/.exec(text ?? '')
  if (match === null) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Detect the console code page a double-clicked script would run under.
 * @param options - command runner, environment, and abort signal.
 * @returns The code page and how it was determined.
 */
export async function detectConsoleCodePage(options = {}) {
  const { run = runCommand, env = process.env, signal, platform = process.platform } = options
  const command = platform === 'win32' ? 'cmd' : 'chcp'
  const args = platform === 'win32' ? ['/c', 'chcp'] : []
  const result = await run(command, args, { env, signal, decode: (buffer) => buffer.toString('latin1') })
  const codePage = result.failure === undefined ? parseCodePage(result.stdout) : null
  if (codePage === null) {
    return { codePage: null, source: 'unavailable', detail: result.failure ?? 'no-number-in-chcp-output' }
  }
  return { codePage, source: 'chcp', detail: result.stdout.trim() }
}

/**
 * Build a decoder for one code page, used to read redirected console output.
 * @param codePage - numeric Windows code page.
 * @returns A buffer-to-string function.
 */
export function makeDecoder(codePage) {
  if (codePage === null || codePage === undefined) return (buffer) => buffer.toString('utf8')
  if (codePage === UTF8_CODE_PAGE) return (buffer) => buffer.toString('utf8')
  const name = iconvNameFor(codePage)
  if (!iconv.encodingExists(name)) return (buffer) => buffer.toString('utf8')
  return (buffer) => iconv.decode(buffer, name)
}

/**
 * Find the first double-byte character whose trail byte is a cmd
 * metacharacter.
 * @param bytes - encoded file contents.
 * @param codePage - the code page those bytes are in.
 * @returns The offending offset, byte, and character, or `null` when clean.
 */
export function findDbcsHazard(bytes, codePage) {
  if (!DBCS_CODE_PAGES.has(codePage)) return null
  for (let index = 0; index < bytes.length - 1; index += 1) {
    const lead = bytes[index]
    if (lead < 0x81 || lead > 0xfe) continue
    const trail = bytes[index + 1]
    const character = HAZARDOUS_TRAIL_BYTES.get(trail)
    if (character !== undefined) return { offset: index, byte: trail, character }
    index += 1
  }
  return null
}

/**
 * Encode launcher text for one code page, verifying both directions.
 * @param text - the file contents, with `\n` line endings.
 * @param codePage - target code page.
 * @returns Bytes, the encoding name, and whether the round trip was lossless.
 */
export function encodeForCodePage(text, codePage) {
  const name = iconvNameFor(codePage)
  if (!iconv.encodingExists(name)) {
    return { bytes: null, encoding: name, lossless: false, reason: 'unsupported-code-page' }
  }
  const bytes = iconv.encode(text, name)
  const roundTrip = iconv.decode(bytes, name)
  if (roundTrip !== text) {
    return { bytes: null, encoding: name, lossless: false, reason: 'unrepresentable-character' }
  }
  const hazard = findDbcsHazard(bytes, codePage)
  if (hazard !== null) {
    return {
      bytes: null,
      encoding: name,
      lossless: false,
      reason: 'cmd-metacharacter-trail-byte',
      hazard,
    }
  }
  return { bytes, encoding: name, lossless: true, reason: null }
}

/**
 * Assert that every character of a value survives the target code page, for
 * values that cannot be swapped for a fallback — a user's directory path, for
 * example, which has no English equivalent.
 * @param label - field name used in the error message.
 * @param value - the value about to be written.
 * @param codePage - target code page.
 * @throws when the value cannot be written safely.
 */
export function assertEncodable(label, value, codePage) {
  const name = iconvNameFor(codePage)
  if (!iconv.encodingExists(name)) {
    throw new Error(`dsh-launch-in-one-click: code page ${String(codePage)} is not supported by the encoder`)
  }
  const bytes = iconv.encode(value, name)
  if (iconv.decode(bytes, name) !== value) {
    throw new Error(
      `dsh-launch-in-one-click: ${label} cannot be represented in code page ${String(codePage)}; `
      + 'pick a path or name Windows can print in the console',
    )
  }
  const hazard = findDbcsHazard(bytes, codePage)
  if (hazard !== null) {
    throw new Error(
      `dsh-launch-in-one-click: ${label} contains a character whose byte pair in code page ${String(codePage)} `
      + `includes ${JSON.stringify(hazard.character)}, which cmd.exe would run as syntax; `
      + 'rename the path or file to avoid that character',
    )
  }
}
