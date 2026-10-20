import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { main, parseCli, preflight } from '../src/cli'
import { CONFIG, git, gitleaksPath, tempDir } from './helpers'

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
      command: 'release', ref: 'v1.0.0', notes: 'n.md', files: ['a=b', 'c=d'], yes: true,
    })
  })

  test('check takes any ref, or none', () => {
    expect(parseCli(['check', 'feature/x'])).toMatchObject({ command: 'check', ref: 'feature/x' })
    expect(parseCli(['check']).ref).toBeUndefined()
  })

  test.each([[[]], [['push']], [['check', 'a', 'b']], [['plan', 'v1.0.0', 'extra']], [['plan', '--bogus']]])('rejects %p', (argv) => {
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

describe('check', () => {
  // no git user, no origin, and a target that does not exist: check must reach none of them
  const config = `${CONFIG.replace(/^target: .*/, 'target: /nonexistent/target.git')}forbidden: [acme]\n`
  const commit = async (file: string) => {
    await Bun.write(join(cwd, 'src', 'a.ts'), file)
    await Bun.write(join(cwd, 'README.md'), '# Tool\n')
    await git(cwd, 'add', 'src', 'README.md')
    await git(cwd, 'commit', '--quiet', '-m', 'change')
  }
  beforeEach(async () => {
    await Bun.write(join(cwd, 'overshare.yaml'), config)
    await git(cwd, 'init', '--quiet', '-b', 'feature')
  })
  const check = (...argv: string[]) => main(['check', ...argv], { cwd, path })

  test('passes a clean ref that is neither a tag nor on main', async () => {
    await commit('export const a = 1\n')
    expect(await check()).toBe(0)
    expect(await check('feature', '--notes', 'notes.md')).toBe(0)
  })

  test('fails a ref with a forbidden pattern and lists the finding', async () => {
    await commit('// see the acme wiki\n')
    const sha = await git(cwd, 'rev-parse', 'HEAD')
    await commit('export const a = 1\n')
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await check(sha)).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('forbidden pattern /acme/i in src/a.ts'))
      expect(await check()).toBe(0)
    } finally {
      error.mockRestore()
    }
  })

  test('fails a ref that names no commit', async () => {
    await commit('export const a = 1\n')
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await check('nope')).toBe(1)
      expect(error).toHaveBeenCalledWith('nope is not a commit in the source repo.')
    } finally {
      error.mockRestore()
    }
  })
})
