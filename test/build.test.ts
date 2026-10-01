import { describe, expect, test } from 'bun:test'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build, type BuildInput, decodePath, encodePath } from '../src/build'
import { main } from '../src/cli'
import { parseConfig } from '../src/config'
import { git, gitleaksPath, tempDir } from './helpers'

/** A source repo whose files are committed and tagged in one go. */
async function sourceRepo(files: Record<string, string | Uint8Array>, tag = 'v1.0.0'): Promise<string> {
  const repo = await tempDir()
  await git(repo, 'init', '--quiet', '-b', 'main')
  await commitFiles(repo, files, tag)
  return repo
}

async function commitFiles(repo: string, files: Record<string, string | Uint8Array>, tag: string) {
  for (const [path, content] of Object.entries(files)) await Bun.write(join(repo, path), content)
  await git(repo, 'add', '--all')
  await git(repo, 'commit', '--quiet', '-m', tag)
  await git(repo, 'tag', '-a', tag, '-m', tag)
}

const FILES = {
  'src/index.ts': 'export const url = "https://github.com/example-org/tool"\n',
  'README.md': 'internal\n',
  'docs/internal.md': 'secret plans\n',
  'oss/README.md': 'public\n',
  'oss/CONTRIBUTING.md': 'issues yes, PRs no\n',
}

async function run(repo: string, config: Record<string, unknown>, extra: Partial<BuildInput> = {}) {
  const dir = join(await tempDir(), 'export')
  const input = { sourceRepo: repo, tag: 'v1.0.0', files: [], ...extra }
  // include and overlay skip config validation, so the test sees that build itself treats them literally
  const parsed = parseConfig({ target: 'a/b', identity: 'R <r@x.y>', ...config, include: ['x'], overlay: undefined })
  const paths = { include: config.include as string[], overlay: config.overlay as string | undefined }
  const result = await build({ ...input, config: { ...parsed, ...paths } }, dir)
  const tree: Record<string, string> = {}
  for (const path of result.files) tree[path] = await Bun.file(Buffer.from(`${dir}/${encodePath(path).toString('latin1')}`, 'latin1')).text()
  return { result, tree, dir }
}

