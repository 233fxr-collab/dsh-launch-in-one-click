/**
 * The shape of the bundle patch, and why it is not allowed to change casually.
 *
 * A marketplace hot-mounts a plugin only when its bundle patch is a plain
 * `id`/`name` insert — anything else (a config block, a disable, an expression)
 * makes the plugin wait for a restart. This plugin's whole promise is that the
 * launcher is on the Desktop the moment someone clicks Install, so the patch
 * shape is a product property, not a formatting preference: adding a `config:`
 * row below would silently cost the immediate activation.
 *
 * `parseSimplePatch` is reproduced from dshmarket 1.45.1
 * (`src/hot.ts`, "Insert rows of a plugin's bundle patch, or null when the patch
 * contains anything beyond plain id/name insert rows"). It is copied rather than
 * imported because the market ships it as an internal function; the assertions
 * below are about our file, and this is the checker its own hot-mount uses.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** Reproduced from dshmarket's `parseSimplePatch`; see the module comment. */
function parseSimplePatch(patchText) {
  const rows = []
  let pending = null
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** The shipped patch file. */
function shippedPatch() {
  return readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
}

test('the bundle patch is hot-mountable: one plain insert row', () => {
  const rows = parseSimplePatch(shippedPatch())
  assert.notEqual(rows, null, 'a config block or expression would make this plugin wait for a restart')
  assert.deepEqual(rows, [{ id: 'launch-in-one-click', name: 'dsh-launch-in-one-click' }])
})

test('the parser really does reject the shape this file must avoid', () => {
  // Guards the guard: if the copied parser stopped rejecting config rows, the
  // test above would pass for the wrong reason.
  const withConfig = [
    '- insert:',
    '    - id: launch-in-one-click',
    '      name: dsh-launch-in-one-click',
    '      config:',
    '        defaultPort: 3080',
    '',
  ].join('\n')
  assert.equal(parseSimplePatch(withConfig), null)
})

test('the patch points at the name the manifest and the plugin agree on', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const rows = parseSimplePatch(shippedPatch())
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(rows[0].name, manifest.name)
})
