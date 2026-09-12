/**
 * The port preflight, as one line of JavaScript that both the plugin and the
 * generated batch file run — the plugin through `node -e`, the launcher through
 * `node -e` inside the .bat. Sharing the exact source is the point: a check the
 * installer reports is then literally the check the launcher performs, instead
 * of a re-implementation that can drift.
 *
 * The script answers one question — may this launcher start on this port — and
 * answers it with an exit code:
 *
 * | exit | meaning                                                        |
 * |------|----------------------------------------------------------------|
 * | 0    | the port is free: binding it succeeded                          |
 * | 2    | a DeepSeek Harness instance answers there                       |
 * | 3    | something else holds the port, or the probe could not ask       |
 * | 9    | the probe itself failed — bad permission, no loopback, timeout  |
 *
 * The `dsh` verdict is a fingerprint, not a guess. A Harness web server answers
 * an unauthenticated `GET /` with 401 and the body "dsh web authentication
 * required", because every launch mints its own process token that only the URL
 * `dsh web` prints carries. Opening a bare `http://127.0.0.1:3080` therefore
 * shows a 401 page — which is exactly why a launcher must refuse to start a
 * second instance rather than point a browser at one.
 *
 * @module dsh-launch-in-one-click/probe-script
 */

/** Exit codes of {@link PROBE_SCRIPT}, mirrored in `exit-codes.js`. */
export const PROBE_EXIT = Object.freeze({ FREE: 0, DSH: 2, FOREIGN: 3, ERROR: 9 })

/** Body phrase that identifies an unauthenticated Harness web server. */
export const DSH_FINGERPRINT = 'dsh web authentication required'

/** Harness instance detection budget, in milliseconds. */
export const PROBE_HTTP_TIMEOUT_MS = 1500

/** Hard budget for the whole probe, in milliseconds. */
export const PROBE_TOTAL_TIMEOUT_MS = 5000

/**
 * The probe source. Written across lines for review, embedded as one line:
 * a batch file cannot continue a quoted command across lines.
 *
 * It uses only single quotes, because it is handed to `node -e "..."` from a
 * batch file where a double quote would close the argument early.
 */
const PROBE_SOURCE = `
const net = require('net');
const http = require('http');
const port = Number(process.argv[1]);
const say = (text, code) => { process.stdout.write(text); process.exit(code) };
const guard = setTimeout(() => say('error:timeout', 9), ${String(PROBE_TOTAL_TIMEOUT_MS)});
guard.unref();
const server = net.createServer();
server.once('error', (error) => {
  if (error.code !== 'EADDRINUSE') { say('error:' + String(error.code), 9); return }
  const request = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: ${String(PROBE_HTTP_TIMEOUT_MS)} }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { if (body.length < 4096) body += chunk });
    response.on('end', () => {
      const isHarness = response.statusCode === 401 && body.indexOf('${DSH_FINGERPRINT}') >= 0;
      if (isHarness) { say('dsh', 2); return }
      say('foreign:' + String(response.statusCode), 3);
    });
  });
  request.on('error', () => say('foreign:unreachable', 3));
  request.on('timeout', () => { request.destroy(); say('foreign:timeout', 3) });
});
server.once('listening', () => { server.close(() => say('free', 0)) });
server.listen(port, '127.0.0.1');
`

/**
 * The probe as a single line, ready to embed in a batch file or pass to
 * `node -e`.
 * @type {string}
 */
export const PROBE_SCRIPT = PROBE_SOURCE.split('\n').map((line) => line.trim()).join('')

/**
 * Assert a script can survive one round trip through `node -e "..."` inside a
 * batch file.
 *
 * Only four things actually survive that trip badly, and each is checked here:
 * a double quote ends the cmd argument early, a percent sign expands as a
 * variable, and a line break cannot exist inside the quoted argument at all.
 * Backslashes are rejected too: the C runtime's argument parser owns them on
 * Windows, so a future `'\n'` inside the probe would silently become an `n`.
 * Everything else — `&`, `|`, `<`, `>`, `^` — is inert inside double quotes.
 *
 * @param script - candidate embedded script.
 * @throws when the script contains a character the embedding cannot carry.
 */
export function assertEmbeddable(script) {
  const offending = /["%\\\r\n]/.exec(script)
  if (offending !== null) {
    throw new Error(
      `dsh-launch-in-one-click: the embedded probe contains ${JSON.stringify(offending[0])}, `
      + 'which cannot survive `node -e "..."` inside a batch file',
    )
  }
}

/**
 * Translate a probe exit code and its stdout into a structured verdict.
 * @param exitCode - the probe process exit code.
 * @param stdout - the probe's stdout, which carries the detail token.
 * @returns The verdict; `state` is the machine-readable outcome.
 */
export function interpretProbe(exitCode, stdout = '') {
  const detail = stdout.trim()
  switch (exitCode) {
    case PROBE_EXIT.FREE: return { state: 'free', detail: detail === '' ? 'free' : detail }
    case PROBE_EXIT.DSH: return { state: 'dsh', detail: detail === '' ? 'dsh' : detail }
    case PROBE_EXIT.FOREIGN: return { state: 'foreign', detail: detail === '' ? 'foreign' : detail }
    default: return { state: 'error', detail: detail === '' ? `exit:${String(exitCode)}` : detail }
  }
}

assertEmbeddable(PROBE_SCRIPT)
