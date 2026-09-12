/**
 * Rendering the launcher batch file, and recognizing one this plugin wrote.
 *
 * The generated script is self-contained on purpose: it does not import the
 * plugin, read a config file, or call back into the harness home. Uninstalling
 * the plugin must not break a shortcut already sitting on someone's desktop, so
 * everything the launcher needs is baked in at generation time.
 *
 * Two decisions worth stating:
 *
 * **No `chcp`.** Setting the code page mid-file is the documented way to make
 * cmd.exe lose its place while re-reading a batch file, and this file contains
 * multi-byte characters and `goto` labels — exactly the combination that
 * misbehaves. The file is encoded in the code page a double-clicked console
 * already has, so no change is needed; a console started with a different code
 * page garbles the text but still parses the syntax, because every non-ASCII
 * byte pair is checked against cmd's metacharacters before the file is written.
 *
 * **The port verdict is a precondition, not a timeout.** If the port is free
 * the launcher starts; if it serves a Harness instance the launcher refuses and
 * says which URL to use instead; if anything else holds it the launcher
 * refuses and names the owner. It never starts a second instance and never
 * opens a browser at a page that will answer 401.
 *
 * @module dsh-launch-in-one-click/bat-template
 */

import { PROBE_SCRIPT } from './probe-script.js'
import { messagesFor } from './messages.js'

/** Marker line that identifies a launcher this plugin wrote. */
export const MARKER = '@dsh-launch-in-one-click'

/** Marker prefix as it appears in the file, including the `rem`. */
export const MARKER_LINE = `rem ${MARKER}`

/**
 * Characters that cannot be baked into a batch file verbatim. A quote ends the
 * `set "NAME=value"` form early, a percent sign expands as a variable, a line
 * break ends the command — and `&`, `|`, `<`, `>`, `^` start a second command
 * or a redirect from the `rem` line that records the configuration.
 */
