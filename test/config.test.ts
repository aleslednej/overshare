import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig, parseConfig, resolveTarget } from '../src/config'
import { OvershareError } from '../src/errors'
import { CONFIG, tempDir } from './helpers'

const base = Bun.YAML.parse(CONFIG) as Record<string, unknown>
const invalid = (patch: Record<string, unknown>) => () => parseConfig({ ...base, ...patch })

describe('config', () => {
  test('parses and compiles a valid config', () => {
    const config = parseConfig({
      ...base,
      overlay: 'oss/',
      transforms: [{ files: 'package.json', replace: 'github\\.com/example-org/', with: 'github.com/aleslednej/' }],
      forbidden: ['acme'],
      denylistExceptions: ['**/.env.example'],
    })
    expect(config.targetUrl).toBe('https://github.com/aleslednej/my-tool.git')
    expect(config.identity).toEqual({ name: 'Release Bot', email: 'bot@example.com' })
    expect(config.include).toEqual(['src/', 'README.md'])
    expect(config.transforms[0]!.replace.flags).toBe('g')
    expect(config.forbidden[0]!.test('ACME')).toBe(true)
  })

  test('target owner/repo resolves to GitHub, anything else is kept', () => {
    expect(resolveTarget('a/b')).toBe('https://github.com/a/b.git')
    expect(resolveTarget('file:///tmp/t.git')).toBe('file:///tmp/t.git')
    expect(resolveTarget('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(resolveTarget('/tmp/target.git')).toBe('/tmp/target.git')
  })

  test.each([
    [{ target: undefined }, /target is required/],
    [{ identity: undefined }, /identity is required/],
    [{ identity: 'Release Bot' }, /Name <email>/],
    [{ identity: '<bot@example.com>' }, /Name <email>/],
    [{ include: [] }, /at least one path/],
    [{ include: undefined }, /at least one path/],
    [{ include: ['*.md'] }, /glob/],
    [{ include: ['src/../secret'] }, /"\.\." segment/],
    [{ include: [':(glob)src'] }, /pathspec magic/],
    [{ include: ['/etc/passwd'] }, /absolute path/],
    [{ overlay: '../oss' }, /"\.\." segment/],
    [{ forbidden: ['('] }, /forbidden\[0\] is not a valid regex/],
    [{ transforms: [{ files: 'a', replace: '[', with: '' }] }, /transforms\[0\]\.replace is not a valid regex/],
    [{ extra: 1 }, /unknown keys: extra/],
  ])('rejects %p', (patch, message) => {
    expect(invalid(patch)).toThrow(OvershareError)
    expect(invalid(patch)).toThrow(message)
  })

  test('rejects invalid YAML and a missing file', async () => {
    const dir = await tempDir()
    await Bun.write(join(dir, 'overshare.yaml'), 'target: [unclosed\n')
    await expect(loadConfig(join(dir, 'overshare.yaml'))).rejects.toThrow(/not valid YAML/)
    await expect(loadConfig(join(dir, 'missing.yaml'))).rejects.toThrow(/not found/)
  })
})
