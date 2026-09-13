/**
 * Console text of a generated launcher, in the two shipped languages.
 *
 * These strings are baked into a batch file and printed with `echo`, so they
 * are subject to cmd.exe's parser, not to a template engine's. A message
 * containing `&`, `|`, `<`, `>`, `^`, `(`, `)`, `!`, or a stray `%` would start
 * a second command, redirect output, or expand a variable the author never
 * declared — so {@link assertEchoSafe} rejects those at generation time rather
 * than shipping a launcher that misbehaves on one unlucky locale.
 *
 * `%PORT%` is the single permitted variable reference: the port is overridable
 * at run time with `--port`, so it must stay a reference and not a baked value.
 *
 * @module dsh-launch-in-one-click/messages
 */

/** Characters that would change the meaning of an `echo` line. */
const FORBIDDEN_IN_ECHO = /[%&|<>^()!"\r\n]/

/** Placeholder syntax used by {@link fill}. */
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

/**
 * Assert a message is safe to print with `echo` from a batch file.
 * @param text - the catalog entry.
 * @param label - catalog key, used in the error message.
 * @throws when the text contains a cmd metacharacter.
 */
export function assertEchoSafe(text, label = 'message') {
  const withoutPortReference = text.split('%PORT%').join('')
  const offending = FORBIDDEN_IN_ECHO.exec(withoutPortReference)
  if (offending !== null) {
    throw new Error(
      `dsh-launch-in-one-click: message "${label}" contains ${JSON.stringify(offending[0])}, `
      + 'which cmd.exe would interpret instead of printing it',
    )
  }
}

/**
 * Substitute `{name}` placeholders.
 * @param text - template text.
 * @param values - placeholder values; a baked value must already be validated.
 * @returns The filled text.
 * @throws when the template names a placeholder the caller did not supply.
 */
export function fill(text, values) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`dsh-launch-in-one-click: message template references unknown placeholder "${key}"`)
    }
    return String(values[key])
  })
}

/** Simplified Chinese catalog — the default when the console code page is 936. */
const ZH = Object.freeze({
  windowTitle: 'DSH 一键启动',
  checking: '检查运行环境',
  unknownArg: '[错误] 无法识别的参数：',
  helpUsage: '{name} [--port 端口] [--workdir 目录] [--no-open] [--dry-run]',
  nodeMissing: '[错误] 没有找到 Node.js，无法启动。',
  nodeMissingHint: '       请先安装 Node.js 再运行本文件：https://nodejs.org/',
  runnerMissing: '[错误] 没有找到启动命令 {runner}。',
  runnerMissingHint: '       请重新安装 Node.js，或改用 --runner 参数生成另一个启动器。',
  probeFailed: '[错误] 端口检测没有得出结论，为安全起见不启动。',
  probeFailedHint: '       请手动执行一次端口检查，或换一个端口重试。',
  badPortArg: '[错误] --port 后面需要一个端口号。',
  badPortRange: '[错误] 端口必须是 1 到 65535 之间的整数，收到的值：',
  badWorkdirArg: '[错误] --workdir 后面需要一个目录路径。',
  workdirMissing: '[错误] 工作目录不存在或无法进入：',
  workdirMissingHint: '       用 --workdir 参数指定一个存在的目录即可。',
  portDsh: '[注意] 端口 %PORT% 已经被另一个 DeepSeek Harness 实例占用，本次不会启动第二个实例。',
  portDshHint1: '    请切到那个实例的窗口，用它打印出来的地址打开界面。',
  portDshHint2: '    那个地址带有本次启动的访问令牌；直接打开 http://127.0.0.1:%PORT% 会返回 401。',
  portForeign: '[注意] 端口 %PORT% 被其它程序占用，本次不会启动。',
  portForeignHint: '    可以先查出占用它的程序，或者用别的端口启动，例如：',
  planDryRun: '试运行结束：只做了检查，没有启动服务。将要执行的命令：',
  launching: '正在启动 DeepSeek Harness，请稍候。若是首次运行，需要先下载依赖，会慢一些。',
  serverFailed: '启动失败或服务异常退出，退出码：',
  serverStopped: '服务已退出。',
  pressAnyKey: '按任意键关闭此窗口 ...',
  helpTitle: '用法：',
  helpPort: '  --port N        改用端口 N 启动',
  helpWorkdir: '  --workdir DIR   改用目录 DIR 作为工作区',
  helpNoOpen: '  --no-open       不自动打开浏览器',
  helpDryRun: '  --dry-run       只做检查并打印将要执行的命令',
  helpHelp: '  --help          显示这段帮助',
})

