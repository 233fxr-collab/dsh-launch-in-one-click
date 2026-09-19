/**
 * Comparing the versions the harness is published and cached under.
 *
 * The doctor answers one question with this: is the version a launcher will
 * resolve newer than the one npx already has? If it is, the next double-click
 * spends its time downloading, which is worth knowing before someone sits
 * watching a console wondering whether it hung.
 *
 * `@deepseek-ai/*` publishes prereleases (`0.1.5-rc.2`), so a plain numeric
 * comparison would rank `0.1.5-rc.2` above `0.1.5`. Semver's rule is the
 * opposite — a prerelease sorts before its release — and this implements that
 * rule, and only that rule. Build metadata is ignored, as the specification says.
 *
 * @module dsh-launch-in-one-click/versions
 */

/**
 * Split a version into its numeric core and prerelease identifiers.
 * @param version - a version string, `v` prefix and build metadata tolerated.
 * @returns Numeric parts and prerelease identifiers; empty when unparsable.
 */
function parseVersion(version) {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? '').trim())
  if (match === null) return null
  return {
    numbers: match[1].split('.').map((part) => Number(part)),
    prerelease: match[2] === undefined ? [] : match[2].split('.'),
  }
}

/**
 * Compare two versions the way semver orders them.
 * @param a - left version.
 * @param b - right version.
 * @returns `-1`, `0`, or `1`; `null` when either side cannot be parsed.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null

  const length = Math.max(left.numbers.length, right.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  // A version with a prerelease sorts before the same version without one.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const identifiers = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < identifiers; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    // Numeric identifiers compare numerically and rank below alphanumeric ones.
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}
