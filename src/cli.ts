#!/usr/bin/env bun
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build, type BuildResult } from './build'
import { check } from './checks'
import { type Config, loadConfig } from './config'
import { OvershareError } from './errors'
import { confirmed, type Index, publish, stage } from './release'
import { pickCandidate, readTargetState, type TargetState, validateTag } from './tags'

const USAGE = 'Usage: overshare plan|release [tag] [--notes <file>] [--file <path>=<file>]... [--yes]'

export type Options = { command: 'plan' | 'release'; tag?: string; notes?: string; files: string[]; yes: boolean }
export type Preflight = { config: Config; gitleaks: string; notes?: string; files: { path: string; local: string }[] }
type Env = { cwd: string; path?: string }

export function parseCli(argv: string[]): Options {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        notes: { type: 'string' },
        file: { type: 'string', multiple: true },
        yes: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new OvershareError(`${(e as Error).message}\n${USAGE}`)
  }
  const [command, tag, ...rest] = parsed.positionals
  if ((command !== 'plan' && command !== 'release') || rest.length) throw new OvershareError(USAGE)
  const { notes, file = [], yes = false } = parsed.values
  return { command, tag, notes, files: file, yes }
}

/** Everything that can be checked locally, before any network access. */
export async function preflight(opts: Options, env: Env): Promise<Preflight> {
  const config = await loadConfig(resolve(env.cwd, 'overshare.yaml'))
  const gitleaks = Bun.which('gitleaks', { PATH: env.path ?? process.env.PATH ?? '' })
  if (!gitleaks) throw new OvershareError('gitleaks is not in PATH; install it before exporting.')
  const files = []
  for (const spec of opts.files) {
    const eq = spec.indexOf('=')
    const path = spec.slice(0, eq)
    const local = resolve(env.cwd, spec.slice(eq + 1))
    const segments = path.split('/')
    if (eq < 1 || eq === spec.length - 1) throw new OvershareError(`--file "${spec}" must have the form <path>=<file>.`)
    if (path.startsWith('/') || segments.some((s) => s === '..' || s.toLowerCase() === '.git')) {
      throw new OvershareError(`--file path "${path}" must be relative, without ".." or ".git" segments.`)
    }
    if (!(await Bun.file(local).exists())) throw new OvershareError(`--file ${path}: ${local} does not exist.`)
    files.push({ path, local })
  }
  if (opts.notes === undefined) {
    if (opts.command === 'release') throw new OvershareError('release requires --notes <file>.')
    return { config, gitleaks, files }
  }
  const notesFile = Bun.file(resolve(env.cwd, opts.notes))
  if (!(await notesFile.exists())) throw new OvershareError(`Release notes ${opts.notes} do not exist.`)
  const notes = await notesFile.text()
  if (!notes.trim()) throw new OvershareError(`Release notes ${opts.notes} are empty.`)
  return { config, gitleaks, notes, files }
}

function selectTag(state: TargetState): string {
  console.log(`Last export: ${state.lastExport ?? 'none'}`)
  if (!state.candidates.length) throw new OvershareError('No release tags on main are ready to export.')
  console.log('Release tags on main ready to export:')
  state.candidates.forEach((tag, i) => console.log(`  ${i + 1}) ${tag}`))
  return pickCandidate(state.candidates, prompt('Select tag:'))
}

function printBuild({ files, shadowed, binary, warnings }: BuildResult) {
  console.log(`Export files (${files.length}):`)
  for (const path of files) console.log(`  ${path}${binary.includes(path) ? ' (binary, content not checked)' : ''}`)
  if (shadowed.length) console.log(`Replaced by the overlay:\n${shadowed.map((p) => `  ${p}`).join('\n')}`)
  for (const warning of warnings) console.log(`Warning: ${warning}`)
}

function printPlan({ changes }: Index, targetUrl: string) {
  console.log(`Changes in ${targetUrl} (${changes.length}):`)
  for (const { status, path } of changes) console.log(`  ${status} ${path}`)
}

export async function main(argv: string[], env: Env = { cwd: process.cwd() }): Promise<number> {
  let root: string | undefined
  try {
    const opts = parseCli(argv)
    const { config, gitleaks, notes, files } = await preflight(opts, env)
    const state = await readTargetState(env.cwd, config.targetUrl)
    const tag = opts.tag === undefined ? selectTag(state) : validateTag(state, opts.tag)
    console.log(`Tag: ${tag}`)
    root = await mkdtemp(join(tmpdir(), 'overshare-'))
    const input = { sourceRepo: env.cwd, config, tag, lastExport: state.lastExport, files }
    const dir = join(root, 'export')
    const result = await build(input, dir)
    printBuild(result)
    await check({ config, gitleaks, dir, files: result.files, binary: result.binary, notes, scratch: join(root, 'checks') })
    console.log('Checks passed.')
    const index = await stage(config.targetUrl, state.mainSha, dir, join(root, 'index'))
    if (!index.changes.length) throw new OvershareError('Nothing to export: the target repo already has this content.')
    printPlan(index, config.targetUrl)
    if (opts.command === 'plan') return 0
    if (!opts.yes && !confirmed(prompt(`Export ${tag} to ${config.targetUrl}? [y/N]`))) {
      console.log('Nothing exported.')
      return 1
    }
    await publish(index, { ...config, tag, notes: notes! })
    console.log(`Exported ${tag} to ${config.targetUrl}.`)
    return 0
  } catch (e) {
    console.error(e instanceof OvershareError ? e.message : `Unexpected error: ${(e as Error).message}`)
    return 1
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