/** English catalog — the fallback when the console code page cannot carry Chinese. */
const EN = Object.freeze({
  windowTitle: 'DSH One-Click Launcher',
  checking: 'Checking the environment',
  unknownArg: '[error] Unrecognized argument:',
  helpUsage: '{name} [--port N] [--workdir DIR] [--no-open] [--dry-run]',
  nodeMissing: '[error] Node.js was not found, so nothing can start.',
  nodeMissingHint: '        Install Node.js first, then run this file again: https://nodejs.org/',
  runnerMissing: '[error] The start command {runner} was not found.',
  runnerMissingHint: '        Reinstall Node.js, or regenerate this launcher with another --runner.',
  probeFailed: '[error] The port check reached no verdict, so nothing was started.',
  probeFailedHint: '        Check the port by hand, or regenerate the launcher for another port.',
  badPortArg: '[error] --port needs a port number.',
  badPortRange: '[error] The port must be an integer between 1 and 65535. Received:',
  badWorkdirArg: '[error] --workdir needs a directory path.',
  workdirMissing: '[error] The work directory is missing or cannot be entered:',
  workdirMissingHint: '        Pass an existing directory with --workdir.',
  portDsh: '[warn] Port %PORT% already serves another DeepSeek Harness instance, so a second one is not started.',
  portDshHint1: '    Switch to that instance and open the URL it printed.',
  portDshHint2: '    That URL carries this run token; http://127.0.0.1:%PORT% on its own answers 401.',
  portForeign: '[warn] Port %PORT% is held by another program, so nothing was started.',
  portForeignHint: '    Find out what holds it, or start on another port such as:',
  planDryRun: 'Dry run finished: checks only, nothing was started. The command would be:',
  launching: 'Starting DeepSeek Harness. If this is the first run it downloads dependencies first, which takes longer.',
  serverFailed: 'The harness failed to start or exited with an error. Exit code:',
  serverStopped: 'The server has exited.',
  pressAnyKey: 'Press any key to close this window ...',
  helpTitle: 'Usage:',
  helpPort: '  --port N        start on port N instead',
  helpWorkdir: '  --workdir DIR   use DIR as the workspace instead',
  helpNoOpen: '  --no-open       do not open the browser',
  helpDryRun: '  --dry-run       run the checks and print the command only',
  helpHelp: '  --help          show this help',
})

/** Catalog id to catalog. @type {Record<string, Readonly<Record<string, string>>>} */
export const CATALOGS = Object.freeze({ zh: ZH, en: EN })

/** Keys every catalog must define. */
export const MESSAGE_KEYS = Object.freeze(Object.keys(ZH))

/**
 * Resolve a catalog, or throw when the language has none.
 * @param language - `en` or `zh`.
 * @returns The catalog.
 */
export function catalogFor(language) {
  const catalog = CATALOGS[language]
  if (catalog === undefined) throw new Error(`dsh-launch-in-one-click: no message catalog for "${language}"`)
  return catalog
}

/**
 * Every line a launcher prints, in one language and with placeholders filled.
 * @param language - `en` or `zh`.
 * @param values - placeholder values, such as the runner name.
 * @returns The resolved message map, checked for echo safety.
 */
export function messagesFor(language, values = {}) {
  const catalog = catalogFor(language)
  const resolved = {}
  for (const key of MESSAGE_KEYS) {
    const text = fill(catalog[key], values)
    assertEchoSafe(text, key)
    resolved[key] = text
  }
  return resolved
}
