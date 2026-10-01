import { afterEach } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A temporary directory removed after each test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'overshare-test-'))
  dirs.push(dir)
  return dir
}

/** A PATH holding a stub `gitleaks` that finds nothing, for tests that are not about secret scanning. */
export async function gitleaksPath(): Promise<string> {
  const bin = await tempDir()
  const stub = '#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != --report-path ]; do shift; done\necho [] > "$2"\n'
  await Bun.write(join(bin, 'gitleaks'), stub)
  await chmod(join(bin, 'gitleaks'), 0o755)
  return bin
}

export const CONFIG = `target: aleslednej/my-tool
identity: "Release Bot <bot@example.com>"
include:
  - src/
  - README.md
`

const GIT = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false']

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await Bun.$`git ${GIT} ${args}`.cwd(cwd).quiet()).stdout.toString().trim()
}

/** Commits a file change and optionally tags the commit (annotated, like real release tags). */
export async function commit(repo: string, tag?: string): Promise<void> {
  await Bun.write(join(repo, 'file.txt'), `${Math.random()}\n`)
  await git(repo, 'add', '--all')
  await git(repo, 'commit', '--quiet', '-m', tag ?? 'change')
  if (tag) await git(repo, 'tag', '-a', tag, '-m', tag)
}

/**
 * A source repo whose `origin` is a bare repo, plus an empty bare target repo, both with `main` as the
 * default branch regardless of `init.defaultBranch` and addressed by `file://` URL.
 */
export async function repos(): Promise<{ source: string; origin: string; targetUrl: string }> {
  const root = await tempDir()
  const [source, origin, target] = ['source', 'origin.git', 'target.git'].map((d) => join(root, d)) as [string, string, string]
  await git(root, 'init', '--quiet', '--bare', '-b', 'main', origin)
  await git(root, 'init', '--quiet', '--bare', '-b', 'main', target)
  await git(root, 'init', '--quiet', '-b', 'main', source)
  await git(source, 'remote', 'add', 'origin', `file://${origin}`)
  return { source, origin, targetUrl: `file://${target}` }
}
