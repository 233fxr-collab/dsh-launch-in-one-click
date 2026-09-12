/**
 * The plugin: three tools and one slash command over the launcher installer.
 *
 * The tools are deliberately separate rather than one tool with a mode. A
 * diagnosis is read-only, an install writes a file the user will double-click
 * for months, and a removal deletes one — a model that has to choose between
 * them explicitly is a model that cannot confuse "check my setup" with
 * "replace the file on my Desktop".
 *
 * The command gives the same install to a person who would rather type
 * `/launch` than ask for it.
 *
 * @module dsh-launch-in-one-click
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_FILE_NAMES, PLUGIN_VERSION, installLauncher, uninstallLauncher } from './install.js'
import { runDoctor } from './doctor.js'
import { RUNNERS } from './validate.js'

/** Cordis plugin name. */
export const name = 'launch-in-one-click'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/**
 * Deployment configuration. Every field has a default, and a patch row that
 * omits `config` entirely behaves exactly like one that restates them.
 */
export const Config = z.object({
  defaultPort: z.natural().default(3080),
  language: z.string().default('auto'),
  runner: z.string().default('npx'),
  packageSpec: z.string().default('@deepseek-ai/dsh'),
  openBrowser: z.boolean().default(true),
})

/** Nullable string in the tool-schema DSL. */
const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** Nullable integer in the tool-schema DSL. */
const nullableInteger = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/** The launcher result every mutating tool returns, with snake-free names. */
const LAUNCHER_RESULT_PROPERTIES = {
  ok: { type: 'boolean', required: true, description: 'Whether the requested operation completed.' },
  reason: { ...nullableString, required: true, description: 'Machine-readable failure id.' },
  hint: { ...nullableString, required: true, description: 'What to change when it failed.' },
  path: { ...nullableString, required: true, description: 'Absolute path of the launcher.' },
  bytes: { type: 'integer', required: true, description: 'Size of the written launcher.' },
  encoding: { ...nullableString, required: true, description: 'Encoding the file was written in.' },
  codePage: { ...nullableInteger, required: true, description: 'Console code page the file targets.' },
  language: { ...nullableString, required: true, description: 'Language the launcher prints in.' },
  port: { ...nullableInteger, required: true, description: 'Port the launcher starts the harness on.' },
  runner: { ...nullableString, required: true, description: 'Command the launcher starts the harness with.' },
  workDirectory: { ...nullableString, required: true, description: 'Workspace the launcher starts in.' },
  replaced: { type: 'boolean', required: true, description: 'Whether an existing file was replaced.' },
  unchanged: { type: 'boolean', required: true, description: 'Whether an identical file was already there.' },
  backupPath: { ...nullableString, required: true, description: 'Backup of the file that was replaced.' },
  verified: { type: 'boolean', required: true, description: 'Whether the launcher passed its own dry-run check.' },
  verificationExitCode: { ...nullableInteger, required: true, description: 'Exit code of that dry run.' },
  verificationOutput: { type: 'string', required: true, description: 'Console text of that dry run.' },
  portState: { ...nullableString, required: true, description: 'What the port preflight found.' },
  existing: { type: 'string', required: true, description: 'none, ours, or foreign.' },
  warnings: { type: 'array', items: { type: 'string' }, required: true, description: 'Non-fatal findings.' },
}

/**
 * Project an installer result onto the tool output schema.
 * @param result - a result from install.js.
 * @returns The declared output value.
 */
function launcherResult(result) {
  return {
    ok: result.ok,
    reason: result.reason ?? null,
    hint: result.hint ?? null,
    path: result.path ?? null,
    bytes: result.bytes ?? 0,
    encoding: result.encoding ?? null,
    codePage: result.codePage ?? null,
    language: result.language ?? null,
    port: result.port ?? null,
    runner: result.runner ?? null,
    workDirectory: result.workdir ?? null,
    replaced: result.replaced === true,
    unchanged: result.unchanged === true,
    backupPath: result.backupPath ?? null,
    verified: result.verified === true,
    verificationExitCode: result.verification?.exitCode ?? null,
    verificationOutput: result.verification?.output ?? '',
    portState: result.portState ?? null,
    existing: result.existing ?? 'none',
    warnings: result.warnings ?? [],
  }
}