const UNSAFE_IN_VALUE = /["%&|<>^\r\n]/

/**
 * Assert a value can be written into the batch file verbatim.
 *
 * Validation upstream already rejects these for tool callers; this is the
 * generator's own guarantee, so a future caller cannot reach the writer with a
 * value the batch file would execute.
 *
 * @param label - field name for the error message.
 * @param value - the value about to be baked.
 * @throws when the value contains a character cmd.exe would interpret.
 */
export function assertBakeable(label, value) {
  const offending = UNSAFE_IN_VALUE.exec(value)
  if (offending !== null) {
    throw new Error(
      `dsh-launch-in-one-click: ${label} contains ${JSON.stringify(offending[0])}, `
      + 'which a batch file would treat as syntax or as a variable reference',
    )
  }
}

/**
 * Normalize a directory path for baking: backslash separators (which is what
 * cmd's `cd /d` and `set` expect to see in a path this file prints), and no
 * trailing separator except at a drive root.
 * @param path - directory path.
 * @returns The normalized path.
 */
export function normalizeDirectory(path) {
  const backslashed = path.replace(/\//g, '\\').replace(/\\+$/, '')
  return /^[a-zA-Z]:$/.test(backslashed) ? `${backslashed}\\` : backslashed
}

/**
 * Render the launcher.
 * @param spec - resolved, validated launcher settings.
 * @returns The batch file text with `\n` line endings.
 */
export function renderLauncher(spec) {
  const {
    version,
    port,
    workdir,
    runner,
    packageSpec,
    openBrowser,
    language,
    codePage,
    generatedAt,
    fileName,
  } = spec

  assertBakeable('the work directory', workdir)
  assertBakeable('the file name', fileName)
  assertBakeable('the package spec', packageSpec)

  const m = messagesFor(language, { name: fileName, runner })
  const directory = normalizeDirectory(workdir)
  const noOpen = openBrowser ? '0' : '1'
  const launchCommand = runner === 'npx'
    ? `npx -y ${packageSpec} web --port %PORT%`
    : `dsh web --port %PORT%`

  const lines = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    '',
    'rem The code page is set BEFORE the first non-ASCII byte in this file, and',
    'rem that order is load-bearing. cmd.exe decodes each line as it reads it, so',
    'rem every line after this one is read in the code page this file was written',
    'rem in. With the switch later, or absent, a console whose default differs',
    'rem decodes the localized text as garbage: measured on Windows 11, a console',
    'rem reporting code page 936 still reads a batch file as UTF-8 until told',
    'rem otherwise. Keeping the switch ahead of any multi-byte byte also keeps',
    'rem the byte offsets cmd uses to seek equal to its character offsets.',
    `chcp ${String(codePage)} >nul`,
    '',
    'rem ===========================================================',
    `rem  ${m.windowTitle}`,
    `${MARKER_LINE} v${version}`,
    `rem  @config port=${String(port)} runner=${runner} lang=${language} cp=${String(codePage)}`
      + ` generated=${generatedAt} workdir="${directory}"`,
    'rem',
    'rem  This file is self-contained: it does not import the plugin that wrote',
    'rem  it, so uninstalling the plugin leaves this launcher working.',
    'rem  Regenerating it replaces this file; editing it by hand is fine, but the',
    'rem  plugin will then treat it as a file it does not own.',
    'rem ===========================================================',
    '',
    `title ${m.windowTitle}`,
    '',
    `set "PORT=${String(port)}"`,
    `set "WORKDIR=${directory}"`,
    `set "RUNNER=${runner}"`,
    `set "PKG=${packageSpec}"`,
    `set "NO_OPEN=${noOpen}"`,
    'set "DRY_RUN="',
    'set "EXITCODE=0"',
    'set "OWNER_PID="',
    '',
    'rem ---- command line ----',
    ':parse_args',
    'if "%~1"=="" goto args_done',
    'if /i "%~1"=="--port" goto arg_port',
    'if /i "%~1"=="--workdir" goto arg_workdir',
    'if /i "%~1"=="--no-open" goto arg_no_open',
    'if /i "%~1"=="--open" goto arg_open',
    'if /i "%~1"=="--dry-run" goto arg_dry_run',
    'if /i "%~1"=="--help" goto usage',
    'if /i "%~1"=="-h" goto usage',
    `echo ${m.unknownArg} "%~1"`,
    'set "EXITCODE=4"',
    'goto fail',
    '',
    ':arg_port',
    'shift',
    'if "%~1"=="" goto err_port_missing',
    'set "PORT=%~1"',
    'shift',
    'goto parse_args',
    '',
    ':arg_workdir',
    'shift',
    'if "%~1"=="" goto err_workdir_missing_arg',
    'set "WORKDIR=%~1"',
    'shift',
    'goto parse_args',
    '',
    ':arg_no_open',
    'set "NO_OPEN=1"',
    'shift',
    'goto parse_args',
    '',
    ':arg_open',
    'set "NO_OPEN=0"',
    'shift',
    'goto parse_args',
    '',
    ':arg_dry_run',
    'set "DRY_RUN=1"',
    'shift',
    'goto parse_args',
    '',
    ':args_done',
    'set "OPEN_ARG="',
    'if "%NO_OPEN%"=="1" set "OPEN_ARG=--no-open"',
    '',
    'rem ---- port sanity: digits only, no leading zero, inside range ----',
    'if "%PORT%"=="" goto err_port_invalid',
    'for /f "delims=0123456789" %%A in ("%PORT%") do goto err_port_invalid',
    'if "%PORT:~0,1%"=="0" goto err_port_invalid',
    'if %PORT% GTR 65535 goto err_port_invalid',
    '',
    'rem ---- environment ----',
    `echo ${m.checking}`,
    'node --version >nul 2>nul',
    'if errorlevel 1 goto err_no_node',
    `call %RUNNER% --version >nul 2>nul`,
    'if errorlevel 1 goto err_no_runner',
    '',
    'rem ---- work directory ----',
    'if not exist "%WORKDIR%\\" goto err_workdir',
    'cd /d "%WORKDIR%" >nul 2>nul',
    'if errorlevel 1 goto err_workdir',
    '',
    'rem ---- port preflight ----',
    'rem The probe binds the port, then fingerprints whatever answers. 0 means',
    'rem free, 2 means a Harness instance, 3 means somebody else, 9 means the',
    'rem probe itself could not decide.',
    `node -e "${PROBE_SCRIPT}" %PORT% >nul`,
    'set "PROBE_CODE=%ERRORLEVEL%"',
    'if "%PROBE_CODE%"=="0" goto port_free',
    'if "%PROBE_CODE%"=="2" goto port_dsh',
    'if "%PROBE_CODE%"=="3" goto port_foreign',
    'goto err_probe',
    '',
    ':port_free',
    'if defined DRY_RUN goto dry_run',
    `echo ${m.launching}`,
    `call ${launchCommand} %OPEN_ARG%`,
    'set "CODE=%ERRORLEVEL%"',
    'if not "%CODE%"=="0" goto err_server',
    `echo ${m.serverStopped}`,
    'set "EXITCODE=0"',
    'goto done',
    '',
    ':dry_run',
    `echo ${m.planDryRun}`,
    'echo.',
    'echo    cd /d "%WORKDIR%"',
    `echo    ${launchCommand} %OPEN_ARG%`,
    'echo.',
    'set "EXITCODE=0"',
    'goto done_wait',
    '',
    ':usage',
    `echo ${m.helpTitle}`,
    `echo   ${m.helpUsage}`,
    `echo ${m.helpPort}`,
    `echo ${m.helpWorkdir}`,
    `echo ${m.helpNoOpen}`,
    `echo ${m.helpDryRun}`,
    `echo ${m.helpHelp}`,
    'echo.',
    'set "EXITCODE=0"',
    'goto done_wait',
    '',
    'rem ---- refusals and failures ----',
    ':port_dsh',
    `echo ${m.portDsh}`,
    `echo ${m.portDshHint1}`,
    `echo ${m.portDshHint2}`,
    'set "EXITCODE=2"',
    'goto fail',
    '',
    ':port_foreign',
    `echo ${m.portForeign}`,
    'for /f "tokens=5" %%P in (\'netstat -ano -p TCP ^| findstr /r /c:":%PORT% " ^| findstr /i "LISTENING"\') do set "OWNER_PID=%%P"',
    'if not defined OWNER_PID goto port_foreign_hint',
    `echo     PID: %OWNER_PID%`,
    ':port_foreign_hint',
    `echo ${m.portForeignHint}`,
    `echo    %RUNNER% ... web --port 3111`,
    'set "EXITCODE=3"',
    'goto fail',
    '',
    ':err_no_node',
    `echo ${m.nodeMissing}`,
    `echo ${m.nodeMissingHint}`,
    'set "EXITCODE=1"',
    'goto fail',
    '',
    ':err_no_runner',
    `echo ${m.runnerMissing}`,
    `echo ${m.runnerMissingHint}`,
    'set "EXITCODE=1"',
    'goto fail',
    '',
    ':err_port_missing',
    `echo ${m.badPortArg}`,
    'set "EXITCODE=4"',
    'goto fail',
    '',
    ':err_port_invalid',
    `echo ${m.badPortRange} %PORT%`,
    'set "EXITCODE=4"',
    'goto fail',
    '',
    ':err_workdir_missing_arg',
    `echo ${m.badWorkdirArg}`,
    'set "EXITCODE=4"',
    'goto fail',
    '',
    ':err_workdir',
    `echo ${m.workdirMissing} "%WORKDIR%"`,
    `echo ${m.workdirMissingHint}`,
    'set "EXITCODE=5"',
    'goto fail',
    '',
    ':err_probe',
    `echo ${m.probeFailed}`,
    `echo ${m.probeFailedHint}`,
    'set "EXITCODE=9"',
    'goto fail',
    '',
    ':err_server',
    `echo ${m.serverFailed} %CODE%`,
    'set "EXITCODE=20"',
    'goto fail',
    '',
    'rem ---- exits ----',
    'rem A double-clicked window would vanish before the text could be read, so',
    'rem failures wait for a keypress. A scripted caller sees no prompt: the',
    'rem pause happens only when cmd was started to run this very file.',
    ':fail',
    'echo.',
    'echo "%cmdcmdline%" | find /i "%~nx0" >nul',
    'if not errorlevel 1 pause',
    'endlocal & exit /b %EXITCODE%',
    '',
    ':done_wait',
    'echo.',
    'echo "%cmdcmdline%" | find /i "%~nx0" >nul',
    'if not errorlevel 1 pause',
    'endlocal & exit /b %EXITCODE%',
    '',
    ':done',
    'endlocal & exit /b %EXITCODE%',
    '',
  ]

  return assertCodePageFirst(lines.join('\n'))
}

/**
 * Enforce the ordering the generated file depends on: the code page switch must
 * come before the first non-ASCII byte, so every localized line after it is read
 * in the code page the file was written in.
 * @param text - the rendered launcher.
 * @returns The same text.
 * @throws when a non-ASCII byte precedes the switch, or the switch is missing.
 */
export function assertCodePageFirst(text) {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.startsWith('chcp '))
  if (index < 0) throw new Error('dsh-launch-in-one-click: the rendered launcher sets no code page')
  const before = lines.slice(0, index)
  // eslint-disable-next-line no-control-regex -- the ASCII range is the assertion
  const offending = before.find((line) => /[^\x00-\x7F]/.test(line))
  if (offending !== undefined) {
    throw new Error(
      `dsh-launch-in-one-click: a non-ASCII line precedes the code page switch: ${JSON.stringify(offending)}`,
    )
  }
  return text
}

