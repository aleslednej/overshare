import { describe, expect, test } from 'bun:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { check } from '../src/checks'
import { parseConfig } from '../src/config'
import { gitleaksPath, tempDir } from './helpers'

// Assembled at run time: overshare exports itself, and a literal secret here would fail its own export.
const SECRET = `gh${'p'}_${'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG2hJ4'}`

type Opts = { config?: object; notes?: string; gitleaks?: string; links?: Record<string, string> }
async function run(tree: Record<string, string | Uint8Array>, opts: Opts = {}) {
  const dir = await tempDir()
  for (const [path, content] of Object.entries(tree)) await Bun.write(join(dir, path), content)
  for (const [path, target] of Object.entries(opts.links ?? {})) await symlink(target, join(dir, path))
  const gitleaks = opts.gitleaks ?? join(await gitleaksPath(), 'gitleaks')
  const config = parseConfig({ target: 'a/b', identity: 'R <r@x.y>', include: ['x'], ...opts.config })
  const files = [...Object.keys(tree), ...Object.keys(opts.links ?? {})].sort()
  const binary = files.filter((path) => typeof tree[path] !== 'string')
  return check({ config, gitleaks, dir, files, binary, notes: opts.notes, scratch: await tempDir() })
}

describe('denylist', () => {
  test('aborts listing every denylisted path, at the root and at any depth', async () => {
    const tree = { 'AGENTS.md': '', 'src/CLAUDE.md': '', '.env': '', 'a/b/.env.local': '', '.claude/settings.json': '', 'src/env.ts': '' }
    const error = await run(tree).catch((e) => e as Error)
    for (const path of ['AGENTS.md', 'src/CLAUDE.md', '.env', 'a/b/.env.local', '.claude/settings.json']) {
      expect(error.message).toContain(`denylisted: ${path}`)
    }
    expect(error.message).not.toContain('src/env.ts')
  })

  test('a file under a directory named like a denylisted file is denylisted too', async () => {
    const tree = { '.env.production/token.txt': '', 'AGENTS.md/a.txt': '', 'a/CLAUDE.md/b/c.txt': '' }
    const error = await run(tree).catch((e) => e as Error)
    for (const path of Object.keys(tree)) expect(error.message).toContain(`denylisted: ${path}`)
  })

  test('an exception lets a file through but not past the other checks', async () => {
    const config = { denylistExceptions: ['**/.env.example'], forbidden: ['acme'] }
    await run({ '.env.example': 'URL=\n' }, { config })
    await expect(run({ 'x/.env.example': 'URL=acme\n' }, { config })).rejects.toThrow(/forbidden pattern \/acme\/i in x\/\.env\.example$/)
  })
})

test('a symlink aborts', async () => {
  await expect(run({ 'a.txt': '' }, { links: { link: '/etc/passwd' } })).rejects.toThrow(/symlink: link/)
})

describe('forbidden patterns', () => {
  const config = { forbidden: ['acme'] }

  test.each([
    [{ 'src/a.ts': 'see ACME wiki\n' }, {}, 'in src/a.ts'],
    [{ 'docs/Acme.md': 'ok\n' }, {}, 'in path: docs/Acme.md'],
    [{ 'a.ts': 'ok\n' }, { notes: 'Moved off acme.\n' }, 'in release notes'],
    [{ 'a.ts': 'ok\n' }, { config: { ...config, identity: 'Bot <bot@Acme.com>' } }, 'in release identity'],
  ])('abort on a match, whatever the case (%p)', async (tree, opts, where) => {
    await expect(run(tree, { config, ...opts })).rejects.toThrow(`forbidden pattern /acme/i ${where}`)
  })

  test('binary files are skipped', async () => {
    await run({ 'logo.png': new Uint8Array([0, ...Buffer.from('acme')]) }, { config })
  })
})

// gitleaks has to be in PATH wherever the tests run, as it has to be wherever overshare runs
const real = Bun.which('gitleaks')
if (!real) throw new Error('gitleaks is not in PATH; the secret scanning tests need it.')
// each run compiles gitleaks' rules, most of a second
const SLOW = 20_000

describe('gitleaks', () => {

  test('passes a clean export', async () => {
    await run({ 'src/a.ts': 'export const a = 1\n' }, { gitleaks: real, notes: '# v1\n' })
  }, SLOW)

  test('finds a secret in the tree and in the release notes', async () => {
    const notes = `Token: ${SECRET}\n`
    const error = await run({ 'src/a.ts': `const t = "${SECRET}"\n` }, { gitleaks: real, notes }).catch((e) => e as Error)
    expect(error.message).toContain('secret (github-pat) in src/a.ts:1')
    expect(error.message).toContain('secret (github-pat) in release notes:1')
  }, SLOW)

  test('the export cannot switch the scan off', async () => {
    const tree = {
      'src/a.ts': `const t = "${SECRET}" // gitleaks:allow\n`,
      '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
      '.gitleaksignore': 'src/a.ts:github-pat:1\n./src/a.ts:github-pat:1\n',
    }
    process.env.GITLEAKS_CONFIG_TOML = '[allowlist]\npaths = [".*"]\n'
    try {
      await expect(run(tree, { gitleaks: real })).rejects.toThrow('secret (github-pat) in src/a.ts:1')
    } finally {
      delete process.env.GITLEAKS_CONFIG_TOML
    }
  }, SLOW)

  test('no file is skipped by its path or its first bytes', async () => {
    const paths = ['package-lock.json', 'pnpm-lock.yaml', 'docs/gitleaks.toml', 'node_modules/a/index.js', 'logo.svg']
    const tree: Record<string, string> = Object.fromEntries(paths.map((path) => [path, `token = "${SECRET}"\n`]))
    tree['deploy.txt'] = `%PDF-1.4\ntoken = "${SECRET}"\n`
    const error = await run(tree, { gitleaks: real }).catch((e) => e as Error)
    for (const path of paths) expect(error.message).toContain(`secret (github-pat) in ${path}:1`)
    expect(error.message).toContain('secret (github-pat) in deploy.txt:2')
  }, SLOW)
})
