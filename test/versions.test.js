/**
 * Version ordering, the npx cache, and the registry question the doctor asks.
 *
 * The harness publishes prereleases, so the ordering rule that matters is
 * semver's: `0.1.5-rc.2` sorts BELOW `0.1.5`, not above it. Getting that
 * backwards would have the doctor announce an update that is really a downgrade.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions } from '../src/versions.js'
import { defaultNpxCacheRoot, fetchPublishedHarnessVersion, packageNameOf, readCachedHarnessVersion } from '../src/npx.js'

test('versions order the way semver says they do', () => {
  const ordered = ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.5', '0.1.6', '0.2.0']
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`)
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1, `${ordered[index]} > ${ordered[index - 1]}`)
  }
  assert.equal(compareVersions('0.1.5', '0.1.5'), 0)
  assert.equal(compareVersions('v0.1.5', '0.1.5'), 0, 'a v prefix is tolerated')
  assert.equal(compareVersions('0.1.5+build.9', '0.1.5'), 0, 'build metadata is ignored')
  assert.equal(compareVersions('0.1.5-alpha.1', '0.1.5-rc.1'), -1, 'alphanumeric identifiers compare as strings')
  assert.equal(compareVersions('0.1.5-rc.9', '0.1.5-rc.10'), -1, 'numeric identifiers compare as numbers')
  assert.equal(compareVersions('0.1.5-rc', '0.1.5-rc.1'), -1, 'a shorter identifier list sorts first')
})

test('an unparsable version compares to nothing rather than to a guess', () => {
  assert.equal(compareVersions('not-a-version', '1.0.0'), null)
  assert.equal(compareVersions('1.0.0', null), null)
  assert.equal(compareVersions(undefined, undefined), null)
})

test('the package name is read out of a spec', () => {
  assert.equal(packageNameOf('@deepseek-ai/dsh'), '@deepseek-ai/dsh')
  assert.equal(packageNameOf('@deepseek-ai/dsh@0.1.5-rc.2'), '@deepseek-ai/dsh')
  assert.equal(packageNameOf('plain'), 'plain')
  assert.equal(packageNameOf('plain@1.0.0'), 'plain')
})

test('the newest cached copy wins, and a missing cache is not an error', () => {
  /** Cache entries, by directory name: version, or a reason to fail. */
  const entries = new Map([
    ['a', '0.1.4'],
    ['b', '0.1.5-rc.2'],
    ['c', '0.1.5-rc.1'],
    ['d', null], // no manifest for this package
    ['e', 'not json'],
  ])
  const options = {
    cacheRoot: 'C:\\cache\\_npx',
    readDirectory: () => [...entries.keys()],
    // C:\cache\_npx\<entry>\node_modules\@deepseek-ai\dsh\package.json
    readFile: (path) => {
      if (!path.includes('@deepseek-ai\\dsh\\package.json')) throw new Error('ENOENT')
      const entry = path.split('\\')[3]
      const version = entries.get(entry)
      if (version === undefined || version === null) throw new Error('ENOENT')
      if (version === 'not json') return version
      return JSON.stringify({ version })
    },
  }
  assert.equal(readCachedHarnessVersion('@deepseek-ai/dsh', options), '0.1.5-rc.2')
  assert.equal(readCachedHarnessVersion('@deepseek-ai/nothing', options), null)
  assert.equal(readCachedHarnessVersion('@deepseek-ai/dsh', { cacheRoot: null }), null)
  assert.equal(
    readCachedHarnessVersion('@deepseek-ai/dsh', { ...options, readDirectory: () => { throw new Error('ENOENT') } }),
    null,
  )
})

test('the cache root follows LOCALAPPDATA', () => {
  assert.equal(defaultNpxCacheRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx')
  assert.equal(defaultNpxCacheRoot({}), null)
})

test('the published version is read from the last npm line, or reported as unknown', async () => {
  const run = async () => ({ code: 0, stdout: "0.1.5-rc.1\r\n'0.1.5-rc.2'\r\n", stderr: '' })
  assert.equal(await fetchPublishedHarnessVersion('@deepseek-ai/dsh', { run }), '0.1.5-rc.2', 'quotes and earlier matches are stripped')

  const failing = async () => ({ code: 1, stdout: '', stderr: 'network down', failure: 'ENOENT' })
  assert.equal(await fetchPublishedHarnessVersion('@deepseek-ai/dsh', { run: failing }), null)

  const empty = async () => ({ code: 0, stdout: '\r\n', stderr: '' })
  assert.equal(await fetchPublishedHarnessVersion('@deepseek-ai/dsh', { run: empty }), null)
})
