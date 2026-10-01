import { OvershareError } from './errors'

export type TargetState = { mainSha?: string; lastExport?: string; candidates: string[] }

/** Runs git in `cwd`; a failure is an abort carrying git's own message. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await Bun.$`git ${args}`.cwd(cwd).quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new OvershareError(`git ${args[0]} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)
  }
  return result.stdout.toString()
}

/** `vMAJOR.MINOR.PATCH` without pre-release or build metadata. */
export function parseReleaseTag(tag: string): bigint[] | undefined {
  const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)
  return m ? m.slice(1).map(BigInt) : undefined
}

/** Compares release tags by semver; components are bigints so no size loses precision. */
export function compareTags(a: string, b: string): number {
  const [x, y] = [parseReleaseTag(a)!, parseReleaseTag(b)!]
  const i = x.findIndex((c, j) => c !== y[j])
  return i < 0 ? 0 : x[i]! < y[i]! ? -1 : 1
}

/** Fetches the source repo's origin/main and reads the target repo, then works out the last export and candidates. */
export async function readTargetState(sourceRepo: string, targetUrl: string): Promise<TargetState> {
  const [, remote] = await Promise.all([
    git(sourceRepo, 'fetch', '--quiet', 'origin', 'main', '--tags'),
    git(sourceRepo, 'ls-remote', '--heads', '--tags', targetUrl),
  ])
  const refs = new Map(remote.split('\n').filter(Boolean).map((l) => l.split('\t').reverse() as [string, string]))
  const sourceTags = new Set((await git(sourceRepo, 'tag', '--list', 'v*')).split('\n'))
  const lastExport = [...refs.keys()]
    .map((ref) => ref.replace(/^refs\/tags\//, ''))
    .filter((tag) => parseReleaseTag(tag) && sourceTags.has(tag))
    .sort(compareTags)
    .at(-1)
  const contains = lastExport ? ['--contains', `refs/tags/${lastExport}`] : []
  const merged = await git(sourceRepo, 'tag', '--list', 'v*', '--merged', 'refs/remotes/origin/main', ...contains)
  const candidates = merged
    .split('\n')
    .filter((tag) => parseReleaseTag(tag) && (!lastExport || compareTags(tag, lastExport) > 0))
    .sort((a, b) => compareTags(b, a))
  return { mainSha: refs.get('refs/heads/main'), lastExport, candidates }
}

/** Validates a tag given on the command line against the candidates. */
export function validateTag(state: TargetState, tag: string): string {
  if (!parseReleaseTag(tag)) throw new OvershareError(`${tag} is not a release tag (expected vMAJOR.MINOR.PATCH).`)
  if (!state.candidates.includes(tag)) {
    const list = state.candidates.length ? state.candidates.join(', ') : 'none'
    throw new OvershareError(`Cannot export ${tag}: last export is ${state.lastExport ?? 'none'}, candidates: ${list}.`)
  }
  return tag
}

/** Picks a candidate by its 1-based number as listed by the interactive selection. */
export function pickCandidate(candidates: string[], answer: string | null): string {
  const n = Number(answer?.trim())
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
    throw new OvershareError(`Select a number from 1 to ${candidates.length}.`)
  }
  return candidates[n - 1]!
}
