import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli'
import { publish, stage } from '../src/release'
import { git, gitleaksPath, repos, tempDir } from './helpers'

const NOTES = '# Highlights\n\n## Fixed\n- a bug\n'
const YAML = (target: string, include: string) =>
  `target: ${target}\nidentity: "Release Bot <bot@example.com>"\ninclude: [${include}]\ndenylistExceptions: ['**/.env.example']\n`

let source: string
let targetUrl: string
let target: string
let path: string
const silenced = [spyOn(console, 'log'), spyOn(console, 'error')]
beforeEach(async () => {
  for (const spy of silenced) spy.mockImplementation(() => {})
  ;({ source, targetUrl } = await repos())
  target = targetUrl.slice('file://'.length)
  path = await gitleaksPath()
  await Bun.write(join(source, 'notes.md'), NOTES)
})
afterEach(() => {
  for (const spy of silenced) spy.mockReset()
})

/** Writes files (null deletes), commits, tags and pushes to origin. */
async function release(tag: string, files: Record<string, string | null>, include = 'src/') {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(source, file))
    else await Bun.write(join(source, file), content)
  }
  await Bun.write(join(source, 'overshare.yaml'), YAML(targetUrl, include))
  await git(source, 'add', '--all', '--force')
  await git(source, 'commit', '--quiet', '-m', tag)
  await git(source, 'tag', '-a', tag, '-m', tag)
  await git(source, 'push', '--quiet', 'origin', 'main', '--tags')
}
const overshare = (...argv: string[]) => main(argv, { cwd: source, path })
const targetRefs = () => git(target, 'for-each-ref')

describe('release', () => {
  test('first export creates main with one release commit and an annotated tag, even with HEAD on master', async () => {
    await git(target, 'symbolic-ref', 'HEAD', 'refs/heads/master')
    await release('v1.0.0', { 'src/a.ts': 'a\n', '.gitignore': '.env.example\nsrc/\n', '.env.example': 'KEY=\n' }, 'src/, .gitignore, .env.example')
    expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--yes')).toBe(0)
    expect(await git(target, 'rev-list', 'main')).not.toContain('\n')
    expect(await git(target, 'ls-tree', '-r', '--name-only', 'main')).toBe('.env.example\n.gitignore\nsrc/a.ts')
    expect(await git(target, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main')).toBe('Release Bot <bot@example.com>|Release Bot <bot@example.com>')
    expect(await git(target, 'cat-file', 'commit', 'main')).toEndWith(`\n\nRelease v1.0.0\n\n${NOTES}`.trim())
    const tag = await git(target, 'cat-file', 'tag', 'v1.0.0')
    expect(tag).toContain(`object ${await git(target, 'rev-parse', 'main')}\ntype commit`)
    expect(tag).toContain('tagger Release Bot <bot@example.com>')
    expect(tag).toEndWith(`\n\n${NOTES}`.trim())
  })

  test("the operator's git config changes neither the committed bytes nor the tag", async () => {
    const crlf = 'a\r\nb\r\n'
    await release('v1.0.0', { 'src/a.txt': crlf })
    await Bun.write(join(source, 'attributes'), '* text eol=lf\n') // only in the export, so the source keeps CRLF
    const config = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'tag.gpgSign', GIT_CONFIG_VALUE_1: 'true' }
    Object.assign(process.env, config)
    try {
      expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--file', '.gitattributes=attributes', '--yes')).toBe(0)
    } finally {
      for (const key of Object.keys(config)) delete process.env[key]
    }
    expect(await Bun.$`git cat-file blob main:src/a.txt`.cwd(target).text()).toBe(crlf)
    expect(await git(target, 'cat-file', 'tag', 'v1.0.0')).not.toContain('SIGNATURE')
  })

  test('next export adds one commit on top and drops deleted files', async () => {
    await release('v1.0.0', { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' })
    expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--yes')).toBe(0)
    const first = await git(target, 'rev-parse', 'main')
    await release('v1.1.0', { 'src/a.ts': 'a2\n', 'src/b.ts': null })
    expect(await overshare('release', 'v1.1.0', '--notes', 'notes.md', '--yes')).toBe(0)
    expect(await git(target, 'rev-parse', 'main~1')).toBe(first)
    expect(await git(target, 'rev-list', '--count', 'main')).toBe('2')
    expect(await git(target, 'ls-tree', '-r', '--name-only', 'main')).toBe('src/a.ts')
    expect(await git(target, 'tag', '--list')).toBe('v1.0.0\nv1.1.0')
  })

  test('an export without changes aborts without a commit and cleans its temporary root', async () => {
    await release('v1.0.0', { 'src/a.ts': 'a\n' })
    expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--yes')).toBe(0)
    await release('v1.1.0', { 'other.txt': 'not exported\n' })
    const refs = await targetRefs()
    const before = await readdir(tmpdir())
    expect(await overshare('release', 'v1.1.0', '--notes', 'notes.md', '--yes')).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Nothing to export'))
    expect(await targetRefs()).toBe(refs)
    const after = await readdir(tmpdir())
    expect(after.filter((d) => d.startsWith('overshare-') && !d.startsWith('overshare-test-') && !before.includes(d))).toEqual([])
  })

  test('plan prints the changes and pushes nothing', async () => {
    await release('v1.0.0', { 'src/a.ts': 'a\n' })
    expect(await overshare('plan', 'v1.0.0')).toBe(0)
    expect(console.log).toHaveBeenCalledWith('  A src/a.ts')
    expect(await targetRefs()).toBe('')
  })

  test('declining the confirmation does nothing, --yes skips it', async () => {
    await release('v1.0.0', { 'src/a.ts': 'a\n' })
    const ask = spyOn(globalThis, 'prompt').mockReturnValue('n')
    try {
      expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md')).toBe(1)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(await targetRefs()).toBe('')
      expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--yes')).toBe(0)
      expect(ask).toHaveBeenCalledTimes(1)
    } finally {
      ask.mockRestore()
    }
  })

  test('a foreign commit in the target main between fetch and push aborts the push, tag included', async () => {
    await release('v1.0.0', { 'src/a.ts': 'a\n' })
    expect(await overshare('release', 'v1.0.0', '--notes', 'notes.md', '--yes')).toBe(0)
    await release('v1.1.0', { 'src/a.ts': 'a2\n' })
    const dir = await tempDir()
    await Bun.write(join(dir, 'src/a.ts'), 'a2\n')
    const index = await stage(targetUrl, await git(target, 'rev-parse', 'main'), dir, join(await tempDir(), 'index'))
    const clone = join(await tempDir(), 'clone')
    await git(source, 'clone', '--quiet', targetUrl, clone)
    await Bun.write(join(clone, 'manual.txt'), 'by hand\n')
    await git(clone, 'add', '--all')
    await git(clone, 'commit', '--quiet', '-m', 'manual')
    await git(clone, 'push', '--quiet', 'origin', 'main')
    const refs = await targetRefs()
    const identity = { name: 'Release Bot', email: 'bot@example.com' }
    await expect(publish(index, { targetUrl, identity, tag: 'v1.1.0', notes: NOTES })).rejects.toThrow(/git push failed/)
    expect(await targetRefs()).toBe(refs)
  })
})
