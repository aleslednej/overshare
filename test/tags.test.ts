import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { main } from '../src/cli'
import { compareTags, pickCandidate, readTargetState, validateTag } from '../src/tags'
import { CONFIG, commit, git, gitleaksPath, repos } from './helpers'

async function release(source: string, ...tags: string[]) {
  for (const tag of tags) await commit(source, tag)
  await git(source, 'push', '--quiet', 'origin', 'main', '--tags')
}

describe('tag selection', () => {
  test('candidates are release tags on origin/main, sorted by semver', async () => {
    const { source, targetUrl } = await repos()
    await release(source, 'v1.0.0', 'v1.9.0-rc.1', 'v1.9.0', 'foo', 'v1.10.0', 'v01.2.3')
    await git(source, 'checkout', '--quiet', '-b', 'side')
    await commit(source, 'v9.0.0')
    await git(source, 'push', '--quiet', 'origin', 'side', '--tags')
    await git(source, 'checkout', '--quiet', 'main')
    await commit(source, 'v8.0.0') // on local main only, ahead of origin/main
    const state = await readTargetState(source, targetUrl)
    expect(state).toEqual({ mainSha: undefined, lastExport: undefined, candidates: ['v1.10.0', 'v1.9.0', 'v1.0.0'] })
  })

  test('last export is the highest release tag in both repos; candidates are above it', async () => {
    const { source, targetUrl } = await repos()
    await release(source, 'v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0')
    await git(source, 'push', '--quiet', targetUrl, 'v1.2.0^{commit}:refs/heads/main', 'v1.0.0', 'v1.2.0')
    await git(source, 'push', '--quiet', targetUrl, 'HEAD:refs/tags/v5.0.0') // foreign to the source repo
    const state = await readTargetState(source, targetUrl)
    expect(state).toEqual({
      mainSha: await git(source, 'rev-parse', 'v1.2.0^{commit}'),
      lastExport: 'v1.2.0',
      candidates: ['v1.4.0', 'v1.3.0'],
    })
    expect(validateTag(state, 'v1.3.0')).toBe('v1.3.0')
  })

  test('rejects a tag that is not a candidate with the last export and candidates', async () => {
    const { source, targetUrl } = await repos()
    await release(source, 'v1.0.0', 'v3.0.0', 'v2.0.0', 'v2.1.0')
    await git(source, 'push', '--quiet', targetUrl, 'v2.0.0')
    const state = await readTargetState(source, targetUrl)
    expect(state.candidates).toEqual(['v2.1.0'])
    for (const tag of ['v1.0.0', 'v2.0.0', 'v3.0.0', 'v4.0.0']) {
      expect(() => validateTag(state, tag)).toThrow(`Cannot export ${tag}: last export is v2.0.0, candidates: v2.1.0.`)
    }
    expect(() => validateTag(state, 'v2.1')).toThrow('v2.1 is not a release tag')
  })

  test('compares components beyond the safe integer range exactly', () => {
    for (const [a, b] of [
      ['v9007199254740992.0.0', 'v9007199254740993.0.0'],
      ['v1.9007199254740992.0', 'v1.9007199254740993.0'],
      ['v1.0.9007199254740992', 'v1.0.9007199254740993'],
    ] as const) {
      expect([compareTags(a, b), compareTags(b, a), compareTags(b, b)]).toEqual([-1, 1, 0])
    }
  })

  test('picks a candidate by number', () => {
    expect(pickCandidate(['v1.4.0', 'v1.3.0'], ' 2\n')).toBe('v1.3.0')
    for (const answer of ['0', '3', 'x', '', null]) {
      expect(() => pickCandidate(['v1.4.0', 'v1.3.0'], answer)).toThrow('Select a number from 1 to 2.')
    }
  })

  test('plan prints the validated tag', async () => {
    const { source, targetUrl } = await repos()
    await Bun.write(join(source, 'overshare.yaml'), CONFIG.replace('aleslednej/my-tool', targetUrl).replace(/  - src\/\n  - README.md/, '  - file.txt'))
    await release(source, 'v1.0.0')
    const env = { cwd: source, path: await gitleaksPath() }
    expect(await main(['plan', 'v1.0.0'], env)).toBe(0)
    expect(await main(['plan', 'v2.0.0'], env)).toBe(1)
  })
})