/**
 * Render one launcher result as model-facing text.
 * @param result - the projected output value.
 * @returns Content blocks.
 */
function renderLauncherResult(result) {
  const lines = []
  if (result.ok) {
    lines.push(result.unchanged
      ? `Launcher already up to date: ${String(result.path)}`
      : `Launcher ${result.replaced ? 'replaced' : 'installed'}: ${String(result.path)}`)
    lines.push(`  ${String(result.bytes)} bytes, ${String(result.encoding)}, code page ${String(result.codePage)}, ${String(result.language)}`)
    lines.push(`  starts ${String(result.runner)} on port ${String(result.port)} in ${String(result.workDirectory)}`)
    if (result.backupPath !== null) lines.push(`  previous file backed up to ${String(result.backupPath)}`)
    if (result.verified) lines.push(`  self-test: dry run exited ${String(result.verificationExitCode)}`)
  } else {
    lines.push(`Launcher not installed: ${String(result.reason)}`)
    if (result.hint !== null) lines.push(`  ${String(result.hint)}`)
    if (result.path !== null) lines.push(`  target: ${String(result.path)}`)
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render one doctor report as model-facing text. */
function renderDoctor(report) {
  const lines = [
    `Preflight: ${String(report.summary.fail)} failing, ${String(report.summary.warn)} warning, ${String(report.summary.ok)} ok`,
  ]
  for (const entry of report.checks) lines.push(`  [${entry.status}] ${entry.id}: ${entry.detail}`)
  if (report.targetPath !== null) {
    lines.push(`  installed launcher: ${report.installed} (${String(report.targetPath)})`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render one removal result as model-facing text. */
function renderUninstall(result) {
  if (result.ok) {
    return [{ type: 'text', text: result.removed ? `Removed ${String(result.path)}` : `Nothing to remove at ${String(result.path)}` }]
  }
  return [{ type: 'text', text: `Not removed: ${String(result.reason)}\n  ${String(result.hint)}` }]
}

/**
 * Register the plugin.
 * @param ctx - the Cordis context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.warn('dsh-launch-in-one-click: this plugin generates Windows batch launchers and registers nothing on this platform')
    return
  }

  const deployment = {
    defaultPort: config?.defaultPort ?? 3080,
    language: config?.language ?? 'auto',
    runner: config?.runner ?? 'npx',
    packageSpec: config?.packageSpec ?? '@deepseek-ai/dsh',
    openBrowser: config?.openBrowser ?? true,
  }

  ctx.tools.register(defineTool({
    name: 'launcher_doctor',
    description: 'Check whether a one-click DeepSeek Harness launcher can work on this Windows machine, without changing anything. Reports the Node and runner found, the console code page, the Desktop folder actually resolved, whether it accepts a new file, whether the target port is free or already serves a Harness instance (with the owning process), and the state of any launcher already installed. Use it before launcher_install when a failure is plausible, or when the user asks why a launcher does not start.',
    parameters: {
      port: { type: 'integer', description: 'Port the launcher would use. Defaults to the deployment default, normally 3080.' },
      directory: { type: 'string', description: 'Folder the launcher would be written into. Defaults to the resolved Desktop folder.' },
      file_name: { type: 'string', description: 'Launcher file name, ending in .bat or .cmd.' },
      runner: { type: 'string', enum: [...RUNNERS], description: 'Command the launcher starts the harness with.' },
      verify_execution: { type: 'boolean', description: 'Also execute an installed launcher in dry-run mode to prove it still works.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'True when no check failed.' },
          platform: { type: 'string', required: true },
          codePage: { ...nullableInteger, required: true },
          port: { ...nullableInteger, required: true },
          portState: { ...nullableString, required: true, description: 'free, dsh, foreign, error, or null.' },
          portOwner: { ...nullableString, required: true, description: 'Process holding the port, when known.' },
          directory: { ...nullableString, required: true },
          directorySource: { type: 'string', required: true, description: 'How the folder was resolved.' },
          writable: { type: 'boolean', required: true },
          targetPath: { ...nullableString, required: true },
          installed: { type: 'string', required: true, description: 'none, ours, or foreign.' },
          launcherVersion: { ...nullableString, required: true },
          launcherBytes: { type: 'integer', required: true },
          nodeVersion: { ...nullableString, required: true },
          runner: { ...nullableString, required: true },
          runnerPath: { ...nullableString, required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true, description: 'ok, warn, fail, info, or skip.' },
                detail: { type: 'string', required: true },
              },
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'integer', required: true },
              warn: { type: 'integer', required: true },
              fail: { type: 'integer', required: true },
              info: { type: 'integer', required: true },
              skip: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderDoctor(value),
    },
    execute: async (args, exec) => await runDoctor({
      port: args.port ?? deployment.defaultPort,
      directory: args.directory,
      fileName: args.file_name,
      runner: args.runner ?? deployment.runner,
      verifyExecution: args.verify_execution === true,
      signal: exec.signal,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'launcher_install',
    description: 'Write a self-contained Windows one-click launcher for DeepSeek Harness, by default onto the Desktop. The launcher refuses to start a second instance when its port already serves a Harness web server (which would answer 401 without that process token), refuses when another program holds the port, checks Node and the runner, and enters the chosen workspace first. The install is atomic, backs up a file it replaces, and finishes by running the launcher once in dry-run mode to prove it parses; a launcher that fails that self-test is rolled back. Refuses to overwrite a file this plugin did not write unless overwrite is set.',
    parameters: {
      port: { type: 'integer', description: 'Port to start the harness on. Defaults to the deployment default, normally 3080.' },
      directory: { type: 'string', description: 'Folder to write the launcher into. Defaults to the resolved Desktop folder.' },
      file_name: { type: 'string', description: 'Launcher file name ending in .bat or .cmd. Defaults to a language-appropriate name.' },
      work_directory: { type: 'string', description: 'Absolute workspace the launcher starts the harness in. Defaults to the current working directory.' },
      runner: { type: 'string', enum: [...RUNNERS], description: 'npx resolves the published package; dsh uses an installed command.' },
      language: { type: 'string', enum: ['auto', 'en', 'zh'], description: 'Language of the launcher console text. auto follows the console code page.' },
      overwrite: { type: 'boolean', description: 'Replace an existing file that this plugin did not write, keeping a backup.' },
      dry_run: { type: 'boolean', description: 'Report what would be written without touching the filesystem.' },
      verify_execution: { type: 'boolean', description: 'Run the launcher once in dry-run mode as a self-test. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: LAUNCHER_RESULT_PROPERTIES,
      },
      render: (_args, value) => renderLauncherResult(value),
    },
    execute: async (args, exec) => launcherResult(await installLauncher({
      port: args.port ?? deployment.defaultPort,
      directory: args.directory,
      fileName: args.file_name,
      workdir: args.work_directory ?? process.cwd(),
      runner: args.runner ?? deployment.runner,
      language: args.language ?? deployment.language,
      packageSpec: deployment.packageSpec,
      openBrowser: deployment.openBrowser,
      overwrite: args.overwrite === true,
      dryRun: args.dry_run === true,
      verify: args.verify_execution === false ? 'none' : 'run',
      signal: exec.signal,
    })),
    presentCall: (args) => ({
      card: 'generic',
      title: 'Install one-click launcher',
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'launcher_uninstall',
    description: 'Delete a one-click launcher this plugin wrote. Refuses to delete a file it did not write unless force is set, so a shortcut the user made by hand is never removed by mistake.',
    parameters: {
      path: { type: 'string', description: 'Exact launcher path. Overrides directory and file_name.' },
      directory: { type: 'string', description: 'Folder holding the launcher. Defaults to the resolved Desktop folder.' },
      file_name: { type: 'string', description: 'Launcher file name. Defaults to the shipped name.' },
      force: { type: 'boolean', description: 'Delete even when the file was not written by this plugin.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { ...nullableString, required: true },
          hint: { ...nullableString, required: true },
          path: { ...nullableString, required: true },
          removed: { type: 'boolean', required: true },
          existing: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderUninstall(value),
    },
    execute: async (args) => {
      const result = await uninstallLauncher({
        path: args.path,
        directory: args.directory,
        fileName: args.file_name ?? DEFAULT_FILE_NAMES.zh,
        force: args.force === true,
      })
      return {
        ok: result.ok,
        reason: result.reason ?? null,
        hint: result.hint ?? null,
        path: result.path ?? null,
        removed: result.removed === true,
        existing: result.existing ?? 'none',
      }
    },
  }))

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'launch',
      description: 'Install a one-click DeepSeek Harness launcher on the Desktop',
      input: { hint: '[doctor] [--port N] [--name FILE] [--overwrite] [--dry-run]' },
      handler: async ({ rawInput }) => {
        const parsed = parseLaunchInput(rawInput ?? '')
        if (parsed.error !== null) return { kind: 'error', text: parsed.error }

        if (parsed.doctor) {
          const report = await runDoctor({
            port: parsed.port ?? deployment.defaultPort,
            fileName: parsed.fileName,
            runner: deployment.runner,
            verifyExecution: true,
          })
          const failing = report.checks.filter((entry) => entry.status === 'fail' || entry.status === 'warn')
          const text = failing.length === 0
            ? `Preflight clean: ${String(report.summary.ok)} checks passed. Desktop: ${String(report.directory)}`
            : failing.map((entry) => `[${entry.status}] ${entry.id}: ${entry.detail}`).join('\n')
          return { kind: report.summary.fail === 0 ? 'success' : 'error', text }
        }

        const result = await installLauncher({
          port: parsed.port ?? deployment.defaultPort,
          fileName: parsed.fileName,
          workdir: process.cwd(),
          runner: deployment.runner,
          language: deployment.language,
          packageSpec: deployment.packageSpec,
          openBrowser: deployment.openBrowser,
          overwrite: parsed.overwrite,
          dryRun: parsed.dryRun,
          verify: parsed.dryRun ? 'none' : 'run',
        })

        if (!result.ok) return { kind: 'error', text: `${String(result.reason)}: ${String(result.hint)}` }
        const text = result.unchanged
          ? `Already up to date: ${String(result.path)}`
          : `Installed ${String(result.path)} (${String(result.bytes)} bytes, ${String(result.encoding)}, port ${String(result.port)})`
        return { kind: 'success', text: [text, ...result.warnings.map((warning) => `warning: ${warning}`)].join('\n') }
      },
    })
  })

  ctx.logger?.info(`dsh-launch-in-one-click ${PLUGIN_VERSION}: launcher_doctor, launcher_install, launcher_uninstall, /launch`)
}

/**
 * Parse `/launch` input.
 * @param raw - everything after the command name.
 * @returns Parsed switches, or the first error.
 */
export function parseLaunchInput(raw) {
  const tokens = String(raw).trim().split(/\s+/).filter((token) => token.length > 0)
  const parsed = { doctor: false, overwrite: false, dryRun: false, port: null, fileName: undefined, error: null }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === 'doctor') { parsed.doctor = true; continue }
    if (token === '--overwrite') { parsed.overwrite = true; continue }
    if (token === '--dry-run') { parsed.dryRun = true; continue }
    if (token === '--port') {
      const value = tokens[index + 1]
      const port = Number(value)
      if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { ...parsed, error: '--port needs an integer between 1 and 65535.' }
      }
      parsed.port = port
      index += 1
      continue
    }
    if (token === '--name') {
      const value = tokens[index + 1]
      if (value === undefined) return { ...parsed, error: '--name needs a file name.' }
      parsed.fileName = value
      index += 1
      continue
    }
    if (token === '--help' || token === '-h') {
      return { ...parsed, error: 'Usage: /launch [doctor] [--port N] [--name FILE.bat] [--overwrite] [--dry-run]' }
    }
    return { ...parsed, error: `Unrecognized argument: ${token}` }
  }
  return parsed
}
