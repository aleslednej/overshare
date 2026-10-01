import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseCli, preflight } from '../src/cli'
import { CONFIG, gitleaksPath, tempDir } from './helpers'

let cwd: string
let path: string
beforeEach(async () => {
  cwd = await tempDir()
  path = await gitleaksPath()
  await Bun.write(join(cwd, 'overshare.yaml'), CONFIG)
  await Bun.write(join(cwd, 'notes.md'), '# Notes\n')
  await Bun.write(join(cwd, 'README.oss.md'), 'public\n')
})
const run = (...argv: string[]) => preflight(parseCli(argv), { cwd, path })

describe('cli arguments', () => {
  test('parses command, tag and options', () => {
    expect(parseCli(['release', 'v1.0.0', '--notes', 'n.md', '--file', 'a=b', '--file', 'c=d', '--yes'])).toEqual({
      command: 'release', tag: 'v1.0.0', notes: 'n.md', files: ['a=b', 'c=d'], yes: true,
    })
  })

  test.each([[[]], [['push']], [['plan', 'v1.0.0', 'extra']], [['plan', '--bogus']]])('rejects %p', (argv) => {
    expect(() => parseCli(argv)).toThrow(/Usage/)
  })
})

describe('preflight', () => {
  test('loads config, notes and files', async () => {
    const result = await run('release', '--notes', 'notes.md', '--file', 'README.md=README.oss.md')
    expect(result.notes).toBe('# Notes\n')
    expect(result.files).toEqual([{ path: 'README.md', local: join(cwd, 'README.oss.md') }])
    expect(result.config.include).toEqual(['src/', 'README.md'])
  })

  test('plan passes without notes, release does not', async () => {
    expect((await run('plan')).notes).toBeUndefined()
    await expect(run('release')).rejects.toThrow(/requires --notes/)
  })

  test.each([
    ['/etc/README.md=README.oss.md', /must be relative/],
    ['docs/../README.md=README.oss.md', /must be relative/],
    ['.git/config=README.oss.md', /must be relative/],
    ['sub/.GIT/hooks=README.oss.md', /must be relative/],
    ['README.md', /<path>=<file>/],
    ['=README.oss.md', /<path>=<file>/],
    ['README.md=missing.md', /does not exist/],
  ])('rejects --file %s', async (spec, message) => {
    await expect(run('plan', '--file', spec)).rejects.toThrow(message)
  })

  test('rejects missing or empty notes', async () => {
    await expect(run('plan', '--notes', 'missing.md')).rejects.toThrow(/do not exist/)
    await Bun.write(join(cwd, 'empty.md'), ' \n\n')
    await expect(run('release', '--notes', 'empty.md')).rejects.toThrow(/are empty/)
  })

  test('rejects missing gitleaks and invalid config', async () => {
    await expect(preflight(parseCli(['plan']), { cwd, path: cwd })).rejects.toThrow(/gitleaks is not in PATH/)
    await Bun.write(join(cwd, 'overshare.yaml'), 'target: a/b\n')
    await expect(run('plan')).rejects.toThrow(/identity is required/)
  })
})
