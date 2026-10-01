import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nulSeparated, run } from './build'
import type { Config } from './config'
import { OvershareError } from './errors'

/** One line of the plan: a file added (A), modified (M), deleted (D) or changed in type (T) in the target repo. */
export type Change = { status: string; path: string }
/** A repo whose index holds the export exactly, over the target repo's `main` when it has one. */
export type Index = { repo: string; parent?: string; changes: Change[] }
export type Release = Pick<Config, 'targetUrl' | 'identity'> & { tag: string; notes: string }

/** Stages the export in `dir` into a fresh repo at `repo`; the changes are the plan against the target repo. */
export async function stage(targetUrl: string, mainSha: string | undefined, dir: string, repo: string): Promise<Index> {
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--quiet'])
  // the bytes that were checked are the bytes committed: no eol conversion, filter (LFS) or ident from any config
  await Bun.write(join(repo, '.git/info/attributes'), '* -text -filter -ident -working-tree-encoding\n')
  let parent: string | undefined
  if (mainSha) {
    await git(repo, ['fetch', '--quiet', '--no-tags', '--depth', '1', targetUrl, 'refs/heads/main'])
    parent = (await git(repo, ['rev-parse', 'FETCH_HEAD^{commit}'])).toString().trim()
    if (parent !== mainSha) throw new OvershareError(`main of ${targetUrl} moved while planning; run again.`)
  }
  // from an empty index, so deleted files are simply absent; --force so no .gitignore or excludes drop a file
  await git(repo, [`--work-tree=${dir}`, 'add', '--all', '--force'])
  // an unborn HEAD diffs against the empty tree
  const diff = await git(repo, ['diff', '--cached', '--no-renames', '--name-status', '-z', ...(parent ? [parent] : [])])
  const fields = nulSeparated(diff)
  const changes = []
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i]!, path: fields[i + 1]! })
  return { repo, parent, changes }
}

/** Commits the index as the release commit, tags it and pushes both atomically; never forces. */
export async function publish({ repo, parent }: Index, { targetUrl, identity, tag, notes }: Release): Promise<void> {
  const env = {
    TZ: 'UTC', // the operator's timezone stays private
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  }
  const tree = (await git(repo, ['write-tree'])).toString().trim()
  const message = Buffer.from(`Release ${tag}\n\n${notes}`)
  const commit = (await git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '--no-gpg-sign', '-F', '-'], message, env)).toString().trim()
  // verbatim keeps lines starting with "#", which the default cleanup would drop as comments
  await git(repo, ['tag', '-a', tag, commit, '--cleanup=verbatim', '--no-sign', '-F', '-'], Buffer.from(notes), env)
  await git(repo, ['push', '--quiet', '--atomic', targetUrl, `${commit}:refs/heads/main`, `refs/tags/${tag}`])
}

/** `y` or `yes`, in any case; anything else, including no answer, declines. */
export const confirmed = (answer: string | null) => /^y(es)?$/i.test(answer?.trim() ?? '')

/** Variables that would point git at another repo or carry the operator's dates into the release. */
const INHERITED = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|AUTHOR_DATE|COMMITTER_DATE)$/

function git(repo: string, args: string[], stdin?: Buffer, env: Record<string, string> = {}) {
  const inherited = Object.entries(process.env).filter(([key]) => !INHERITED.test(key))
  return run(repo, ['git', ...args], stdin, { ...Object.fromEntries(inherited), ...env })
}
