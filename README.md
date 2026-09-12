# dsh-Launch in One Click

English | [中文](README.zh.md)

A DeepSeek Harness plugin for Windows that writes a **self-contained one-click
launcher** — a `.bat` on your Desktop — and refuses to start a second Harness
instance when the port already serves one.

The launcher it writes does not import this plugin. Uninstall the plugin and the
`.bat` on your Desktop keeps working; it is a single file with everything it
needs already inside it.

## What it does

`launcher_install` resolves your Desktop the way Windows defines it (including a
OneDrive-redirected or localized Desktop folder), checks that the folder accepts
a new file, encodes the launcher for your console's code page, writes it
atomically, and then **runs it once in dry-run mode** to prove it parses and
reaches its own logic. A launcher that fails that self-test is rolled back, not
left on your Desktop.

The generated launcher then does the following every time it is double-clicked:

1. Checks that `node` runs and that the runner (`npx` or `dsh`) answers.
2. Checks that the configured workspace still exists and enters it.
3. Probes the port by binding it, then fingerprints whatever already answers:
   - **free** — starts the harness;
   - **serves a Harness instance** — refuses, and tells you to use that
     instance's own URL;
   - **held by anything else** — refuses, and reports the owning PID;
   - **probe failed** — refuses rather than guessing.

Only the first case starts anything. There is no flag that starts a second
instance.

## Why the port check is not just a courtesy

`dsh web` mints a **per-process launch token** and prints an authenticated URL
carrying it; the server answers every unauthenticated request with `401 dsh web
authentication required`. So opening a bare `http://127.0.0.1:3080` while an
instance is running shows a 401 page, not your session — and starting a second
instance fails on the bind anyway. A launcher therefore has exactly two honest
options when the port is busy, and this one takes the second: say which URL to
use, and start nothing.

The fingerprint is the 401 body itself, so "a Harness instance" is *detected*
rather than assumed — a different program holding the port is reported as a
different program, with its PID.

## Install

```sh
dsh plugin --profile web add dsh-launch-in-one-click
```

Or straight from the repository:

```sh
dsh plugin --profile web add github:233fxr-collab/dsh-launch-in-one-click
```

Remove the row from your profile to uninstall it. Existing launchers keep
working — they are self-contained.

## Use

Three tools, plus a slash command.

| Tool | Effect |
|---|---|
| `launcher_doctor` | Read-only. Reports Node, npx, the console code page, the resolved Desktop, whether it is writable, what holds the target port, and the state of any launcher already installed. Optionally runs an installed launcher in dry-run mode. |
| `launcher_install` | Writes the launcher (atomic, backed up, self-tested). |
| `launcher_uninstall` | Deletes a launcher **this plugin wrote**. Refuses a file it did not write unless `force` is set. |

```
/launch                      install with the deployment defaults
/launch doctor               same report as launcher_doctor
/launch --port 3111          start the harness on another port
/launch --name "Work.bat"    choose the file name
/launch --overwrite          replace a file this plugin did not write
/launch --dry-run            show what would be written
```

The launcher itself accepts `--port N`, `--workdir DIR`, `--no-open`,
`--dry-run`, and `--help`.

### Exit codes

The launcher's exit code is its contract, so a shortcut wrapper or a scheduled
task can branch on it without parsing localized text.

| Code | Meaning |
|---|---|
| 0 | the harness ran and exited cleanly, or a dry run printed its plan |
| 1 | `node` or the runner is missing |
| 2 | the port already serves a Harness instance — nothing was started |
| 3 | another program holds the port — nothing was started |
| 4 | an argument was invalid |
| 5 | the work directory is missing or cannot be entered |
| 9 | the port probe could not reach a verdict |
| 20 | the harness itself failed; its own exit code is printed above |

## Configuration

Optional, in the bundle's patch row:

```yaml
- id: launch-in-one-click
  name: dsh-launch-in-one-click
  config:
    defaultPort: 3080                # port a generated launcher targets
    language: auto                   # auto | en | zh
    runner: npx                      # npx | dsh
    packageSpec: '@deepseek-ai/dsh'  # what npx resolves
    openBrowser: true                # let `dsh web` open the browser
```