describe('build', () => {
  test('exports only the allowlist and the overlay, as in the tag', async () => {
    const repo = await sourceRepo(FILES)
    await Bun.write(join(repo, 'src/index.ts'), 'uncommitted\n')
    await Bun.write(join(repo, 'src/untracked.ts'), 'untracked\n')
    await Bun.write(join(repo, '.gitignore'), 'src/ignored.ts\n')
    await Bun.write(join(repo, 'src/ignored.ts'), 'ignored\n')
    await Bun.write(join(repo, 'oss/LOCAL.md'), 'working tree overlay\n')
    await git(repo, 'commit', '--quiet', '-am', 'after the tag')
    const { tree } = await run(repo, { include: ['src/', 'README.md'], overlay: 'oss/' })
    expect(tree).toEqual({
      'src/index.ts': FILES['src/index.ts'],
      'README.md': 'public\n',
      'CONTRIBUTING.md': 'issues yes, PRs no\n',
    })
  })

  test('include paths are literal and must exist', async () => {
    const repo = await sourceRepo(FILES)
    await expect(run(repo, { include: ['*.md'] })).rejects.toThrow(/git archive failed: .*\*\.md/)
    await expect(run(repo, { include: ['src/', 'missing.ts'] })).rejects.toThrow(/missing\.ts/)
  })

  test('--file wins over the committed overlay, which wins over the allowlist', async () => {
    const repo = await sourceRepo(FILES)
    const local = join(await tempDir(), 'README.operator.md')
    await Bun.write(local, 'operator\n')
    const files = [{ path: 'README.md', local }, { path: 'CHANGELOG.md', local }]
    const { tree, result } = await run(repo, { include: ['src/', 'README.md'], overlay: 'oss' }, { files })
    expect(tree['README.md']).toBe('operator\n')
    expect(tree['CHANGELOG.md']).toBe('operator\n')
    expect(result.shadowed).toEqual(['README.md'])
  })

  test('overlay and --file paths with "." segments name the same files', async () => {
    const repo = await sourceRepo({ ...FILES, 'a/oss/README.md': 'nested\n' })
    const local = join(await tempDir(), 'README.operator.md')
    await Bun.write(local, 'operator\n')
    for (const overlay of ['./oss/', 'oss/.', './/oss']) {
      const { tree, result } = await run(repo, { include: ['README.md'], overlay })
      expect([tree['README.md'], result.shadowed]).toEqual(['public\n', ['README.md']])
    }
    expect((await run(repo, { include: ['README.md'], overlay: 'a/./oss/' })).tree['README.md']).toBe('nested\n')
    const { tree, result } = await run(repo, { include: ['README.md'] }, { files: [{ path: './README.md', local }] })
    expect([tree, result.shadowed]).toEqual([{ 'README.md': 'operator\n' }, ['README.md']])
    await expect(run(repo, { include: ['README.md'], overlay: './' })).rejects.toThrow(/repo root/)
  })

  test('archived names keep newlines and survive long paths', async () => {
    const [pax, ustar] = [`${'d'.repeat(90)}/${'e'.repeat(90)}/${'f'.repeat(120)}.ts`, `${'g'.repeat(120)}/h.ts`]
    const repo = await sourceRepo({ ...FILES, 'src/a\nb.ts': 'github\n', 'oss/src/a\nb.ts': 'x\n', [`src/${pax}`]: 'y\n', [`src/${ustar}`]: 'z\n' })
    await commitFiles(repo, { 'src/a\nb.ts': 'changed\n' }, 'v1.1.0')
    const transforms = [{ files: 'src/**', replace: 'github', with: 'gitlab' }]
    const config = { include: ['src/'], overlay: 'oss', transforms }
    const { tree, result } = await run(repo, config, { tag: 'v1.1.0', lastExport: 'v1.0.0' })
    expect(Object.keys(tree).sort()).toEqual(['CONTRIBUTING.md', 'README.md', 'src/a\nb.ts', `src/${pax}`, `src/${ustar}`, 'src/index.ts'].sort())
    expect([result.shadowed, result.stale]).toEqual([['src/a\nb.ts'], ['src/a\nb.ts']])
  })

  test('archived names that are not UTF-8 keep their bytes', async () => {
    const ff = decodePath(Buffer.from([0x61, 0xff, 0x2e, 0x74, 0x73]))
    const pax = `${'d'.repeat(120)}/${ff}`
    const repo = await sourceRepo(FILES)
    for (const path of [`src/${ff}`, `oss/src/${ff}`, `src/${pax}`]) {
      const bytes = Buffer.from(`${repo}/${encodePath(path).toString('latin1')}`, 'latin1')
      await mkdir(bytes.subarray(0, bytes.lastIndexOf('/')), { recursive: true })
      await writeFile(bytes, 'github\n')
    }
    await commitFiles(repo, { 'README.md': 'changed\n' }, 'v1.0.1')
    await writeFile(Buffer.from(`${repo}/src/a\xff.ts`, 'latin1'), 'changed github\n')
    await commitFiles(repo, {}, 'v1.1.0')
    const transforms = [{ files: 'src/**', replace: 'github', with: 'gitlab' }]
    const config = { include: ['src/'], overlay: 'oss', transforms }
    const { tree, result } = await run(repo, config, { tag: 'v1.1.0', lastExport: 'v1.0.0' })
    expect(tree).toMatchObject({ [`src/${ff}`]: 'github\n', [`src/${pax}`]: 'gitlab\n' })
    expect([result.shadowed, result.stale]).toEqual([[`src/${ff}`], [`src/${ff}`]])
  })

  test('--file paths stay inside the export', async () => {
    const outside = await tempDir()
    const repo = await sourceRepo(FILES)
    await symlink(outside, join(repo, 'out'))
    await commitFiles(repo, {}, 'v1.1.0')
    const local = join(await tempDir(), 'published')
    await Bun.write(local, 'operator\n')
    const files = (path: string) => ({ tag: 'v1.1.0', files: [{ path, local }] })
    await expect(run(repo, { include: ['out'] }, files('out/published'))).rejects.toThrow(/goes through a symlink/)
    await expect(run(repo, { include: ['README.md'] }, files('../published'))).rejects.toThrow(/"\.\." segments/)
    await expect(run(repo, { include: ['README.md'] }, files('a/../README.md'))).rejects.toThrow(/"\.\." segments/)
    await expect(run(repo, { include: ['README.md'], overlay: 'oss/../oss' })).rejects.toThrow(/"\.\." segments/)
    expect(await readdir(outside)).toEqual([])
  })

  test('transforms apply to allowlisted files only and warn when they match nothing', async () => {
    const repo = await sourceRepo({ ...FILES, 'oss/src/extra.ts': 'github.com/example-org/x\n' })
    const transforms = [
      { files: 'src/**', replace: 'github\\.com/example-org/', with: 'github.com/aleslednej/' },
      { files: '**/*.md', replace: 'nowhere', with: 'x' },
    ]
    const { tree, result } = await run(repo, { include: ['src/', 'README.md'], overlay: 'oss', transforms })
    expect(tree['src/index.ts']).toBe('export const url = "https://github.com/aleslednej/tool"\n')
    expect(tree['src/extra.ts']).toBe('github.com/example-org/x\n')
    expect(result.warnings).toEqual(['Transform /nowhere/g on **/*.md matched nothing.'])
  })

  test('stale overlay is warned about, except on the first export', async () => {
    const repo = await sourceRepo(FILES, 'v1.0.0')
    await commitFiles(repo, { 'README.md': 'internal, changed\n', 'src/index.ts': 'changed\n' }, 'v1.1.0')
    const config = { include: ['src/', 'README.md'], overlay: 'oss' }
    expect((await run(repo, config, { tag: 'v1.1.0' })).result.stale).toEqual([])
    const { result } = await run(repo, config, { tag: 'v1.1.0', lastExport: 'v1.0.0' })
    expect(result.stale).toEqual(['README.md'])
    expect(result.warnings).toEqual(['Stale overlay: README.md changed in the source repo since v1.0.0.'])
  })

  test('reports binary files', async () => {
    const repo = await sourceRepo({ ...FILES, 'src/logo.png': new Uint8Array([137, 80, 78, 71, 0, 1]) })
    expect((await run(repo, { include: ['src/'] })).result.binary).toEqual(['src/logo.png'])
  })

  test('respects export-ignore in the allowlist and the overlay; aborts on export-subst', async () => {
    const attrs = 'src/skip.ts export-ignore\noss/SKIP.md export-ignore\n'
    const repo = await sourceRepo({ ...FILES, '.gitattributes': attrs, 'src/skip.ts': 'x\n', 'oss/SKIP.md': 'x\n' })
    const { tree } = await run(repo, { include: ['src/'], overlay: 'oss/' })
    expect(Object.keys(tree).sort()).toEqual(['CONTRIBUTING.md', 'README.md', 'src/index.ts'])

    await commitFiles(repo, { '.gitattributes': 'src/index.ts export-subst\n' }, 'v2.0.0')
    await expect(run(repo, { include: ['src/'] }, { tag: 'v2.0.0' })).rejects.toThrow(/export-subst .*src\/index\.ts/)
  })

  test('plan prints the export and removes its temporary root', async () => {
    const root = await tempDir()
    const [source, origin, target] = ['source', 'origin.git', 'target.git'].map((d) => join(root, d)) as [string, string, string]
    await git(root, 'init', '--quiet', '--bare', '-b', 'main', origin)
    await git(root, 'init', '--quiet', '--bare', '-b', 'main', target)
    await git(root, 'clone', '--quiet', `file://${origin}`, source)
    await git(source, 'checkout', '--quiet', '-B', 'main')
    const yaml = `target: file://${target}\nidentity: "R <r@x.y>"\ninclude: [src/, README.md]\noverlay: oss/\n`
    await commitFiles(source, { ...FILES, 'overshare.yaml': yaml }, 'v1.0.0')
    await git(source, 'push', '--quiet', 'origin', 'main', '--tags')
    const logs: string[] = []
    const log = console.log
    console.log = (line: string) => logs.push(line)
    const before = await readdir(Bun.env.TMPDIR ?? '/tmp')
    try {
      expect(await main(['plan', 'v1.0.0'], { cwd: source, path: await gitleaksPath() })).toBe(0)
    } finally {
      console.log = log
    }
    expect(logs.join('\n')).toContain('Export files (3):\n  CONTRIBUTING.md\n  README.md\n  src/index.ts\nReplaced by the overlay:\n  README.md')
    const after = await readdir(Bun.env.TMPDIR ?? '/tmp')
    expect(after.filter((d) => d.startsWith('overshare-') && !d.startsWith('overshare-test-') && !before.includes(d))).toEqual([])
  })
})