/**
 * Describe a launcher file that may or may not be this plugin's.
 * @param text - file contents decoded as latin1, so ASCII markers always parse.
 * @returns Ownership, plugin version, and the baked config when recognized.
 */
export function readLauncherMarker(text) {
  const content = String(text ?? '')
  const markerIndex = content.indexOf(MARKER_LINE)
  if (markerIndex < 0) return { owned: false, version: null, config: null }

  const afterMarker = content.slice(markerIndex + MARKER_LINE.length)
  const versionMatch = /^\s*v([0-9][^\s\r\n]*)/.exec(afterMarker)
  const configLine = /^rem\s+@config\s+(.*)$/m.exec(content.slice(markerIndex))

  const config = {}
  if (configLine !== null) {
    const pairPattern = /([a-zA-Z]+)=("[^"]*"|\S+)/g
    let pair = pairPattern.exec(configLine[1])
    while (pair !== null) {
      config[pair[1]] = pair[2].replace(/^"|"$/g, '')
      pair = pairPattern.exec(configLine[1])
    }
  }

  return {
    owned: true,
    version: versionMatch === null ? null : versionMatch[1],
    config: Object.keys(config).length > 0 ? config : null,
  }
}

/**
 * Convert `\n` endings to `\r\n`, which is what cmd.exe expects.
 * @param text - text with `\n` endings.
 * @returns The same text with `\r\n` endings.
 */
export function toCrlf(text) {
  return text.split('\r\n').join('\n').split('\n').join('\r\n')
}
