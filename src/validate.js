/**
 * Input validation for launcher installation.
 *
 * Every validator returns the same discriminated result shape — `{ ok: true,
 * value }` or `{ ok: false, reason, hint }` — so a tool can report the first
 * violated rule as structured data instead of a stack trace. Validation is
 * deliberately stricter than the filesystem: a name Windows would accept but
 * later fail to create is rejected here, with a reason the caller can act on.
 *
 * @module dsh-launch-in-one-click/validate
 */

/** Maximum launcher file name length, chosen to leave room inside MAX_PATH. */
export const MAX_FILE_NAME_LENGTH = 100

/** Windows device names that cannot be used as a file name, extension or not. */
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** Characters Windows forbids in a file name, plus the control range. */
const ILLEGAL_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/

/**
 * Characters Windows forbids anywhere in a path. A directory may of course
 * contain `:` after its drive letter and both separators, so this is a
 * different set from {@link ILLEGAL_FILE_NAME} rather than the same one reused.
 */
const ILLEGAL_DIRECTORY = /[<>"|?*\u0000-\u001f]/

/** Extensions a launcher may carry: a cmd script either way. */
const LAUNCHER_EXTENSIONS = ['.bat', '.cmd']

/** Runners the generated launcher can start the harness with. */
export const RUNNERS = Object.freeze(['npx', 'dsh'])

/** Output languages a launcher can be generated in. */
export const LANGUAGES = Object.freeze(['auto', 'en', 'zh'])

/**
 * Characters that are legal in a Windows path but mean something to cmd.exe.
 * A launcher is a generated command file, so a value carrying one of these
 * cannot be written into it verbatim: `&` would end the line's command, `%`
 * would expand a variable, and `>` would redirect the output. Rejecting them
 * with a reason beats escaping them and hoping the escaping survives the next
 * edit.
 */
const CMD_METACHARACTERS = /[%&|<>^"]/

/** `ok` result. @param value - the accepted value. */
function ok(value) {
  return { ok: true, value }
}

/** `failure` result. @param reason - machine-readable rule id. @param hint - what to do. */
function fail(reason, hint) {
  return { ok: false, reason, hint }
}

/**
 * Validate a TCP port.
 * @param value - candidate port, number or numeric string.
 * @returns Validation result carrying the parsed integer port.
 */
export function checkPort(value) {
  if (typeof value === 'string' && !/^[0-9]+$/.test(value.trim())) {
    return fail('port-not-a-number', 'Pass an integer between 1 and 65535.')
  }
  const port = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    return fail('port-not-a-number', 'Pass an integer between 1 and 65535.')
  }
  if (port < 1 || port > 65535) {
    return fail('port-out-of-range', 'Pass an integer between 1 and 65535.')
  }
  return ok(port)
}

/**
 * Validate a launcher file name. Rejects path separators, Windows-illegal
 * characters, trailing dots or spaces, reserved device names, and names that
 * are too long for one MAX_PATH component.
 * @param value - candidate file name, not a path.
 * @returns Validation result carrying the trimmed name.
 */
export function checkFileName(value) {
  if (typeof value !== 'string') return fail('file-name-not-a-string', 'Pass a file name such as DSH.bat.')
  const name = value
  if (name.trim().length === 0) return fail('file-name-empty', 'Pass a file name such as DSH.bat.')
  if (name.length > MAX_FILE_NAME_LENGTH) {
    return fail('file-name-too-long', `Keep the name at or under ${String(MAX_FILE_NAME_LENGTH)} characters.`)
  }
  if (name === '.' || name === '..') return fail('file-name-relative', 'Pass a real file name, not a relative-path marker.')
  if (/[. ]$/.test(name)) {
    return fail('file-name-trailing-dot-or-space', 'End the name with a letter or digit; Windows strips a trailing dot or space.')
  }
  if (/[\\/]/.test(name)) {
    return fail('file-name-has-separator', 'Pass a bare file name; use the directory option for the folder.')
  }
  if (ILLEGAL_FILE_NAME.test(name)) {
    return fail('file-name-illegal-character', 'Remove the characters Windows forbids: < > : " / \\ | ? *')
  }
  if (CMD_METACHARACTERS.test(name)) {
    return fail(
      'file-name-cmd-metacharacter',
      'Remove % & ^ — Windows allows them in a name, but a batch file reads them as syntax.',
    )
  }
  if (!LAUNCHER_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
    return fail('file-name-extension', 'End the name with .bat or .cmd so double-clicking runs it.')
  }
  const stem = name.split('.')[0].toUpperCase()
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    return fail('file-name-reserved-device', `"${stem}" is a reserved Windows device name; pick another.`)
  }
  return ok(name)
}