## Edge cases it handles

- **Redirected or localized Desktop** — resolved through the shell known-folder
  API, then both registry keys, then `%USERPROFILE%\Desktop`. A source pointing
  at a folder that does not exist is skipped rather than trusted.
- **Console code pages** — the launcher targets the system OEM code page, which
  is the one a freshly started console has and therefore the one a double-clicked
  batch file is read in. That is deliberately not the code page of the process
  that installs it: installing from a UTF-8 terminal on a Chinese Windows
  produced an English UTF-8 launcher, measured while building this. The
  installing console's code page is used only when the registry cannot be read,
  and the doctor reports both. The file switches the console to its own code
  page before its first non-ASCII byte. Verified on Windows 11: a console
  *reporting* code page 936 still reads a batch file as UTF-8 until the file
  tells it otherwise.
- **Language** — `auto` (the default) follows the console: a Chinese-capable
  code page gets Chinese, an English one gets English with no warning, because
  matching the console is the point rather than a fallback. An explicit
  `language: zh` is honoured even on a console that cannot print it, by writing
  the file in UTF-8 and switching the console to match.
- **Double-byte trail bytes** — in GBK and its relatives the second byte of a
  character can be `|`, `&`, `<`, `>`, `^`, `%`, `(`, `)`, or `"`. cmd.exe does
  not know the pair is one character and starts a pipe, a redirect, or a
  variable expansion. Every file is scanned for this before it is written.
- **A path the code page cannot carry** — a Chinese profile directory on an
  English console, for example. English does not fix a path, so the launcher
  switches itself to UTF-8 instead of failing.
- **Files this plugin did not write** — refused, and left untouched. With
  `overwrite`, replaced with a timestamped backup.
- **Timestamp-only changes** — an identical launcher is left alone instead of
  being rewritten under the user; `force` refreshes it.
- **Transient rename failures** — `MoveFileEx` fails with `EPERM` while an
  indexer or antivirus holds the destination open, so the rename is retried with
  backoff.
- **A double-clicked window** — failures pause so the message can be read; a
  scripted caller sees no prompt, because the pause happens only when cmd was
  started to run that very file.
- **`npx` versus `npx.cmd`** — Node ships an extensionless POSIX shim beside
  `npx.cmd`. PATH resolution tries `PATHEXT` candidates first, so the shim cmd
  cannot run never wins.

## Development

```sh
npm install --legacy-peer-deps   # iconv-lite; the rest are peer dependencies
npm test
```

The suite is 90 tests. The interesting ones generate a launcher and **run it
with real cmd.exe** against real listeners — a fake Harness server that answers
the 401 fingerprint, an unrelated HTTP server, and a free port — then assert the
exit codes. That is what caught the two defects unit tests could not: a file
written with bare LF endings (cmd reads it as one enormous line) and a code page
switch placed after the first multi-byte character.

`test/plugin.test.js` checks the manifest contract a plugin marketplace verifies,
including the peer range. That range is deliberately long:

```
>=0.0.1-rc.1 <0.2.0-0 || >=0.1.0-rc.1 <0.2.0-0 || >=0.1.1-rc.1 <0.2.0-0 ||
>=0.1.2-alpha.1 <0.2.0-0 || >=0.1.3-alpha.1 <0.2.0-0 || >=0.1.5-alpha.1 <0.2.0-0
```

node-semver only lets a prerelease satisfy a range when some comparator carries
that exact `major.minor.patch` tuple *and* a prerelease tag. A range that looks
generous — `>=0.0.1-rc.1 <0.2.0`, or even `>=0.0.0-0` — therefore excludes every
published `0.1.x` prerelease, and users hit an `ERESOLVE` they have to work
around by hand. The enumerated form admits each published line; a test asserts
that the tuple of the harness installed here is one of them.

When the harness packages resolve, the same file validates every tool schema
against the real `defineTool` compiler; otherwise it reports the skip.

## Requirements

- Windows 10 or 11.
- Node 20+ for the plugin; the harness itself targets Node 22.
- `npx` (with Node) for the default runner, or an installed `dsh` command if you
  set `runner: dsh`.

## License

MIT