/**
 * Validate a work directory. The path must be absolute: a relative path would
 * resolve against the launcher's own directory at double-click time, which is
 * never what the person who installed it meant.
 * @param value - candidate directory path.
 * @param platform - platform whose absolute-path rules apply.
 * @returns Validation result carrying the path.
 */
export function checkWorkdir(value, platform = process.platform) {
  if (typeof value !== 'string') return fail('workdir-not-a-string', 'Pass an absolute directory path.')
  const path = value.trim()
  if (path.length === 0) return fail('workdir-empty', 'Pass an absolute directory path.')
  if (path.includes('\0')) return fail('workdir-illegal-character', 'Remove the NUL character.')
  if (CMD_METACHARACTERS.test(path)) {
    return fail(
      'workdir-cmd-metacharacter',
      'Remove % & | < > ^ " — the launcher is a generated batch file, and those characters are its syntax.',
    )
  }
  const absolute = platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) : path.startsWith('/')
  if (!absolute) {
    return fail('workdir-not-absolute', 'Pass an absolute path, for example C:\\Users\\me\\projects.')
  }
  return ok(path)
}

/**
 * Validate the package the `npx` runner resolves. Deliberately narrow: this
 * string is written into a batch file and handed to npx, so anything that could
 * terminate a command or start a second one is rejected rather than escaped.
 * @param value - package name with an optional @version.
 * @returns Validation result carrying the spec.
 */
export function checkPackageSpec(value) {
  if (typeof value !== 'string') return fail('package-not-a-string', "Pass a package name such as '@deepseek-ai/dsh'.")
  const spec = value.trim()
  if (spec.length === 0) return fail('package-empty', "Pass a package name such as '@deepseek-ai/dsh'.")
  if (spec.length > 214) return fail('package-too-long', 'Pass a shorter package spec.')
  if (!/^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+(@[a-zA-Z0-9-._~+]+)?$/.test(spec)) {
    return fail('package-invalid', 'Use a plain npm spec such as @scope/name or @scope/name@1.2.3.')
  }
  return ok(spec)
}

/**
 * Validate a runner choice.
 * @param value - `npx` or `dsh`.
 * @returns Validation result carrying the runner.
 */
export function checkRunner(value) {
  if (typeof value !== 'string' || !RUNNERS.includes(value)) {
    return fail('runner-invalid', `Pass one of: ${RUNNERS.join(', ')}.`)
  }
  return ok(value)
}

/**
 * Validate an output language choice.
 * @param value - `auto`, `en`, or `zh`.
 * @returns Validation result carrying the language.
 */
export function checkLanguage(value) {
  if (typeof value !== 'string' || !LANGUAGES.includes(value)) {
    return fail('language-invalid', `Pass one of: ${LANGUAGES.join(', ')}.`)
  }
  return ok(value)
}

/**
 * Validate the directory the launcher is written into.
 * @param value - candidate directory path.
 * @returns Validation result carrying the path.
 */
export function checkDirectory(value) {
  if (typeof value !== 'string') return fail('directory-not-a-string', 'Pass an absolute directory path.')
  const path = value.trim()
  if (path.length === 0) return fail('directory-empty', 'Pass an absolute directory path.')
  if (ILLEGAL_DIRECTORY.test(path)) {
    return fail('directory-illegal-character', 'Remove the characters Windows forbids: < > " | ? *')
  }
  return ok(path)
}
